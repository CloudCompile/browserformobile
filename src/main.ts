import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { AnimeCache, type CachePersistence } from './animeCache';
import { setAnimeCache } from './animeApi';
import { DownloadManager, type DownloaderOptions } from './downloader';
import { DownloadModal, type DownloadModalOptions } from './downloadModal';
import { repairFolder } from './doctor';
import { externalStorageAvailable } from './destination';
import { VideoLibrary, type LibraryItem, type WatchRecord } from './library';
import { LibraryModal } from './libraryModal';
import { PlayerModal } from './playerModal';
import { DEFAULT_SETTINGS, AnimeSettingTab, type AnimeSettings } from './settings';
import { StatsStore, type DownloadRun } from './stats';
import { StatsModal } from './statsModal';
import { SeriesPickerModal } from './modals';
import { DetailsModal } from './detailsModal';
import { applyModelScores, collectRecommendations, deriveSeeds } from './recommendService';
import { JevRanker, TinyDecideRanker, type DecisionDeps } from './decision';
import type { Recommendation } from './recommend';
import { requestUrl } from 'obsidian';
import { DownloadManagerView, VIEW_TYPE_DOWNLOADS } from './downloadManagerView';

interface PersistedShape {
	settings?: Partial<AnimeSettings>;
	/** Watch progress per vault path, so the library survives a reload. */
	watch?: Record<string, WatchRecord>;
	/** The download statistics log. */
	stats?: DownloadRun[];
	/** Cached anime API responses, so a restart does not re-fetch the catalogue. */
	animeCache?: unknown;
	/** Last-seen state of every downloaded file, for the download manager. */
	downloadScanCache?: Record<string, unknown>;
}

export default class AnimePlugin extends Plugin {
	settings!: AnimeSettings;
	downloader!: DownloadManager;
	library!: VideoLibrary;
	stats!: StatsStore;
	animeCache!: AnimeCache;

	private downloadModal: DownloadModal | null = null;
	private libraryModal: LibraryModal | null = null;
	private playerModal: PlayerModal | null = null;
	private statsModal: StatsModal | null = null;
	private detailsModal: DetailsModal | null = null;
	/** Re-ranks recommendations with a decision model, when one is enabled. */
	private localRanker: TinyDecideRanker | null = null;
	private hostedRanker: JevRanker | null = null;
	private watchRecords: Record<string, WatchRecord> = {};
	/** The run log as loaded, handed to the stats store in onload. */
	private statsRuns: DownloadRun[] = [];
	/** Cached API responses as loaded, handed to the anime cache in onload. */
	private animeCacheRecords: unknown = null;
	/**
	 * Last-seen state of every downloaded file, keyed by path.
	 *
	 * The download manager keeps this so it can show which files need a duration
	 * repair without re-reading each one on every open. It lives on the plugin
	 * rather than in the view because `saveSettings` writes the whole data file and
	 * would otherwise drop it.
	 */
	downloadScanCache: Record<string, unknown> = {};

	async onload(): Promise<void> {
		await this.loadSettings();

		this.library = new VideoLibrary();
		this.library.load(this.watchRecords);

		this.stats = new StatsStore();
		this.stats.load(this.statsRuns);

		this.animeCache = new AnimeCache(this.animeCachePersistence());
		this.animeCache.load(this.animeCacheRecords);
		this.applyAnimeCacheSetting();

		this.downloader = new DownloadManager(
			this.app,
			this.downloaderOptions(),
			() => {
				this.downloadModal?.refresh();
			},
			(run) => {
				void this.recordRun(run);
			},
		);

		this.registerView(VIEW_TYPE_DOWNLOADS, (leaf: WorkspaceLeaf) => new DownloadManagerView(leaf, this));

		this.addRibbonIcon('download', 'Download anime', () => {
			this.openDownloader();
		});

		this.addRibbonIcon('film', 'Video library', () => {
			this.openLibrary();
		});

		this.addRibbonIcon('hard-drive', 'Download manager', () => {
			void this.activateDownloadManager();
		});

		this.addRibbonIcon('bar-chart-2', 'Download statistics', () => {
			this.openStats();
		});

		this.registerCommands();
		this.applyGlassSetting();
		this.addSettingTab(new AnimeSettingTab(this.app, this));

		this.registerDomEvent(window, 'beforeunload', () => {
			this.animeCache.dispose();
		});
	}

	/**
	 * Install or remove the API cache. Passing null makes every request go
	 * straight to the network, which is what the setting disables.
	 */
	applyAnimeCacheSetting(): void {
		setAnimeCache(this.settings.animeCacheEnabled ? this.animeCache : null);
	}

	/**
	 * The anime cache persists through the same `saveData` call as everything
	 * else, merged rather than overwritten so a cache write cannot drop settings.
	 */
	private animeCachePersistence(): CachePersistence {
		return {
			saveData: async (data) => {
				this.animeCacheRecords = data;
				await this.saveSettings();
			},
		};
	}

	onunload(): void {
		this.animeCache.dispose();
		this.downloader.dispose();
		this.playerModal?.close();
		this.statsModal?.close();
	}

	/**
	 * The folder the library scans. External downloads live outside the vault,
	 * where the vault adapter cannot enumerate them, so only the in-vault folder
	 * is indexed and the modal says so.
	 */
	private libraryFolder(): string {
		return this.settings.downloadFolder;
	}

	private externalLibraryHint(): string {
		if (!this.settings.downloadExternal || !externalStorageAvailable()) return '';
		return 'Downloads saved outside the vault are not listed here. Only videos inside your vault appear in the library.';
	}

	/**
	 * Open the video library, re-scanning the folder first so a file added
	 * outside the plugin still shows up.
	 */
	openLibrary(): void {
		if (this.libraryModal) {
			this.libraryModal.close();
			this.libraryModal = null;
		}
		const modal = new LibraryModal(this.app, this.library, {
			onPlay: (item) => this.playItem(item),
			onDelete: (item) => this.deleteItem(item),
			onRefresh: () => this.refreshLibrary(),
			onDetails: (series) => this.openDetails(series),
			onClosed: () => {
				this.libraryModal = null;
			},
			emptyHint: this.externalLibraryHint(),
		});
		this.libraryModal = modal;
		modal.open();
		void modal.refresh();
	}

	/**
	 * Drop every cached API response. Useful after a title's metadata is corrected
	 * upstream, or when a cached stream URL has gone stale and downloads fail.
	 */
	clearAnimeCache(): void {
		this.animeCache.clear();
		void this.animeCache.flush();
		new Notice('Anime cache cleared.');
	}

	/** Open the download statistics page. */
	openStats(): void {
		if (this.statsModal) {
			this.statsModal.close();
			this.statsModal = null;
		}
		const modal = new StatsModal(this.app, this.stats, {
			onClear: async () => {
				this.stats.clear();
				await this.saveSettings();
			},
			onClosed: () => {
				this.statsModal = null;
			},
		});
		this.statsModal = modal;
		modal.open();
	}

	/**
	 * Open the full details page for a series.
	 *
	 * Recommendations are produced lazily by the modal, so the page shows the
	 * details first and fills the recommendation list in when it is ready.
	 */
	openDetails(series: string): void {
		const name = (series ?? '').trim();
		if (!name) return;
		if (this.detailsModal) {
			this.detailsModal.close();
			this.detailsModal = null;
		}
		const modal = new DetailsModal(
			this.app,
			{
				series: name,
				apiBase: this.settings.animeApiBase,
				loadRecommendations: (seed) => this.recommendFor(seed),
			},
			{
				onDownload: () => this.openDownloader(),
				onOpenRecommendation: (title) => this.openDetails(title),
				onClosed: () => {
					this.detailsModal = null;
				},
			},
		);
		this.detailsModal = modal;
		modal.open();
	}

	/** Every series name the plugin knows the user has downloaded. */
	private ownedSeries(): string[] {
		const names = new Set<string>();
		for (const run of this.stats.toJSON()) {
			if (run.series) names.add(run.series);
		}
		for (const entry of this.library.entries) {
			if (entry.series) names.add(entry.series);
		}
		return [...names];
	}

	/**
	 * Recommendations for a series, blended with the whole download history.
	 *
	 * The series being viewed is added to the profile at a high weight so its own
	 * catalogue list leads, while the rest of the history supplies the text
	 * signal that orders the results.
	 */
	private async recommendFor(seed: string): Promise<Recommendation[]> {
		const history = deriveSeeds(
			this.stats.toJSON(),
			this.library.items().map((item) => ({
				series: item.series,
				watched: item.watched,
				progress: item.progress?.position ?? 0,
			})),
		);
		const others = history.filter((entry) => entry.series.toLowerCase() !== seed.toLowerCase());
		const top = Math.max(1, ...others.map((entry) => entry.weight));
		const seeds = [{ series: seed, weight: top + 1 }, ...others];
		const owned = this.ownedSeries();

		const result = await collectRecommendations(this.settings.animeApiBase, seeds, {
			alreadyHave: owned,
			limit: 12,
		});
		if (result.items.length === 0) return result.items;

		const scores = await this.scoreWithModel(seed, result.items);
		if (scores.size === 0) return result.items;
		return applyModelScores(result.items, scores);
	}

	/**
	 * Ask the configured decision model to re-rank the candidates.
	 *
	 * Returns an empty map when no model is enabled or it fails, which leaves the
	 * vote-based ordering untouched.
	 */
	private async scoreWithModel(seed: string, items: Recommendation[]): Promise<Map<string, number>> {
		const titles = items.map((item) => item.title);
		if (titles.length === 0) return new Map();
		const profile = `${seed}. ${this.ownedSeries().slice(0, 12).join(', ')}.`;

		if (this.settings.recommendationModel === 'hosted') {
			if (!this.settings.jevApiKey) return new Map();
			this.hostedRanker ??= new JevRanker(this.decisionDeps());
			return this.hostedRanker.score(profile, titles, this.settings.jevApiKey);
		}
		if (this.settings.recommendationModel === 'local') {
			this.localRanker ??= new TinyDecideRanker(this.decisionDeps());
			if (!(await this.localRanker.ensureLoaded())) {
				new Notice('Could not load the local decision model; using the catalogue ranking.');
				return new Map();
			}
			return this.localRanker.score(profile, titles);
		}
		return new Map();
	}

	/**
	 * Model cache and network access.
	 *
	 * The weights are cached next to the plugin so the 6 MB download happens once.
	 * `requestUrl` is used rather than `fetch` because it is the native client
	 * Obsidian exposes to plugins, which is not bound by same-origin rules.
	 */
	private decisionDeps(): DecisionDeps {
		const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		const modelPath = `${dir}/tinydecide-model.bin`;
		const metaPath = `${dir}/tinydecide-meta.json`;
		const adapter = this.app.vault.adapter;
		const readBinary = async (path: string): Promise<ArrayBuffer | null> => {
			try {
				if (!(await adapter.exists(path))) return null;
				return await adapter.readBinary(path);
			} catch {
				return null;
			}
		};
		return {
			readModel: () => readBinary(modelPath),
			writeModel: async (data) => {
				try {
					await adapter.writeBinary(modelPath, data);
				} catch {
					/* A read-only vault just means it is fetched again next time. */
				}
			},
			readMeta: () => readBinary(metaPath),
			writeMeta: async (data) => {
				try {
					await adapter.writeBinary(metaPath, data);
				} catch {
					/* See above. */
				}
			},
			download: async (url) => {
				const response = await requestUrl({ url, method: 'GET', throw: false });
				if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
				return response.arrayBuffer;
			},
			postJson: async (url, body, headers) => {
				const response = await requestUrl({
					url,
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...headers },
					body: JSON.stringify(body),
					throw: false,
				});
				if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
				return response.json as unknown;
			},
		};
	}

	/** Drop loaded model weights, e.g. when the setting is switched off. */
	applyRecommendationModelSetting(): void {
		if (this.settings.recommendationModel !== 'local') this.localRanker?.unload();
	}

	/**
	 * Toggle the glass effect class on the document body.
	 *
	 * The CSS is scoped to `body.bfm-glass-on`, so switching the setting off
	 * removes the effect without a reload and without touching the modal code.
	 */
	applyGlassSetting(): void {
		document.body.toggleClass('bfm-glass-on', this.settings.glassEffect);
	}

	/** Append a finished run to the log and persist it. */
	private async recordRun(run: DownloadRun): Promise<void> {
		this.stats.record(run);
		await this.saveSettings();
	}

	/**
	 * Re-scan the download folder and drop progress for files that are gone.
	 *
	 * Returns whether the walk was complete. `prune` already refuses to act on an
	 * incomplete scan, but callers that keep their own per-file state (the scan
	 * cache) need the flag too.
	 */
	async refreshLibrary(): Promise<{ complete: boolean }> {
		const adapter = this.app.vault.adapter as unknown as {
			list(path: string): Promise<{ files: string[]; folders: string[] }>;
			exists(path: string): Promise<boolean>;
			stat(path: string): Promise<{ size: number; mtime: number } | null>;
		};
		const result = await this.library.refresh(
			adapter,
			this.libraryFolder(),
			this.settings.downloadFilenameTemplate,
		);
		this.library.prune();
		return result;
	}

	/** Play an entry, resuming from its saved position. */
	playItem(item: LibraryItem): void {
		if (this.playerModal) {
			this.playerModal.close();
			this.playerModal = null;
		}
		let source: string;
		try {
			source = this.app.vault.adapter.getResourcePath(item.path);
		} catch {
			new Notice('This file is outside the vault and cannot be played.');
			return;
		}
		const modal = new PlayerModal(this.app, item, source, this.library.getProgress(item.path), {
			onProgress: (path, position, duration) => this.recordProgress(path, position, duration),
			onReset: (path) => {
				this.library.clearProgress(path);
				void this.saveWatchRecords();
			},
			onClosed: () => {
				this.playerModal = null;
			},
		});
		this.playerModal = modal;
		modal.open();
	}

	private recordProgress(path: string, position: number, duration: number): void {
		this.library.record(path, position, duration);
		void this.saveWatchRecords();
	}

	async deleteItem(item: LibraryItem): Promise<void> {
		const adapter = this.app.vault.adapter as unknown as {
			remove(path: string): Promise<void>;
		};
		await adapter.remove(item.path);
		this.library.clearProgress(item.path);
		await this.saveWatchRecords();
	}

	/** Persist the watch map alongside the browser data. */
	private async saveWatchRecords(): Promise<void> {
		this.watchRecords = this.library.toJSON();
		await this.saveSettings();
	}

	/** Snapshot the persisted settings in the shape the download manager wants. */
	downloaderOptions(): DownloaderOptions {
		return {
			apiBase: this.settings.animeApiBase,
			quality: this.settings.downloadQuality,
			format: this.settings.downloadFormat,
			segmentConcurrency: this.settings.downloadSegmentConcurrency,
			maxConcurrentJobs: this.settings.downloadMaxConcurrentJobs,
			filenameTemplate: this.settings.downloadFilenameTemplate,
			destination: {
				external: this.settings.downloadExternal,
				folder: this.settings.downloadFolder,
			},
		};
	}

	openDownloader(): void {
		if (this.downloadModal) {
			this.downloadModal.close();
			this.downloadModal = null;
		}
		const modal = new DownloadModal(
			this.app,
			this.downloader,
			{
				apiBase: this.settings.animeApiBase,
				quality: this.settings.downloadQuality,
				format: this.settings.downloadFormat,
				folder: this.settings.downloadFolder,
				external: this.settings.downloadExternal,
				filenameTemplate: this.settings.downloadFilenameTemplate,
				segmentConcurrency: this.settings.downloadSegmentConcurrency,
				maxConcurrentJobs: this.settings.downloadMaxConcurrentJobs,
				confirmDestructiveActions: this.settings.confirmDestructiveActions,
			},
			{
				onOptionsChanged: (patch) => {
					void this.applyDownloadOptions(patch);
				},
				onClosed: () => {
					this.downloadModal = null;
				},
			},
		);
		this.downloadModal = modal;
		modal.open();
	}

	/** Persist options changed from the download modal and refresh the manager. */
	private async applyDownloadOptions(patch: Partial<DownloadModalOptions>): Promise<void> {
		if (patch.quality !== undefined) this.settings.downloadQuality = patch.quality;
		if (patch.format !== undefined) this.settings.downloadFormat = patch.format;
		if (patch.apiBase !== undefined) this.settings.animeApiBase = patch.apiBase;
		if (patch.segmentConcurrency !== undefined) {
			this.settings.downloadSegmentConcurrency = patch.segmentConcurrency;
		}
		if (patch.maxConcurrentJobs !== undefined) {
			this.settings.downloadMaxConcurrentJobs = patch.maxConcurrentJobs;
		}
		if (patch.filenameTemplate !== undefined) {
			this.settings.downloadFilenameTemplate = patch.filenameTemplate;
		}
		if (patch.folder !== undefined) this.settings.downloadFolder = patch.folder;
		if (patch.external !== undefined) this.settings.downloadExternal = patch.external;
		await this.saveSettings();
		this.downloader.setOptions(this.downloaderOptions());
	}

	private registerCommands(): void {
















		this.addCommand({
			id: 'open-anime-details',
			name: 'Anime: open details page',
			callback: () => {
				const series = this.ownedSeries();
				if (series.length === 0) {
					new Notice('No downloaded series yet.');
					return;
				}
				new SeriesPickerModal(this.app, series, (picked) => this.openDetails(picked)).open();
			},
		});
		this.addCommand({
			id: 'clear-anime-cache',
			name: 'Clear anime cache',
			callback: () => {
				this.clearAnimeCache();
			},
		});

		this.addCommand({
			id: 'open-anime-downloader',
			name: 'Open anime downloader',
			callback: () => {
				this.openDownloader();
			},
		});

		this.addCommand({
			id: 'repair-anime-downloads',
			name: 'Repair downloaded videos',
			callback: () => {
				void this.repairDownloads();
			},
		});

		this.addCommand({
			id: 'open-video-library',
			name: 'Open video library',
			callback: () => {
				this.openLibrary();
			},
		});

		this.addCommand({
			id: 'open-download-manager',
			name: 'Open download manager',
			callback: () => {
				void this.activateDownloadManager();
			},
		});

		this.addCommand({
			id: 'open-download-stats',
			name: 'Open download statistics',
			callback: () => {
				this.openStats();
			},
		});
	}

	/**
	 * Rewrite the duration of previously downloaded MP4s. Files made before
	 * 1.1.1 report the same length in players that read the track headers
	 * (Samsung Gallery), because mux.js left the duration at its sentinel.
	 * The real length is still in the file, so it can be repaired in place.
	 */
	private async repairDownloads(): Promise<void> {
		const folder = this.settings.downloadExternal ? '' : this.settings.downloadFolder;
		const adapter = this.app.vault.adapter as unknown as {
			readBinary(path: string): Promise<ArrayBuffer>;
			writeBinary(path: string, data: ArrayBuffer): Promise<void>;
			list(path: string): Promise<{ files: string[]; folders: string[] }>;
			exists(path: string): Promise<boolean>;
		};
		const notice = new Notice('Checking downloaded videos…', 0);
		try {
			const result = await repairFolder(adapter, folder);
			notice.hide();
			if (result.scanned === 0) {
				new Notice('No downloaded videos were found.');
				return;
			}
			const seconds = result.fixed.reduce((sum, entry) => sum + entry.durationSeconds, 0);
			const parts = [
				`${result.scanned} checked`,
				result.repaired > 0 ? `${result.repaired} repaired` : 'none needed repair',
			];
			if (result.repaired > 0) parts.push(`${Math.round(seconds / 60)} minutes of video fixed`);
			if (result.failed.length > 0) {
				// A count alone is not diagnosable; the first reason names the
				// cause (an unreadable path, a permissions error).
				parts.push(`${result.failed.length} failed: ${result.failed[0]?.message ?? 'unknown error'}`);
			}
			new Notice(parts.join(' · '));
		} catch (error) {
			notice.hide();
			new Notice(error instanceof Error ? error.message : 'The repair could not be completed.');
		}
	}

	async activateDownloadManager(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DOWNLOADS);
		const first = existing[0];
		if (first) {
			await this.app.workspace.revealLeaf(first);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_DOWNLOADS, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}


	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as PersistedShape | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings ?? {});
		this.statsRuns = Array.isArray(raw?.stats) ? raw.stats : [];
		this.watchRecords = raw?.watch ?? {};
		this.animeCacheRecords = raw?.animeCache ?? null;
		this.downloadScanCache = raw?.downloadScanCache ?? {};
	}

	async saveSettings(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			downloadScanCache: this.downloadScanCache,
			watch: this.watchRecords,
			stats: this.stats.toJSON(),
			animeCache: this.animeCacheRecords,
		});
	}

}

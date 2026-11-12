import { Notice, Platform, Plugin, WorkspaceLeaf } from 'obsidian';
import { AnimeCache, type CachePersistence } from './animeCache';
import { setAnimeCache } from './animeApi';
import {
        DownloadManager,
        seriesFolderName,
        withSeriesPreference,
        type DownloaderOptions,
        type PersistedDownloadJob,
        type SeriesPreferenceMap,
} from './downloader';
import { DownloadModal, type DownloadModalOptions } from './downloadModal';
import { repairByteBudget, repairFolder, RepairLedger } from './doctor';
import { externalStorageAvailable, sanitizePath } from './destination';
import { VideoLibrary, watchFraction, type LibraryItem, type WatchRecord } from './library';
import { LibraryModal } from './libraryModal';
import { PlayerModal } from './playerModal';
import { DEFAULT_FILENAME_TEMPLATE, DEFAULT_SETTINGS, AnimeSettingTab, type AnimeSettings } from './settings';
import { StatsStore, buildStatsCsv, parseDataExport, type DataExport, type DownloadRun } from './stats';
import { StatsModal } from './statsModal';
import { ConfirmModal, SeriesPickerModal } from './modals';
import { FindModal, type PersistedFinderState } from './findModal';
import { DetailsModal } from './detailsModal';
import { DebugLogger } from './debug';
import { applyModelScores, collectRecommendations, deriveSeeds } from './recommendService';
import { RecommendationsModal, type RecommendationsResult } from './recommendationsModal';
import { JevRanker, TinyDecideRanker, type DecisionDeps } from './decision';
import {
        createAnimeApiTool,
        createWebSearchTool,
        curateWithModel,
        describeCatalogueEntry,
        findLocalModel,
        gatherCatalogueNotes,
        LlmClient,
        modelDownloadUrl,
        type CuratorTool,
} from './llm';
import { curateInProcess, WllamaRuntime, type LocalRuntime } from './llmLocal';
import { loadPreview, collectPosters, searchSeries, type SeriesSummary } from './animeApi';
import {
	isDismissed,
	pushDismissed,
	type Recommendation,
	type TasteSeed,
} from './recommend';
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
	/** Files a repair pass already cleared, keyed by path. */
	repairLedger?: Record<string, string>;
	/** Queued and paused downloads to restore after a restart. */
	downloadQueue?: PersistedDownloadJob[];
	/** Per-series format/quality overrides recorded by the picker. */
	seriesPreferences?: SeriesPreferenceMap;
	/** Where the finder was left, so it reopens on the same listing. */
	finderState?: PersistedFinderState;
	/** The library's layout, remembered between sessions. */
	libraryView?: 'list' | 'grid';
	/** Recommendation titles the user said they are not interested in. */
	dismissedRecommendations?: string[];
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
	private recommendationsModal: RecommendationsModal | null = null;
	private findModal: FindModal | null = null;
	/** Re-ranks recommendations with a decision model, when one is enabled. */
	private localRanker: TinyDecideRanker | null = null;
	private hostedRanker: JevRanker | null = null;
	/** The in-process curator runtime, created on first use. */
	private llmRuntime: LocalRuntime | null = null;
	private watchRecords: Record<string, WatchRecord> = {};
	/** The run log as loaded, handed to the stats store in onload. */
	private statsRuns: DownloadRun[] = [];
	/** Cached API responses as loaded, handed to the anime cache in onload. */
	private animeCacheRecords: unknown = null;
	private downloadQueue: PersistedDownloadJob[] = [];
	private queueSaveTimer: number | null = null;
	/** Per-series format/quality overrides, keyed by series title. */
	seriesPreferences: SeriesPreferenceMap = {};
	/** Where the finder was left, so it reopens on the same listing. */
	finderState: PersistedFinderState | null = null;
	private finderSaveTimer: number | null = null;
	private debugLogger!: DebugLogger;
	/** The library layout, persisted so the grid is still the grid next time. */
	libraryView: 'list' | 'grid' = 'list';
	/**
	 * Recommendation titles the user dismissed, capped — see `pushDismissed`.
	 * A dismissal is a filter over the ranked list, so restoring the list is
	 * clearing this array; nothing is re-fetched to bring titles back.
	 */
	dismissedRecommendations: string[] = [];

	private debugLogPath(): string {
		return `${this.app.vault.configDir}/plugins/browser-for-mobile/debug.log`;
	}

	debug(message: string, details?: unknown): void {
		this.debugLogger?.log(message, details);
	}

	debugMachineInfo(): void {
		this.debugLogger?.logMachineInfo();
	}
	/**
	 * Last-seen state of every downloaded file, keyed by path.
	 *
	 * The download manager keeps this so it can show which files need a duration
	 * repair without re-reading each one on every open. It lives on the plugin
	 * rather than in the view because `saveSettings` writes the whole data file and
	 * would otherwise drop it.
	 */
	downloadScanCache: Record<string, unknown> = {};
	/**
	 * Files a repair pass already cleared, keyed by path.
	 *
	 * A repair reads a file whole, so re-scanning a folder of episodes re-reads
	 * the whole collection every time to confirm what a previous pass already
	 * proved. This records the size and mtime a pass left behind, so the next
	 * pass trusts an unchanged file and reads nothing.
	 */
	repairLedger = new RepairLedger();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.debugLogger = new DebugLogger(
			this.app.vault.adapter,
			this.debugLogPath(),
			() => this.settings.debugMode,
		);
		this.debug('plugin.onload');
		this.debugLogger.logMachineInfo();
		this.debug('settings.runtime', {
			format: this.settings.downloadFormat,
			quality: this.settings.downloadQuality,
			segmentConcurrency: this.settings.downloadSegmentConcurrency,
			maxConcurrentJobs: this.settings.downloadMaxConcurrentJobs,
			externalStorage: this.settings.downloadExternal,
			recommendationModel: this.settings.recommendationModel,
			llmProvider: this.settings.llmProvider,
		});

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
			(jobs) => {
				this.downloadQueue = jobs;
				if (this.queueSaveTimer !== null) window.clearTimeout(this.queueSaveTimer);
				this.queueSaveTimer = window.setTimeout(() => {
					this.queueSaveTimer = null;
					void this.saveSettings();
				}, 500);
			},
			(message, details) => this.debug(message, details),
		);
		this.downloader.restoreQueue(this.downloadQueue);
		if (this.settings.autoResumeOnLaunch) {
			// A convenience must never break or block startup: any failure is
			// logged and the queue waits in the state the restart left it.
			void this.downloader.autoResumeRestored().then(
				(revived) => {
					if (revived > 0) this.debug('queue.auto-resume', { revived });
				},
				(error) => {
					this.debug('queue.auto-resume.failed', {
						error: error instanceof Error ? error.message : String(error),
					});
				},
			);
		}

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

		this.addRibbonIcon('sparkles', 'Recommendations', () => {
			this.openRecommendations();
		});

		this.addRibbonIcon('compass', 'Find anime', () => {
			this.openFind();
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
		this.debug('plugin.onunload');
		if (this.queueSaveTimer !== null) window.clearTimeout(this.queueSaveTimer);
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
			onPlay: (item) => void this.playItem(item),
			onDelete: (item) => this.deleteItem(item),
			onRefresh: () => this.refreshLibrary(),
			onDetails: (series) => this.openDetails(series),
			initialView: this.libraryView,
			onViewChange: (view) => {
				this.libraryView = view;
				void this.saveSettings();
			},
			// Posters are mined from the cached API answers, so the grid costs no
			// network: a series never browsed gets a fallback card instead.
			posters: () => collectPosters(this.animeCacheRecords),
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
				onDownload: (series) => this.openDownloader(series),
				onOpenRecommendation: (title) => this.openDetails(title),
				onClosed: () => {
					this.detailsModal = null;
				},
			},
		);
		this.detailsModal = modal;
		modal.open();
	}

	/**
	 * Open the recommendations page.
	 *
	 * The page drives its own load so it can report progress per seed; all this
	 * does is supply the taste profile and the two actions a card offers.
	 */
	openRecommendations(): void {
		if (this.recommendationsModal) {
			this.recommendationsModal.close();
			this.recommendationsModal = null;
		}
		const modal = new RecommendationsModal(this.app, {
			onLoad: (progress, onResults) => this.buildRecommendations(progress, onResults),
			onDetails: (title) => this.openDetails(title),
			onDownload: (title) => this.openDownloader(title),
			onDismiss: (title) => this.dismissRecommendation(title),
			dismissedCount: () => this.dismissedRecommendations.length,
			onRestoreDismissed: () => this.restoreDismissedRecommendations(),
			onClosed: () => {
				this.recommendationsModal = null;
			},
		});
		this.recommendationsModal = modal;
		modal.open();
	}

	/**
	 * Open the finder: browse sections and genres, then hand a picked title to
	 * the downloader with its source attached.
	 */
	openFind(): void {
		if (this.findModal) {
			this.findModal.close();
			this.findModal = null;
		}
		const modal = new FindModal(this.app, {
			apiBase: this.settings.animeApiBase,
			initialState: this.finderState ?? undefined,
			onStateChange: (state) => {
				this.finderState = state;
				// Same shape as the queue save: coalesce the writes, since every
				// navigation renders twice (busy, then done) and the data file is
				// written whole.
				if (this.finderSaveTimer !== null) window.clearTimeout(this.finderSaveTimer);
				this.finderSaveTimer = window.setTimeout(() => {
					this.finderSaveTimer = null;
					void this.saveSettings();
				}, 500);
			},
			onOpenSeries: (series) => this.openDownloader(undefined, series),
		});
		this.findModal = modal;
		modal.open();
	}

	/**
	 * The whole-history recommendation list behind the page.
	 *
	 * Unlike `recommendFor`, no series is privileged: the seeds are the history
	 * itself, so the result is "what to watch next", not "more like this".
	 */
	private async buildRecommendations(
		progress: (done: number, total: number, seed: string) => void,
		onResults: (items: Recommendation[], done: number, total: number) => void,
	): Promise<RecommendationsResult> {
		const seeds = this.tasteSeeds();
		if (seeds.length === 0) return { items: [], usedSeeds: [], failedSeeds: [] };

		const result = await collectRecommendations(this.settings.animeApiBase, seeds, {
			alreadyHave: this.ownedSeries(),
			limit: 24,
			onProgress: progress,
			onResults,
		});
		if (result.items.length === 0) return result;

		// Two optional passes, in increasing cost. The decision model is a single
		// fast pass; the curator is a whole generation and only runs when the user
		// has asked for it. Either one failing leaves the catalogue ranking, which
		// is always computed.
		const curated = await this.curateRecommendations(result.items, result.usedSeeds);
		const scores = await this.scoreWithModel(
			this.modelProfile(result.usedSeeds.join(', '), result.usedSeeds),
			curated.items,
		);
		const ranked = scores.size === 0 ? curated.items : applyModelScores(curated.items, scores);
		return { ...result, items: this.filterDismissed(ranked) };
	}

	/**
	 * Titles the user said they are not interested in, removed after ranking.
	 *
	 * Filtering happens at the end so the list the model saw (and the order it
	 * produced) is untouched — a dismissal is a presentational cut, and with the
	 * filter applied last, restoring titles is just clearing the array.
	 */
	private filterDismissed(items: Recommendation[]): Recommendation[] {
		if (this.dismissedRecommendations.length === 0) return items;
		return items.filter((item) => !isDismissed(this.dismissedRecommendations, item.title));
	}

	/** Remember a title the user is not interested in, newest first. */
	dismissRecommendation(title: string): void {
		this.dismissedRecommendations = pushDismissed(this.dismissedRecommendations, title);
		void this.saveSettings();
	}

	/** Put every dismissed title back into rotation. */
	restoreDismissedRecommendations(): void {
		if (this.dismissedRecommendations.length === 0) return;
		this.dismissedRecommendations = [];
		void this.saveSettings();
	}

	/**
	 * Let a language model re-order the list, if one is configured.
	 *
	 * The model gets the ranked candidates and two tools: a lookup against the
	 * user's own anime API, and optionally a web search. It is never trusted with
	 * the list itself — `curateWithModel` discards any title that was not offered,
	 * so a hallucinated series cannot reach the page, and a failure of any kind
	 * falls back to the deterministic ranking.
	 */
	private async curateRecommendations(
		items: Recommendation[],
		usedSeeds: string[],
	): Promise<{ items: Recommendation[]; curated: boolean }> {
		if (this.settings.llmProvider === 'off') return { items, curated: false };
		if (this.settings.llmProvider === 'in-process') {
			return await this.curateInProcess(items, usedSeeds);
		}
		const tools = this.curatorTools();
		try {
			const client = new LlmClient(
				{ postJson: (url, body, headers) => this.postJson(url, body, headers) },
				{
					baseUrl: this.settings.llmBaseUrl,
					model: this.settings.llmModel,
					apiKey: this.settings.llmApiKey,
				},
			);
			return await curateWithModel(items, {
				allowedTitles: items.map((item) => item.title),
				history: usedSeeds,
				limit: items.length,
				tools,
				complete: (messages, t) => client.complete(messages, t),
			});
		} catch {
			return { items, curated: false };
		}
	}

	/**
	 * Curate with a model running inside the plugin.
	 *
	 * The catalogue facts are gathered up front rather than offered as a tool, and
	 * the model is loaded lazily, so nothing here runs until the user has chosen
	 * this provider and asked for recommendations.
	 */
	private async curateInProcess(
		items: Recommendation[],
		usedSeeds: string[],
	): Promise<{ items: Recommendation[]; curated: boolean }> {
		try {
			const runtime = this.localRuntime();
			if (!runtime) return { items, curated: false };
			const notes = await gatherCatalogueNotes(items, (title) => this.lookupForCurator(title));
			return await curateInProcess(items, {
				runtime,
				allowedTitles: items.map((item) => item.title),
				history: usedSeeds,
				limit: items.length,
				notes,
			});
		} catch {
			return { items, curated: false };
		}
	}

	/**
	 * The in-process runtime, created once and reused.
	 *
	 * wllama is imported dynamically so its ~380 KB of JavaScript never loads at
	 * plugin start, and its wasm is fetched separately and cached, so a release
	 * still ships the usual three files.
	 */
	private localRuntime(): LocalRuntime | null {
		const model = findLocalModel(this.settings.llmLocalModel);
		if (!model) return null;
		if (this.llmRuntime) return this.llmRuntime;
		const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		const wasmPath = `${dir}/wllama.wasm`;
		const modulePath = `${dir}/wllama-module.js`;
		const adapter = this.app.vault.adapter;
		this.llmRuntime = new WllamaRuntime(
			{
				wasmPath,
				modulePath,
				readFile: async (path) => {
					try {
						if (!(await adapter.exists(path))) return null;
						return await adapter.readBinary(path);
					} catch {
						return null;
					}
				},
				writeFile: async (path, data) => {
					try {
						await adapter.writeBinary(path, data);
					} catch {
						/* A read-only vault just means it is fetched again next time. */
					}
				},
				download: async (url) => {
					const response = await requestUrl({ url, method: 'GET', throw: false });
					if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
					return response.arrayBuffer;
				},
			},
			{ url: modelDownloadUrl(model), label: model.label },
		);
		return this.llmRuntime;
	}

	/** The tools the curator may call. */
	private curatorTools(): CuratorTool[] {
		const tools: CuratorTool[] = [createAnimeApiTool((title) => this.lookupForCurator(title))];
		const search = this.settings.llmWebSearch ? this.settings.llmSearchUrl.trim() : '';
		if (search) {
			const webSearch = createWebSearchTool((query) => this.webSearchForCurator(search, query));
			if (webSearch) tools.push(webSearch);
		}
		return tools;
	}

	/**
	 * Describe a series for the model using the user's own API.
	 *
	 * Search first, then the richer preview for the best match, so the model reads
	 * a synopsis and genre list rather than just a title it may have
	 * mis-remembered.
	 */
	private async lookupForCurator(title: string): Promise<string | null> {
		try {
			const found = await searchSeries(this.settings.animeApiBase, title);
			const match = found.series[0];
			if (!match) return null;
			const preview = await loadPreview(this.settings.animeApiBase, match.id);
			if (!preview) return describeCatalogueEntry({ title: match.title }) || null;
			const detail = preview.detail as unknown as Record<string, unknown>;
			return describeCatalogueEntry({
				title: match.title,
				genres: Array.isArray(detail.genres) ? (detail.genres as string[]) : [],
				score: typeof detail.score === 'number' ? String(detail.score) : null,
				totalEpisodes: typeof detail.episodes === 'number' ? detail.episodes : null,
				overview: typeof detail.synopsis === 'string' ? detail.synopsis : null,
			});
		} catch {
			return null;
		}
	}

	/** Run the configured search endpoint. Only called when the user enabled it. */
	private async webSearchForCurator(endpoint: string, query: string): Promise<string | null> {
		const url = `${endpoint}${encodeURIComponent(query)}`;
		try {
			const response = await requestUrl({ url, method: 'GET', throw: false });
			if (response.status >= 400) return null;
			const text = response.text ?? '';
			const cleaned = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
			return cleaned.slice(0, 800) || null;
		} catch {
			return null;
		}
	}

	/** POST JSON through Obsidian's native client. */
	private async postJson(
		url: string,
		body: unknown,
		headers: Record<string, string>,
	): Promise<unknown> {
		const response = await requestUrl({
			url,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
			throw: false,
		});
		if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
		return response.json as unknown;
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

	/** The taste profile: what has been downloaded and watched, and how much. */
	private tasteSeeds(): TasteSeed[] {
		return deriveSeeds(
			this.stats.toJSON(),
			this.library.items().map((item) => ({
				series: item.series,
				watched: item.watched,
				// A 0–1 watch fraction, not raw seconds: buildTasteProfile weights
				// an in-progress episode by how far through it the viewer got, and
				// feeding it seconds made every long file read as half-watched.
				progress: watchFraction(item),
			})),
		);
	}

	/**
	 * The text a decision model judges candidates against: the seeds already
	 * chosen, then the strongest of the rest of the history.
	 *
	 * `exclude` is what the caller has already put in `seedText`. Repeating it in
	 * the tail is not harmless — the model reads a fixed token window, so a
	 * duplicated name takes the place of a series the user also likes, and the
	 * profile it judges against is narrower than the history it claims.
	 */
	private modelProfile(seedText: string, exclude: string[] = []): string {
		const skip = new Set(exclude.map((name) => name.trim().toLowerCase()));
		const rest = this.tasteSeeds()
			.filter((seed) => !skip.has(seed.series.trim().toLowerCase()))
			.slice(0, 12)
			.map((seed) => seed.series);
		if (rest.length === 0) return seedText;
		return `${seedText}. Also: ${rest.join(', ')}.`;
	}

	/**
	 * Recommendations for a series, blended with the whole download history.
	 *
	 * The series being viewed is added to the profile at a high weight so its own
	 * catalogue list leads, while the rest of the history supplies the text
	 * signal that orders the results.
	 */
	private async recommendFor(seed: string): Promise<Recommendation[]> {
		const history = this.tasteSeeds();
		const others = history.filter((entry) => entry.series.toLowerCase() !== seed.toLowerCase());
		const top = Math.max(1, ...others.map((entry) => entry.weight));
		const seeds = [{ series: seed, weight: top + 1 }, ...others];
		const owned = this.ownedSeries();

		const result = await collectRecommendations(this.settings.animeApiBase, seeds, {
			alreadyHave: owned,
			limit: 12,
		});
		if (result.items.length === 0) return result.items;

		const scores = await this.scoreWithModel(this.modelProfile(seed, [seed]), result.items);
		const ranked = scores.size === 0 ? result.items : applyModelScores(result.items, scores);
		return this.filterDismissed(ranked);
	}

	/**
	 * Ask the configured decision model to re-rank the candidates.
	 *
	 * Returns an empty map when no model is enabled or it fails, which leaves the
	 * vote-based ordering untouched.
	 */
	private async scoreWithModel(profile: string, items: Recommendation[]): Promise<Map<string, number>> {
		const titles = items.map((item) => item.title);
		if (titles.length === 0) return new Map();

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

	/**
	 * The WebVTT sidecar for an episode, as a blob URL a `<track>` can load.
	 *
	 * The sidecar sits next to the video and shares its name, so the lookup is
	 * the path with the extension swapped. A vault resource URL would also work
	 * in principle, but text tracks apply origin rules a resource path does not
	 * satisfy on every platform, so the file is read and served from a blob
	 * instead — a few dozen kilobytes, only when the player opens.
	 */
	private async subtitleTrackFor(path: string): Promise<string | null> {
		const sidecar = path.replace(/\.(mp4|ts)$/i, '.vtt');
		if (sidecar === path) return null;
		const adapter = this.app.vault.adapter as unknown as {
			exists(path: string): Promise<boolean>;
			read(path: string): Promise<string>;
		};
		try {
			if (!(await adapter.exists(sidecar))) return null;
			const text = await adapter.read(sidecar);
			return URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
		} catch {
			return null;
		}
	}

	/** Play an entry, resuming from its saved position. */
	async playItem(item: LibraryItem): Promise<void> {
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
		const subtitleUrl = await this.subtitleTrackFor(item.path);
		const modal = new PlayerModal(
			this.app,
			item,
			source,
			this.library.getProgress(item.path),
			subtitleUrl,
			{
				on: this.settings.subtitlesOn,
				size: this.settings.subtitleSize,
				delayMs: this.settings.subtitleDelayMs,
			},
			{
				onProgress: (path, position, duration) => this.recordProgress(path, position, duration),
				onReset: (path) => {
					this.library.clearProgress(path);
					void this.saveWatchRecords();
				},
				onNavigate: (direction) => {
					const target = this.adjacentEpisode(item, direction);
					if (!target) {
						new Notice(direction === 'next' ? 'This is the last episode.' : 'This is the first episode.');
						return;
					}
					void this.playItem(target);
				},
				onEnded: () => {
					// Off by default; when on, the finished record is already
					// written, so the next open resumes wherever this sitting got.
					if (!this.settings.autoPlayNext) return;
					const target = this.adjacentEpisode(item, 'next');
					if (target) void this.playItem(target);
				},
				onSubtitlePreference: (patch) => {
					if (patch.on !== undefined) this.settings.subtitlesOn = patch.on;
					if (patch.size !== undefined) this.settings.subtitleSize = patch.size;
					if (patch.delayMs !== undefined) this.settings.subtitleDelayMs = patch.delayMs;
					void this.saveSettings();
				},
				onClosed: () => {
					this.playerModal = null;
				},
			},
		);
		this.playerModal = modal;
		modal.open();
	}

	/**
	 * The episode before or after this one in the same series, in the library's
	 * own display order. Resolved from the current scan at play time — nothing
	 * about the next episode is held in memory.
	 */
	private adjacentEpisode(item: LibraryItem, direction: 'previous' | 'next'): LibraryItem | null {
		const candidates = this.library
			.items()
			.filter((entry) => entry.series === item.series && entry.ext === 'mp4')
			.sort((left, right) => left.episode - right.episode || left.name.localeCompare(right.name));
		const index = candidates.findIndex((entry) => entry.path === item.path);
		if (index < 0) return null;
		return candidates[index + (direction === 'next' ? 1 : -1)] ?? null;
	}

	private recordProgress(path: string, position: number, duration: number): void {
		this.library.record(path, position, duration);
		void this.saveWatchRecords();
	}

	async deleteItem(item: LibraryItem): Promise<void> {
		const adapter = this.app.vault.adapter as unknown as {
			remove(path: string): Promise<void>;
			exists(path: string): Promise<boolean>;
		};
		await adapter.remove(item.path);
		// The subtitle sidecar shares the video's name, so it goes too. Its
		// removal must never fail the delete of the file itself.
		const sidecar = item.path.replace(/\.(mp4|ts)$/i, '.vtt');
		if (sidecar !== item.path) {
			try {
				if (await adapter.exists(sidecar)) await adapter.remove(sidecar);
			} catch {
				/* Best effort. */
			}
		}
		this.library.clearProgress(item.path);
		await this.saveWatchRecords();
	}

	/** Move flat legacy downloads into the current series-folder layout. */
	async migrateDownloads(): Promise<void> {
		if (this.settings.downloadExternal) {
			new Notice('Migration is available for downloads inside the vault only.');
			return;
		}

		const adapter = this.app.vault.adapter as unknown as {
			rename(from: string, to: string): Promise<void>;
			exists(path: string): Promise<boolean>;
			mkdir(path: string): Promise<void>;
		};
		await this.refreshLibrary();
		const folder = this.settings.downloadFolder.replace(/^\/+|\/+$/g, '');
		const items = this.library.items();
		let moved = 0;
		let skipped = 0;
		let failed = 0;
		for (const item of items) {
			if (!item.series) {
				skipped++;
				continue;
			}
			const target = sanitizePath(`${folder}/${seriesFolderName(item.series)}/${item.name}`);
			if (target === item.path) {
				skipped++;
				continue;
			}
			try {
				if (await adapter.exists(target)) {
					skipped++;
					this.debug('migration.skip-existing', { from: item.path, to: target });
					continue;
				}
				const parts = target.split('/');
				parts.pop();
				let current = '';
				for (const part of parts) {
					current = current ? `${current}/${part}` : part;
					if (!(await adapter.exists(current))) await adapter.mkdir(current);
				}
				await adapter.rename(item.path, target);
				moved++;
				this.debug('migration.moved', { from: item.path, to: target });
			} catch (error) {
				failed++;
				this.debug('migration.failed', {
					from: item.path,
					to: target,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		await this.refreshLibrary();
		new Notice(`Migration complete · ${moved} moved · ${skipped} skipped${failed ? ` · ${failed} failed` : ''}.`);
	}

	async exportDebugLog(): Promise<void> {
		if (this.settings.downloadExternal) {
			new Notice('Export the debug log with vault downloads enabled.');
			return;
		}
		const adapter = this.app.vault.adapter as unknown as {
			exists(path: string): Promise<boolean>;
			readBinary(path: string): Promise<ArrayBuffer>;
			writeBinary(path: string, data: ArrayBuffer): Promise<void>;
			remove(path: string): Promise<void>;
			mkdir(path: string): Promise<void>;
		};
		const source = this.debugLogPath();
		try {
			await this.debugLogger.flush();
			if (!(await adapter.exists(source))) {
				new Notice('No debug log has been written yet.');
				return;
			}
			const folder = this.settings.downloadFolder.replace(/^\/+|\/+$/g, '');
			const safeFolder = folder ? sanitizePath(folder) : '';
			const base = safeFolder ? `${safeFolder}/debug-log` : 'debug-log';
			let target = `${base}.md`;
			if (await adapter.exists(target)) {
				const stamp = new Date().toISOString().replace(/[:.]/g, '-');
				target = `${base}-${stamp}.md`;
			}
			const parts = target.split('/');
			parts.pop();
			let current = '';
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				if (!(await adapter.exists(current))) await adapter.mkdir(current);
			}
			const logText = new TextDecoder().decode(await adapter.readBinary(source));
			const markdown = `# Anime for Mobile debug log\n\n\`\`\`text\n${logText.replace(/```/g, '``\\u200b`')}\`\`\`\n`;
			await adapter.writeBinary(target, new TextEncoder().encode(markdown).buffer);
			await adapter.remove(source);
			new Notice(`Debug log exported to ${target}`);
		} catch (error) {
			this.debug('debug.export.failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			new Notice(error instanceof Error ? `Debug log export failed: ${error.message}` : 'Debug log export failed.');
		}
	}

	/**
	 * The download folder for an export, or null when downloads go outside the
	 * vault — where the adapter cannot write (mobile) or read back (import).
	 */
	private exportFolder(): string | null {
		if (this.settings.downloadExternal) return null;
		const folder = this.settings.downloadFolder.replace(/^\/+|\/+$/g, '');
		return folder ? sanitizePath(folder) : '';
	}

	private exportAdapter(): {
		exists(path: string): Promise<boolean>;
		readBinary(path: string): Promise<ArrayBuffer>;
		writeBinary(path: string, data: ArrayBuffer): Promise<void>;
		mkdir(path: string): Promise<void>;
	} {
		return this.app.vault.adapter;
	}

	/** Create every folder on a vault-relative export path. */
	private async ensureFolders(adapter: ReturnType<AnimePlugin['exportAdapter']>, path: string): Promise<void> {
		const parts = path.split('/');
		parts.pop();
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await adapter.exists(current))) await adapter.mkdir(current);
		}
	}

	/**
	 * Write the watch progress and the run log into the download folder, as one
	 * JSON document plus the run log as CSV for a spreadsheet.
	 *
	 * Vault-only, like the debug-log export. The JSON is overwritten in place
	 * rather than stamped, because the import command reads exactly this path —
	 * a stamped file would never be picked up.
	 */
	async exportData(): Promise<void> {
		const folder = this.exportFolder();
		if (folder === null) {
			new Notice('Export data with vault downloads enabled.');
			return;
		}
		const adapter = this.exportAdapter();
		try {
			const payload = {
				version: 1 as const,
				exportedAt: new Date().toISOString(),
				watch: this.library.toJSON(),
				stats: this.stats.toJSON(),
			};
			const base = folder ? `${folder}/anime-data-export` : 'anime-data-export';
			await this.ensureFolders(adapter, `${base}.json`);
			await adapter.writeBinary(
				`${base}.json`,
				new TextEncoder().encode(JSON.stringify(payload, null, '\t')).buffer,
			);
			const csvPath = folder ? `${folder}/anime-statistics.csv` : 'anime-statistics.csv';
			await adapter.writeBinary(
				csvPath,
				new TextEncoder().encode(buildStatsCsv(this.stats.toJSON())).buffer,
			);
			this.debug('data.exported', {
				runs: payload.stats.length,
				watch: Object.keys(payload.watch).length,
			});
			new Notice(`Exported to ${base}.json and ${csvPath}`);
		} catch (error) {
			this.debug('data.export.failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			new Notice(error instanceof Error ? `Export failed: ${error.message}` : 'Export failed.');
		}
	}

	/**
	 * Replace the watch progress and run log from an export file in the download
	 * folder.
	 *
	 * Replacement, not merging: the export is a snapshot of one device's state,
	 * and a merge would resurrect progress the user deleted on purpose. The file
	 * is fully parsed and validated before the confirmation, so a malformed
	 * export changes nothing, and the confirm names what would be replaced.
	 */
	async importData(): Promise<void> {
		const folder = this.exportFolder();
		if (folder === null) {
			new Notice('Import data with vault downloads enabled.');
			return;
		}
		const adapter = this.exportAdapter();
		const path = folder ? `${folder}/anime-data-export.json` : 'anime-data-export.json';
		try {
			if (!(await adapter.exists(path))) {
				new Notice(`No anime-data-export.json found in ${folder || 'the vault root'}.`);
				return;
			}
			let payload: unknown;
			try {
				payload = JSON.parse(new TextDecoder().decode(await adapter.readBinary(path)));
			} catch {
				new Notice('The export file is not valid JSON.');
				return;
			}
			const parsed = parseDataExport(payload);
			if (!parsed) {
				new Notice('That file is not a data export (version 1).');
				return;
			}
			new ConfirmModal(
				this.app,
				`Replace your watch progress (${Object.keys(parsed.watch).length} entries) and download statistics (${parsed.stats.length} runs) with the contents of this file? The current data is overwritten.`,
				() => void this.applyImport(parsed),
			).open();
		} catch (error) {
			this.debug('data.import.failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			new Notice(error instanceof Error ? `Import failed: ${error.message}` : 'Import failed.');
		}
	}

	/** Apply an already-validated export: replace, persist, refresh. */
	private async applyImport(parsed: DataExport): Promise<void> {
		this.library.load(parsed.watch);
		this.watchRecords = this.library.toJSON();
		this.stats.load(parsed.stats);
		await this.saveSettings();
		await this.refreshLibrary();
		new Notice(
			`Imported ${Object.keys(parsed.watch).length} watch entries and ${parsed.stats.length} runs.`,
		);
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
			downloadSubtitles: this.settings.downloadSubtitles,
			preferDub: this.settings.preferDub,
			destination: {
				external: this.settings.downloadExternal,
				folder: this.settings.downloadFolder,
			},
		};
	}

	openDownloader(query?: string, series?: SeriesSummary): void {
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
				initialQuery: query,
				initialSeries: series,
				repairLedger: this.repairLedger,
				seriesPreferences: this.seriesPreferences,
			},
			{
				onOptionsChanged: (patch) => {
					void this.applyDownloadOptions(patch);
				},
				onSeriesPreference: (seriesTitle, patch) => {
					// Scoped to the series: the global quality and format settings
					// stay untouched, and the override rides the next queue save.
					this.seriesPreferences = withSeriesPreference(this.seriesPreferences, seriesTitle, patch);
					void this.saveSettings();
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
			id: 'export-anime-data',
			name: 'Export watch progress and statistics',
			callback: () => {
				void this.exportData();
			},
		});

		this.addCommand({
			id: 'import-anime-data',
			name: 'Import watch progress and statistics',
			callback: () => {
				void this.importData();
			},
		});

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
			id: 'migrate-anime-downloads',
			name: 'Organize downloads into series folders',
			callback: () => {
				void this.migrateDownloads();
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

		this.addCommand({
			id: 'open-anime-finder',
			name: 'Anime: find anime',
			callback: () => {
				this.openFind();
			},
		});

		this.addCommand({
			id: 'open-anime-recommendations',
			name: 'Anime: open recommendations',
			callback: () => {
				this.openRecommendations();
			},
		});
	}

	/**
	 * Rewrite previously downloaded MP4s into the container other players read.
	 * Files made before 1.1.1 also report the same length everywhere, because
	 * mux.js left the duration at its sentinel; files made before the
	 * progressive writer are fragmented, so only Obsidian's own player opens
	 * them at all. The media is already on disk, so both are repaired in place
	 * rather than re-downloaded.
	 */
	private async repairDownloads(): Promise<void> {
		const folder = this.settings.downloadExternal ? '' : this.settings.downloadFolder;
		const adapter = this.app.vault.adapter as unknown as {
			readBinary(path: string): Promise<ArrayBuffer>;
			writeBinary(path: string, data: ArrayBuffer): Promise<void>;
			list(path: string): Promise<{ files: string[]; folders: string[] }>;
			exists(path: string): Promise<boolean>;
			rename(from: string, to: string): Promise<void>;
			remove(path: string): Promise<void>;
			stat(path: string): Promise<{ size: number; mtime: number } | null>;
		};
		const notice = new Notice('Checking downloaded videos…', 0);
		try {
			const result = await repairFolder(adapter, folder, undefined, {
				ledger: this.repairLedger,
				maxFileBytes: Platform.isMobile ? repairByteBudget() / 2 : undefined,
				maxInFlight: Platform.isMobile ? 1 : undefined,
			});
			await this.saveSettings();
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
			if (result.skipped > 0) parts.push(`${result.skipped} already checked`);
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
		if (this.settings.downloadFilenameTemplate === '{series} - {ep:02} - {title}.{ext}') {
			this.settings.downloadFilenameTemplate = DEFAULT_FILENAME_TEMPLATE;
		}
		this.statsRuns = Array.isArray(raw?.stats) ? raw.stats : [];
		this.watchRecords = raw?.watch ?? {};
		this.animeCacheRecords = raw?.animeCache ?? null;
		this.downloadQueue = Array.isArray(raw?.downloadQueue) ? raw.downloadQueue : [];
		this.downloadScanCache = raw?.downloadScanCache ?? {};
		this.seriesPreferences =
			raw?.seriesPreferences && typeof raw.seriesPreferences === 'object'
				? raw.seriesPreferences
				: {};
		this.finderState = this.parseFinderState(raw?.finderState);
		this.libraryView = raw?.libraryView === 'grid' ? 'grid' : 'list';
		this.dismissedRecommendations = Array.isArray(raw?.dismissedRecommendations)
			? raw.dismissedRecommendations.filter((title): title is string => typeof title === 'string')
			: [];
		this.repairLedger = new RepairLedger(raw?.repairLedger);
		// A scan from an earlier session already read every file it covered. Adopt
		// its verdicts so the first repair this session skips them.
		this.repairLedger.seedFromScanCache(this.downloadScanCache);
	}

	async saveSettings(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			downloadScanCache: this.downloadScanCache,
			repairLedger: this.repairLedger.toJSON(),
			watch: this.watchRecords,
			stats: this.stats.toJSON(),
			animeCache: this.animeCacheRecords,
			downloadQueue: this.downloader?.serializeQueue?.() ?? this.downloadQueue,
			seriesPreferences: this.seriesPreferences,
			finderState: this.finderState,
			libraryView: this.libraryView,
			dismissedRecommendations: this.dismissedRecommendations,
		});
	}

	/**
	 * Validate a persisted finder state, or null when it is not one.
	 *
	 * Only the view is checked hard — the rest is tolerated loosely, and the
	 * modal itself re-applies the 18+ gate on restore. A corrupt state costs
	 * nothing: the finder opens on its front page instead.
	 */
	private parseFinderState(value: unknown): PersistedFinderState | null {
		if (!value || typeof value !== 'object') return null;
		const state = value as Partial<PersistedFinderState>;
		if (state.view !== 'sections' && state.view !== 'genres' && state.view !== 'browse') return null;
		return {
			source: typeof state.source === 'string' ? state.source : undefined,
			view: state.view,
			sectionId: typeof state.sectionId === 'string' ? state.sectionId : null,
			sectionName: typeof state.sectionName === 'string' ? state.sectionName : '',
			genreSlug: typeof state.genreSlug === 'string' ? state.genreSlug : null,
			page: typeof state.page === 'number' && state.page > 0 ? Math.floor(state.page) : 1,
			adultOptIn: state.adultOptIn === true,
		};
	}

}

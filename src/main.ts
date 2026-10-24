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
import { DEFAULT_SETTINGS, BrowserSettingTab, type BrowserSettings } from './settings';
import { StatsStore, type DownloadRun } from './stats';
import { StatsModal } from './statsModal';
import { BrowserStore } from './store';
import type { BrowserData } from './types';
import { DEFAULT_SEARCH_TEMPLATE, LEGACY_SEARCH_TEMPLATE } from './utils';
import { BrowserView, VIEW_TYPE_BROWSER } from './view';
import { DownloadManagerView, VIEW_TYPE_DOWNLOADS } from './downloadManagerView';

interface PersistedShape extends Partial<BrowserData> {
	settings?: Partial<BrowserSettings>;
	/** Watch progress per vault path, so the library survives a reload. */
	watch?: Record<string, WatchRecord>;
	/** The download statistics log. */
	stats?: DownloadRun[];
	/** Cached anime API responses, so a restart does not re-fetch the catalogue. */
	animeCache?: unknown;
}

export default class BrowserPlugin extends Plugin {
	settings!: BrowserSettings;
	store!: BrowserStore;
	downloader!: DownloadManager;
	library!: VideoLibrary;
	stats!: StatsStore;
	animeCache!: AnimeCache;

	private browserData: Partial<BrowserData> = {};
	private downloadModal: DownloadModal | null = null;
	private libraryModal: LibraryModal | null = null;
	private playerModal: PlayerModal | null = null;
	private statsModal: StatsModal | null = null;
	private watchRecords: Record<string, WatchRecord> = {};
	/** The run log as loaded, handed to the stats store in onload. */
	private statsRuns: DownloadRun[] = [];
	/** Cached API responses as loaded, handed to the anime cache in onload. */
	private animeCacheRecords: unknown = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.store = new BrowserStore({
			saveData: (data) => this.persist(data as BrowserData),
		});
		this.store.load(this.browserData);

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

		this.registerView(VIEW_TYPE_BROWSER, (leaf: WorkspaceLeaf) => new BrowserView(leaf, this));
		this.registerView(VIEW_TYPE_DOWNLOADS, (leaf: WorkspaceLeaf) => new DownloadManagerView(leaf, this));

		this.addRibbonIcon('globe', 'Open browser', () => {
			void this.activateView();
		});

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
		this.addSettingTab(new BrowserSettingTab(this.app, this));

		this.registerDomEvent(window, 'beforeunload', () => {
			this.animeCache.dispose();
			this.store.dispose();
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
		this.store.dispose();
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

	/** Append a finished run to the log and persist it. */
	private async recordRun(run: DownloadRun): Promise<void> {
		this.stats.record(run);
		await this.saveSettings();
	}

	/** Re-scan the download folder and drop progress for files that are gone. */
	async refreshLibrary(): Promise<void> {
		const adapter = this.app.vault.adapter as unknown as {
			list(path: string): Promise<{ files: string[]; folders: string[] }>;
			exists(path: string): Promise<boolean>;
			stat(path: string): Promise<{ size: number; mtime: number } | null>;
		};
		await this.library.refresh(adapter, this.libraryFolder(), this.settings.downloadFilenameTemplate);
		this.library.prune();
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
			id: 'open-browser',
			name: 'Open browser',
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: 'new-tab',
			name: 'New tab',
			callback: () => {
				void this.withView((view) => view.navigate(this.settings.homePage));
			},
		});

		this.addCommand({
			id: 'close-tab',
			name: 'Close current tab',
			callback: () => {
				void this.withView((view) => view.closeTab());
			},
		});

		this.addCommand({
			id: 'next-tab',
			name: 'Next tab',
			callback: () => {
				void this.withView((view) => view.nextTab());
			},
		});

		this.addCommand({
			id: 'previous-tab',
			name: 'Previous tab',
			callback: () => {
				void this.withView((view) => view.prevTab());
			},
		});

		this.addCommand({
			id: 'go-back',
			name: 'Go back',
			callback: () => {
				void this.withView((view) => view.goBack());
			},
		});

		this.addCommand({
			id: 'go-forward',
			name: 'Go forward',
			callback: () => {
				void this.withView((view) => view.goForward());
			},
		});

		this.addCommand({
			id: 'reload-page',
			name: 'Reload page',
			callback: () => {
				void this.withView((view) => view.reload());
			},
		});

		this.addCommand({
			id: 'focus-address-bar',
			name: 'Focus address bar',
			callback: () => {
				void this.withView((view) => view.focusAddressBar());
			},
		});

		this.addCommand({
			id: 'toggle-proxy-rendering',
			name: 'Toggle proxy rendering',
			callback: () => {
				void this.withView((view) => view.toggleProxy());
			},
		});

		this.addCommand({
			id: 'bookmark-page',
			name: 'Bookmark current page',
			callback: () => {
				void this.withView((view) => view.toggleBookmark());
			},
		});

		this.addCommand({
			id: 'open-bookmarks',
			name: 'Open bookmarks',
			callback: () => {
				void this.withView((view) => view.openBookmarks());
			},
		});

		this.addCommand({
			id: 'open-history',
			name: 'Open history',
			callback: () => {
				void this.withView((view) => view.openHistory());
			},
		});

		this.addCommand({
			id: 'open-cookie-manager',
			name: 'Manage cookies',
			callback: () => {
				void this.withView((view) => view.openCookieManager());
			},
		});

		this.addCommand({
			id: 'go-home',
			name: 'Go to home page',
			callback: () => {
				void this.withView((view) => view.goHome());
			},
		});

		this.addCommand({
			id: 'clear-browsing-data',
			name: 'Clear browsing data',
			callback: () => {
				void this.withView((view) => view.clearBrowsingData());
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

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_BROWSER);
		const first = existing[0];
		if (first) {
			await this.app.workspace.revealLeaf(first);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_BROWSER, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	private async withView(action: (view: BrowserView) => void): Promise<void> {
		let view = this.app.workspace.getActiveViewOfType(BrowserView);
		if (!view) {
			await this.activateView();
			view = this.app.workspace.getActiveViewOfType(BrowserView);
		}
		if (!view) {
			new Notice('Could not open the browser.');
			return;
		}
		action(view);
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as PersistedShape | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings ?? {});
		this.statsRuns = Array.isArray(raw?.stats) ? raw.stats : [];
		// Move the old JS-app search URL to the server-rendered endpoint; a
		// user-chosen engine is left untouched.
		if (this.settings.searchTemplate === LEGACY_SEARCH_TEMPLATE) {
			this.settings.searchTemplate = DEFAULT_SEARCH_TEMPLATE;
		}
		this.browserData = raw ?? {};
		this.watchRecords = raw?.watch ?? {};
		this.animeCacheRecords = raw?.animeCache ?? null;
	}

	async saveSettings(): Promise<void> {
		await this.saveData({
			...this.browserData,
			settings: this.settings,
			watch: this.watchRecords,
			stats: this.stats.toJSON(),
			animeCache: this.animeCacheRecords,
		});
	}

	private async persist(data: BrowserData): Promise<void> {
		this.browserData = { ...this.browserData, ...data };
		await this.saveData({
			...data,
			downloadScanCache: (this.browserData as { downloadScanCache?: unknown }).downloadScanCache,
			// Navigation calls this on every page load; without carrying the cache
			// through, the first page load would wipe it.
			animeCache: this.animeCacheRecords,
			settings: this.settings,
			watch: this.watchRecords,
			stats: this.stats.toJSON(),
		});
	}
}

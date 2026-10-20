import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { DownloadManager, type DownloaderOptions } from './downloader';
import { DownloadModal, type DownloadModalOptions } from './downloadModal';
import { repairFolder } from './doctor';
import { DEFAULT_SETTINGS, BrowserSettingTab, type BrowserSettings } from './settings';
import { BrowserStore } from './store';
import type { BrowserData } from './types';
import { DEFAULT_SEARCH_TEMPLATE, LEGACY_SEARCH_TEMPLATE } from './utils';
import { BrowserView, VIEW_TYPE_BROWSER } from './view';

interface PersistedShape extends Partial<BrowserData> {
	settings?: Partial<BrowserSettings>;
}

export default class BrowserPlugin extends Plugin {
	settings!: BrowserSettings;
	store!: BrowserStore;
	downloader!: DownloadManager;

	private browserData: Partial<BrowserData> = {};
	private downloadModal: DownloadModal | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.store = new BrowserStore({
			saveData: (data) => this.persist(data as BrowserData),
		});
		this.store.load(this.browserData);

		this.downloader = new DownloadManager(this.app, this.downloaderOptions(), () => {
			this.downloadModal?.refresh();
		});

		this.registerView(VIEW_TYPE_BROWSER, (leaf: WorkspaceLeaf) => new BrowserView(leaf, this));

		this.addRibbonIcon('globe', 'Open browser', () => {
			void this.activateView();
		});

		this.addRibbonIcon('download', 'Download anime', () => {
			this.openDownloader();
		});

		this.registerCommands();
		this.addSettingTab(new BrowserSettingTab(this.app, this));

		this.registerDomEvent(window, 'beforeunload', () => {
			this.store.dispose();
		});
	}

	onunload(): void {
		this.store.dispose();
		this.downloader.dispose();
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
			if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
			new Notice(parts.join(' · '));
		} catch (error) {
			notice.hide();
			new Notice(error instanceof Error ? error.message : 'The repair could not be completed.');
		}
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
		// Move the old JS-app search URL to the server-rendered endpoint; a
		// user-chosen engine is left untouched.
		if (this.settings.searchTemplate === LEGACY_SEARCH_TEMPLATE) {
			this.settings.searchTemplate = DEFAULT_SEARCH_TEMPLATE;
		}
		this.browserData = raw ?? {};
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ ...this.browserData, settings: this.settings });
	}

	private async persist(data: BrowserData): Promise<void> {
		this.browserData = data;
		await this.saveData({ ...data, settings: this.settings });
	}
}

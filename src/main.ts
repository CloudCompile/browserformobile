import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
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

	private browserData: Partial<BrowserData> = {};

	async onload(): Promise<void> {
		await this.loadSettings();

		this.store = new BrowserStore({
			saveData: (data) => this.persist(data as BrowserData),
		});
		this.store.load(this.browserData);

		this.registerView(VIEW_TYPE_BROWSER, (leaf: WorkspaceLeaf) => new BrowserView(leaf, this));

		this.addRibbonIcon('globe', 'Open browser', () => {
			void this.activateView();
		});

		this.registerCommands();
		this.addSettingTab(new BrowserSettingTab(this.app, this));

		this.registerDomEvent(window, 'beforeunload', () => {
			this.store.dispose();
		});
	}

	onunload(): void {
		this.store.dispose();
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

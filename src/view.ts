import { ItemView, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import { parseCookieString } from './cookieStore';
import type BrowserPlugin from './main';
import {
	BookmarkModal,
	ConfirmModal,
	CookieManagerModal,
	HistoryModal,
	ProxyFallbackModal,
} from './modals';
import { DirectRenderer, ProxyRenderer, type NavigateOptions, type Renderer } from './renderer';
import type { RenderMode, TabState } from './types';
import { displayUrl, hostOf, normalizeInput } from './utils';

export const VIEW_TYPE_BROWSER = 'browser-for-mobile-view';

interface LoadRequest extends NavigateOptions {
	renderMode?: RenderMode;
	/** Do not touch the per-tab history list. Used for back and forward. */
	noHistory?: boolean;
}

export class BrowserView extends ItemView {
	private addressEl!: HTMLInputElement;
	private tabsEl!: HTMLElement;
	private pageEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private backButton!: HTMLButtonElement;
	private forwardButton!: HTMLButtonElement;
	private bookmarkButton!: HTMLButtonElement;
	private proxyButton!: HTMLButtonElement;
	private renderer: Renderer | null = null;
	private loading = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: BrowserPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BROWSER;
	}

	getDisplayText(): string {
		return this.plugin.store.tabs.active?.title ?? 'Browser';
	}

	getIcon(): string {
		return 'globe';
	}

	async onOpen(): Promise<void> {
		this.buildUi();
		const active = this.plugin.store.tabs.active;
		if (active) {
			this.renderActiveTab();
		} else {
			this.newTab(this.plugin.settings.homePage);
		}
	}

	async onClose(): Promise<void> {
		this.unmountRenderer();
	}

	// --- UI construction -----------------------------------------------------

	private buildUi(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('bfm-root');

		const toolbar = root.createDiv({ cls: 'bfm-toolbar' });
		const navGroup = toolbar.createDiv({ cls: 'bfm-toolbar-group' });

		this.backButton = this.iconButton(navGroup, 'arrow-left', 'Back', () => this.goBack());
		this.forwardButton = this.iconButton(navGroup, 'arrow-right', 'Forward', () =>
			this.goForward(),
		);
		this.iconButton(navGroup, 'rotate-cw', 'Reload', () => this.reload());

		const addressWrap = toolbar.createDiv({ cls: 'bfm-address-wrap' });
		this.addressEl = addressWrap.createEl('input', {
			cls: 'bfm-address',
			attr: {
				type: 'text',
				placeholder: 'Search or enter address',
				spellcheck: 'false',
				autocapitalize: 'off',
				autocomplete: 'off',
				enterkeyhint: 'go',
			},
		});
		this.addressEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.addressEl.blur();
				this.navigate(this.addressEl.value);
			}
		});

		const actionGroup = toolbar.createDiv({ cls: 'bfm-toolbar-group' });
		this.bookmarkButton = this.iconButton(actionGroup, 'star', 'Bookmark this page', () =>
			this.toggleBookmark(),
		);
		this.proxyButton = this.iconButton(actionGroup, 'shield', 'Toggle proxy rendering', () =>
			this.toggleProxy(),
		);
		this.iconButton(actionGroup, 'globe', 'Open in system browser', () => {
			const tab = this.plugin.store.tabs.active;
			if (tab) this.openExternal(tab.displayUrl);
		});

		this.tabsEl = root.createDiv({ cls: 'bfm-tabs' });
		this.pageEl = root.createDiv({ cls: 'bfm-content' });
		this.statusEl = root.createDiv({ cls: 'bfm-status' });
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		title: string,
		onClick: () => void,
	): HTMLButtonElement {
		const button = parent.createEl('button', { cls: 'bfm-icon-button', attr: { title } });
		setIcon(button, icon);
		button.addEventListener('click', onClick);
		return button;
	}

	// --- Rendering -----------------------------------------------------------

	private renderTabs(): void {
		const { tabs } = this.plugin.store.tabs;
		this.tabsEl.empty();
		for (const tab of tabs) {
			const el = this.tabsEl.createDiv({ cls: 'bfm-tab' });
			if (tab.id === this.plugin.store.tabs.activeTabId) el.addClass('is-active');
			const label = el.createSpan({
				cls: 'bfm-tab-label',
				text: tab.title || 'New tab',
			});
			label.setAttribute('title', tab.displayUrl);
			label.addEventListener('click', () => {
				this.plugin.store.tabs.activate(tab.id);
				this.renderActiveTab();
			});
			const close = el.createSpan({ cls: 'bfm-tab-close' });
			setIcon(close, 'x');
			close.addEventListener('click', (event) => {
				event.stopPropagation();
				this.closeTab(tab.id);
			});
		}
		const add = this.tabsEl.createDiv({ cls: 'bfm-tab-add' });
		setIcon(add, 'plus');
		add.setAttribute('title', 'New tab');
		add.addEventListener('click', () => this.newTab(this.plugin.settings.homePage));
	}

	private renderActiveTab(): void {
		const tab = this.plugin.store.tabs.active;
		this.renderTabs();
		if (!tab) {
			this.unmountRenderer();
			this.addressEl.value = '';
			this.updateToolbar();
			this.updateStatus();
			return;
		}
		this.addressEl.value = tab.displayUrl;
		this.updateToolbar();
		this.updateStatus();
		void this.mountRenderer(tab);
	}

	private updateToolbar(): void {
		const tab = this.plugin.store.tabs.active;
		const store = this.plugin.store.tabs;
		this.backButton.disabled = !tab || !store.canGoBack(tab.id);
		this.forwardButton.disabled = !tab || !store.canGoForward(tab.id);
		const bookmarked = tab ? this.plugin.store.isBookmarked(tab.displayUrl) : false;
		this.bookmarkButton.toggleClass('is-active', bookmarked);
		this.proxyButton.toggleClass('is-active', tab?.renderMode === 'proxy');
	}

	private updateStatus(): void {
		const tab = this.plugin.store.tabs.active;
		if (!tab) {
			this.statusEl.setText('');
			return;
		}
		const mode = tab.renderMode === 'proxy' ? 'Proxy' : 'Direct';
		const host = hostOf(tab.displayUrl) || displayUrl(tab.displayUrl, 40);
		const cookieCount = this.plugin.store.cookies.length;
		this.statusEl.setText(`${mode} · ${host} · ${cookieCount} cookies`);
	}

	private async mountRenderer(tab: TabState): Promise<void> {
		this.unmountRenderer();
		this.pageEl.empty();
		this.loading = true;
		this.statusEl.setText(
			tab.renderMode === 'proxy' ? 'Loading through proxy…' : 'Loading…',
		);

		const useProxy = tab.renderMode === 'proxy';
		const context = {
			container: this.pageEl,
			url: tab.url,
			displayUrl: tab.displayUrl,
			cookies: this.plugin.settings.enableCookies ? this.plugin.store.cookies : [],
			proxyBase: this.plugin.settings.proxyBase,
			directFetch: this.plugin.settings.directFetch,
			events: {
				onTitle: (title: string) => this.handleTitle(tab.id, title),
				onError: (message: string, options?: { suggestProxy?: boolean }) =>
					this.handleError(tab.id, message, options),
				onNavigate: (url: string, navigateOptions?: NavigateOptions) =>
					this.handleBridgeNavigate(url, navigateOptions),
				onOpenExternal: (url: string) => this.openExternal(url),
				onCookie: (raw: string, url: string) => this.handleCookie(raw, url),
				onReady: (resolvedUrl: string) => this.handleReady(tab.id, resolvedUrl),
			},
		};

		const renderer = useProxy
			? new ProxyRenderer(context)
			: new DirectRenderer(context);
		this.renderer = renderer;
		await renderer.mount();
	}

	private unmountRenderer(): void {
		if (this.renderer) {
			this.renderer.unmount();
			this.renderer = null;
		}
		this.pageEl?.empty();
	}

	// --- Bridge and lifecycle handlers --------------------------------------

	private handleTitle(tabId: string, title: string): void {
		if (!title) return;
		this.plugin.store.tabs.update(tabId, { title });
		this.plugin.store.markDirty();
		this.renderTabs();
	}

	private handleReady(tabId: string, resolvedUrl: string): void {
		this.loading = false;
		const tab = this.plugin.store.tabs.get(tabId);
		if (!tab) return;
		if (resolvedUrl && resolvedUrl !== tab.displayUrl) {
			this.plugin.store.tabs.update(tabId, { displayUrl: resolvedUrl });
		}
		if (this.plugin.store.tabs.activeTabId === tabId) {
			this.addressEl.value = resolvedUrl;
			this.updateStatus();
		}
		this.plugin.store.addHistory(
			resolvedUrl || tab.displayUrl,
			this.plugin.store.tabs.get(tabId)?.title ?? '',
		);
	}

	private handleError(tabId: string, message: string, options?: { suggestProxy?: boolean }): void {
		this.loading = false;
		this.plugin.store.tabs.update(tabId, { lastError: message });
		if (this.plugin.store.tabs.activeTabId !== tabId) return;
		this.renderErrorState(message, options?.suggestProxy ?? false);
		this.updateStatus();
	}

	private renderErrorState(message: string, suggestProxy: boolean): void {
		this.pageEl.empty();
		const box = this.pageEl.createDiv({ cls: 'bfm-error' });
		const icon = box.createDiv({ cls: 'bfm-error-icon' });
		setIcon(icon, 'alert-triangle');
		box.createEl('p', { cls: 'bfm-error-message', text: message });
		if (suggestProxy) {
			box.createEl('p', {
				cls: 'bfm-error-hint',
				text: 'Many sites block being embedded. Try loading it through the proxy instead.',
			});
			const retry = box.createEl('button', { cls: 'mod-cta', text: 'Retry with proxy' });
			retry.addEventListener('click', () => this.toggleProxy(true));
		}
		const settings = this.plugin.settings.openExternalLinksInSystemBrowser;
		const external = box.createEl('button', { text: 'Open in system browser' });
		external.addEventListener('click', () => {
			const tab = this.plugin.store.tabs.active;
			if (tab) this.openExternal(tab.displayUrl);
		});
		if (settings) {
			box.createEl('p', {
				cls: 'bfm-error-hint',
				text: 'External links are set to open in your system browser.',
			});
		}
	}

	private handleBridgeNavigate(url: string, options?: NavigateOptions): void {
		const isPost = !!options?.method && options.method.toUpperCase() !== 'GET';
		this.navigate(url, {
			...options,
			renderMode: isPost ? 'proxy' : undefined,
		});
	}

	private handleCookie(raw: string, url: string): void {
		if (!this.plugin.settings.enableCookies) return;
		const cookie = parseCookieString(raw, hostOf(url));
		if (!cookie) return;
		this.plugin.store.writeCookie(cookie);
		this.renderer?.setCookies(this.plugin.store.cookies);
		this.updateStatus();
	}

	// --- Public commands -----------------------------------------------------

	navigate(input: string, options: LoadRequest = {}): void {
		const normalized = normalizeInput(input, this.plugin.settings.searchTemplate);
		if (!normalized) return;
		const tab = this.plugin.store.tabs.active;
		if (!tab) {
			this.newTab(normalized);
			return;
		}
		const mode: RenderMode =
			options.renderMode ?? (this.plugin.settings.preferProxy ? 'proxy' : 'direct');
		const isPost = !!options.method && options.method.toUpperCase() !== 'GET';
		const renderMode: RenderMode = isPost ? 'proxy' : mode;

		this.plugin.store.tabs.update(tab.id, {
			url: normalized,
			displayUrl: normalized,
			renderMode,
			proxied: renderMode === 'proxy',
			lastError: null,
			title: hostOf(normalized) || normalized,
		});
		if (!options.noHistory) {
			this.plugin.store.tabs.recordNavigation(tab.id, normalized);
			this.plugin.store.addHistory(normalized, hostOf(normalized) || normalized);
		}
		this.plugin.store.markDirty();
		this.addressEl.value = normalized;
		this.renderActiveTab();
	}

	private newTab(url?: string): void {
		const target = url ? normalizeInput(url, this.plugin.settings.searchTemplate) : '';
		const tab = this.plugin.store.tabs.create({
			url: target,
			displayUrl: target,
			renderMode: this.plugin.settings.preferProxy ? 'proxy' : 'direct',
			proxied: this.plugin.settings.preferProxy,
		});
		this.plugin.store.markDirty();
		this.addressEl.value = target;
		void tab;
		this.renderActiveTab();
	}

	closeTab(id?: string): void {
		const tabId = id ?? this.plugin.store.tabs.activeTabId;
		if (!tabId) return;
		this.plugin.store.tabs.remove(tabId);
		this.plugin.store.markDirty();
		if (this.plugin.store.tabs.count === 0) {
			this.newTab(this.plugin.settings.homePage);
			return;
		}
		this.renderActiveTab();
	}

	nextTab(): void {
		const store = this.plugin.store.tabs;
		const index = store.indexOf(store.activeTabId ?? '');
		if (index < 0 || store.count < 2) return;
		const next = store.tabs[(index + 1) % store.count];
		if (next) {
			store.activate(next.id);
			this.renderActiveTab();
		}
	}

	prevTab(): void {
		const store = this.plugin.store.tabs;
		const index = store.indexOf(store.activeTabId ?? '');
		if (index < 0 || store.count < 2) return;
		const prev = store.tabs[(index - 1 + store.count) % store.count];
		if (prev) {
			store.activate(prev.id);
			this.renderActiveTab();
		}
	}

	goBack(): void {
		const store = this.plugin.store.tabs;
		const tab = store.active;
		if (!tab) return;
		const url = store.back(tab.id);
		if (url) this.loadHistoryEntry(url);
	}

	goForward(): void {
		const store = this.plugin.store.tabs;
		const tab = store.active;
		if (!tab) return;
		const url = store.forward(tab.id);
		if (url) this.loadHistoryEntry(url);
	}

	private loadHistoryEntry(url: string): void {
		const tab = this.plugin.store.tabs.active;
		if (!tab) return;
		const renderMode: RenderMode = this.plugin.settings.preferProxy ? 'proxy' : tab.renderMode;
		this.plugin.store.tabs.update(tab.id, {
			url,
			displayUrl: url,
			renderMode,
			proxied: renderMode === 'proxy',
			lastError: null,
			title: hostOf(url) || url,
		});
		this.plugin.store.markDirty();
		this.addressEl.value = url;
		this.renderActiveTab();
	}

	reload(): void {
		const tab = this.plugin.store.tabs.active;
		if (!tab) return;
		void this.mountRenderer(tab);
	}

	toggleProxy(force?: boolean): void {
		const tab = this.plugin.store.tabs.active;
		if (!tab) return;
		const next: RenderMode = force ?? tab.renderMode !== 'proxy' ? 'proxy' : 'direct';
		this.plugin.store.tabs.update(tab.id, {
			renderMode: next,
			proxied: next === 'proxy',
			lastError: null,
		});
		this.plugin.store.markDirty();
		this.renderActiveTab();
	}

	toggleBookmark(): void {
		const tab = this.plugin.store.tabs.active;
		if (!tab) return;
		const added = this.plugin.store.toggleBookmark(tab.displayUrl, tab.title);
		new Notice(added ? 'Bookmark added.' : 'Bookmark removed.');
		this.updateToolbar();
	}

	openHistory(): void {
		new HistoryModal(this.app, this.plugin.store, (entry) => this.navigate(entry.url)).open();
	}

	openBookmarks(): void {
		new BookmarkModal(this.app, this.plugin.store, (entry) => this.navigate(entry.url)).open();
	}

	openCookieManager(): void {
		new CookieManagerModal(this.app, this.plugin.store).open();
	}

	goHome(): void {
		this.navigate(this.plugin.settings.homePage);
	}

	focusAddressBar(): void {
		this.addressEl.focus();
		this.addressEl.select();
	}

	clearBrowsingData(): void {
		const run = () => {
			this.plugin.store.clearHistory();
			this.plugin.store.clearAllCookies();
			this.reload();
			new Notice('History and cookies cleared.');
		};
		if (this.plugin.settings.confirmDestructiveActions) {
			new ConfirmModal(
				this.app,
				'Clear all browsing history and cookies? This cannot be undone.',
				run,
			).open();
		} else {
			run();
		}
	}

	openExternal(url: string): void {
		if (!url) return;
		window.open(url, '_blank');
	}

	// --- Helpers used by commands -------------------------------------------

	get isLoading(): boolean {
		return this.loading;
	}

	suggestProxyForActiveTab(): void {
		const tab = this.plugin.store.tabs.active;
		if (!tab) return;
		new ProxyFallbackModal(this.app, tab.displayUrl, () => this.toggleProxy(true)).open();
	}
}

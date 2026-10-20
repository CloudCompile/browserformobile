import { ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from 'obsidian';
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
import { probeFramePolicy } from './proxy';
import { Sheet } from './sheet';
import type { RenderMode, TabState } from './types';
import { displayUrl, hostOf, normalizeInput } from './utils';
import { keyboardInset } from './viewport';

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
	private rootEl!: HTMLElement;
	private backButton!: HTMLButtonElement;
	private forwardButton!: HTMLButtonElement;
	private tabCountButton!: HTMLButtonElement;
	private tabCountBadge!: HTMLElement;
	private bookmarkButton!: HTMLButtonElement;
	/** The proxy toggle now lives in the menu sheet, so it only exists while that is open. */
	private proxyButton: HTMLElement | null = null;
	private renderer: Renderer | null = null;
	private loading = false;
	/** Tab ids whose current page raised a script error. Non-fatal, but shown in the status bar. */
	private readonly pageErrors = new Set<string>();
	/** `tabId|url` pairs already auto-retried through the proxy, so a failure cannot loop. */
	private readonly autoProxied = new Set<string>();
	/** Bumped on every render so a slow framing preflight cannot clobber a newer load. */
	private renderToken = 0;
	/** Open bottom sheet, so a second one cannot stack on the first. */
	private sheet: Sheet | null = null;
	/** Removes the keyboard listeners added in `watchKeyboard`. */
	private visualViewportHandler: (() => void) | null = null;

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
		this.sheet?.close();
		this.sheet = null;
		if (this.visualViewportHandler) {
			window.visualViewport?.removeEventListener('resize', this.visualViewportHandler);
			window.visualViewport?.removeEventListener('scroll', this.visualViewportHandler);
			window.removeEventListener('resize', this.visualViewportHandler);
			this.visualViewportHandler = null;
		}
		this.unmountRenderer();
	}

	// --- UI construction -----------------------------------------------------

	private buildUi(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('bfm-root');
		this.rootEl = root;

		// The address row sits at the top: back/forward, the address field, and the
		// overflow button. Primary navigation lives in the bottom bar instead, so a
		// phone gets the row back for the page.
		const toolbar = root.createDiv({ cls: 'bfm-toolbar' });
		const navGroup = toolbar.createDiv({ cls: 'bfm-toolbar-group' });

		this.backButton = this.iconButton(navGroup, 'arrow-left', 'Back', () => this.goBack());
		this.forwardButton = this.iconButton(navGroup, 'arrow-right', 'Forward', () =>
			this.goForward(),
		);

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
		this.iconButton(actionGroup, 'more-vertical', 'More options', () => this.openMenuSheet());

		this.tabsEl = root.createDiv({ cls: 'bfm-tabs' });
		this.pageEl = root.createDiv({ cls: 'bfm-content' });

		// Bottom bar: thumb-reachable actions that do not duplicate the top row,
		// plus the status line and the tab count.
		const bottom = root.createDiv({ cls: 'bfm-bottom' });
		const bottomRow = bottom.createDiv({ cls: 'bfm-bottom-row' });
		this.iconButton(bottomRow, 'rotate-cw', 'Reload', () => this.reload());
		this.bookmarkButton = this.iconButton(bottomRow, 'star', 'Bookmark this page', () =>
			this.toggleBookmark(),
		);
		this.tabCountButton = this.iconButton(bottomRow, 'layers', 'Tabs', () =>
			this.openTabSheet(),
		);
		this.tabCountButton.addClass('bfm-tab-count-button');
		this.tabCountBadge = this.tabCountButton.createSpan({ cls: 'bfm-tab-count' });
		this.iconButton(bottomRow, 'home', 'Home page', () => this.goHome());
		this.iconButton(bottomRow, 'external-link', 'Open in system browser', () => {
			const tab = this.plugin.store.tabs.active;
			if (tab) this.openExternal(tab.displayUrl);
		});

		this.statusEl = bottom.createDiv({ cls: 'bfm-status' });

		this.watchKeyboard();
	}

	/**
	 * Keep the bottom bar above the soft keyboard. The keyboard shrinks the visual
	 * viewport without resizing the layout, so without this the bar is drawn under
	 * the keyboard; the covered height is published as `--bfm-keyboard-inset` for
	 * the CSS to consume. Listens on both `visualViewport` and `window` because
	 * older WebViews only fire the latter.
	 */
	private watchKeyboard(): void {
		const update = () => {
			const layout = window.innerHeight || document.documentElement.clientHeight;
			const inset = keyboardInset(window.visualViewport, layout);
			this.rootEl.setCssProps({ '--bfm-keyboard-inset': `${inset}px` });
		};
		this.visualViewportHandler = update;
		window.visualViewport?.addEventListener('resize', update);
		window.visualViewport?.addEventListener('scroll', update);
		window.addEventListener('resize', update);
		update();
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
		const canBack = !!tab && store.canGoBack(tab.id);
		const canForward = !!tab && store.canGoForward(tab.id);
		this.backButton.disabled = !canBack;
		this.forwardButton.disabled = !canForward;
		const bookmarked = tab ? this.plugin.store.isBookmarked(tab.displayUrl) : false;
		this.bookmarkButton.toggleClass('is-active', bookmarked);
		// The proxy toggle only exists while the menu sheet is open; keep it in sync
		// if it is.
		this.proxyButton?.toggleClass('is-active', tab?.renderMode === 'proxy');
		const count = store.count;
		this.tabCountBadge.setText(String(count));
		this.tabCountButton.setAttribute('aria-label', `${count} tab${count === 1 ? '' : 's'}`);
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
		const base = `${mode} · ${host} · ${cookieCount} cookies`;
		// A page script error is not fatal, but it is worth surfacing so a page that
		// half-renders is not mistaken for one that loaded cleanly.
		this.statusEl.setText(this.pageErrors.has(tab.id) ? `${base} · page error` : base);
	}

	private async mountRenderer(tab: TabState): Promise<void> {
		this.unmountRenderer();
		this.pageEl.empty();
		this.pageErrors.delete(tab.id);
		this.loading = true;
		const token = ++this.renderToken;
		this.statusEl.setText(
			tab.renderMode === 'proxy' ? 'Loading through proxy…' : 'Loading…',
		);

		let renderMode = tab.renderMode;

		// A refused embed cannot be detected after the fact: a blocked frame and an
		// allowed cross-origin frame both fire `load` and expose an opaque
		// `contentDocument`. Without this check the browser renders
		// `ERR_BLOCKED_BY_RESPONSE` inside the frame and the page looks dead. Check
		// the framing headers up front and switch to the proxy instead.
		if (renderMode === 'direct') {
			const policy = await probeFramePolicy(tab.url);
			// The user may have navigated or switched tabs while we waited.
			if (token !== this.renderToken) return;
			if (policy.blocked) {
				if (this.plugin.settings.proxyBase) {
					renderMode = 'proxy';
					this.plugin.store.tabs.update(tab.id, {
						renderMode: 'proxy',
						proxied: true,
					});
					this.plugin.store.markDirty();
					this.updateToolbar();
					this.statusEl.setText('Loading through proxy…');
					new Notice(
						`${policy.reason ?? 'This site refuses to be embedded.'} Loading it through the proxy instead.`,
					);
				} else {
					this.loading = false;
					this.handleError(
						tab.id,
						policy.reason ?? 'This site refuses to be embedded inside Obsidian.',
						{ suggestProxy: false },
					);
					return;
				}
			}
		}

		const useProxy = renderMode === 'proxy';
		const context = {
			container: this.pageEl,
			url: tab.url,
			displayUrl: tab.displayUrl,
			cookies: this.plugin.settings.enableCookies ? this.plugin.store.cookies : [],
			proxyBase: this.plugin.settings.proxyBase,
			directFetch: this.plugin.settings.directFetch,
			runScripts: this.plugin.settings.runScripts,
			events: {
				onTitle: (title: string) => this.handleTitle(tab.id, title),
				onError: (message: string, options?: { suggestProxy?: boolean }) =>
					this.handleError(tab.id, message, options),
				onPageError: () => this.handlePageError(),
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
		const tab = this.plugin.store.tabs.get(tabId);
		// A direct load that fails cannot be diagnosed from the host: a blocked frame
		// and an allowed cross-origin frame both fire `load` with an opaque
		// `contentDocument`, and the native client strips the framing headers, so
		// neither runtime inspection nor a header preflight can tell them apart.
		// Retry through the proxy once rather than dead-ending on a manual click.
		if (
			tab &&
			options?.suggestProxy &&
			tab.renderMode === 'direct' &&
			this.plugin.settings.proxyBase &&
			!this.autoProxied.has(`${tabId}|${tab.url}`)
		) {
			this.autoProxied.add(`${tabId}|${tab.url}`);
			if (this.plugin.store.tabs.activeTabId === tabId) {
				new Notice('Direct loading failed. Retrying through the proxy…');
			}
			this.plugin.store.tabs.update(tabId, {
				renderMode: 'proxy',
				proxied: true,
				lastError: null,
			});
			this.plugin.store.markDirty();
			if (this.plugin.store.tabs.activeTabId === tabId) {
				this.updateToolbar();
				this.renderActiveTab();
			}
			return;
		}
		if (this.plugin.store.tabs.activeTabId !== tabId) return;
		this.renderErrorState(message, options?.suggestProxy ?? false);
		this.updateStatus();
	}

	/**
	 * A script error raised by the page itself. The document is already on
	 * screen, so this is reported without replacing it — a page that rendered
	 * correctly must not be blanked because one of its scripts threw.
	 */
	private handlePageError(): void {
		const tab = this.plugin.store.tabs.active;
		if (!tab) return;
		this.pageErrors.add(tab.id);
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
		// Keep proxied pages in proxy mode: a proxied page's own links and forms
		// point at the real site, which would fail to embed if we switched back to
		// direct rendering. POST always needs the proxy.
		const current = this.plugin.store.tabs.active?.renderMode ?? 'direct';
		this.navigate(url, {
			...options,
			renderMode: isPost ? 'proxy' : current,
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
		const mode: RenderMode = options.renderMode ?? this.defaultRenderMode();
		const isPost = !!options.method && options.method.toUpperCase() !== 'GET';
		const renderMode: RenderMode = isPost ? 'proxy' : mode;

		// A fresh navigation earns a fresh chance at direct mode.
		for (const key of this.autoProxied) {
			if (key.startsWith(`${tab.id}|`)) this.autoProxied.delete(key);
		}

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

	/**
	 * The renderer a fresh tab should start with. "Fetch pages directly" off means
	 * every request goes through the proxy, so the proxy renderer is required
	 * regardless of the "always use proxy" preference.
	 */
	private defaultRenderMode(): RenderMode {
		if (!this.plugin.settings.directFetch) return 'proxy';
		if (this.plugin.settings.preferProxy) return 'proxy';
		// Mobile WebView enforces X-Frame-Options and CSP frame-ancestors, so a
		// site that refuses framing renders as a browser error page. That refusal
		// cannot be detected from the host — a blocked frame and an allowed
		// cross-origin frame both fire `load` and expose an opaque
		// `contentDocument` — and the native client strips the framing headers, so
		// there is nothing to preflight either. Start on the proxy, which always
		// renders, rather than showing the user a dead frame. Desktop Electron
		// ignores framing headers, so direct mode stays the better default there.
		if (Platform.isMobile) return 'proxy';
		return 'direct';
	}

	private newTab(url?: string): void {
		const target = url ? normalizeInput(url, this.plugin.settings.searchTemplate) : '';
		const renderMode = this.defaultRenderMode();
		const tab = this.plugin.store.tabs.create({
			url: target,
			displayUrl: target,
			renderMode,
			proxied: renderMode === 'proxy',
		});
		this.plugin.store.markDirty();
		this.addressEl.value = target;
		void tab;
		this.renderActiveTab();
	}

	closeTab(id?: string): void {
		const tabId = id ?? this.plugin.store.tabs.activeTabId;
		if (!tabId) return;
		this.pageErrors.delete(tabId);
		for (const key of this.autoProxied) {
			if (key.startsWith(`${tabId}|`)) this.autoProxied.delete(key);
		}
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

	// --- Bottom sheets -------------------------------------------------------

	/** Replace any open sheet, so two cannot stack. */
	private openSheet(title?: string): Sheet {
		this.sheet?.close();
		const sheet = new Sheet(this.rootEl, title);
		this.sheet = sheet;
		sheet.onDismiss(() => {
			if (this.sheet === sheet) this.sheet = null;
			this.proxyButton = null;
		});
		return sheet;
	}

	/**
	 * The overflow menu. Holds the actions that no longer fit in the bottom bar:
	 * history, bookmarks, cookies, home, the proxy toggle, and clear data.
	 */
	openMenuSheet(): void {
		const sheet = this.openSheet('Menu');
		sheet.addRow('history', 'History', () => this.openHistory());
		sheet.addRow('bookmark', 'Bookmarks', () => this.openBookmarks());
		sheet.addRow('cookie', 'Cookies', () => this.openCookieManager());
		sheet.addRow('home', 'Home page', () => this.goHome());

		const tab = this.plugin.store.tabs.active;
		const proxyRow = sheet.addRow(
			'shield',
			tab?.renderMode === 'proxy' ? 'Proxy rendering: on' : 'Proxy rendering: off',
			() => this.toggleProxy(),
		);
		proxyRow.addClass('bfm-sheet-row-toggle');
		if (tab?.renderMode === 'proxy') proxyRow.addClass('is-active');
		this.proxyButton = proxyRow;

		sheet.addRow('globe', 'Open in system browser', () => {
			const active = this.plugin.store.tabs.active;
			if (active) this.openExternal(active.displayUrl);
		});
		sheet.addRow('trash', 'Clear browsing data', () => this.clearBrowsingData(), {
			danger: true,
		});
	}

	/**
	 * The tab switcher. A list of every tab with its title, a close control, and a
	 * new-tab row — the phone-native alternative to the scrolling tab strip, which
	 * is hidden on narrow screens.
	 */
	openTabSheet(): void {
		const sheet = this.openSheet('Tabs');
		const store = this.plugin.store.tabs;
		for (const tab of store.tabs) {
			const row = sheet.body.createDiv({ cls: 'bfm-sheet-tab' });
			if (tab.id === store.activeTabId) row.addClass('is-active');
			const icon = row.createSpan({ cls: 'bfm-sheet-tab-icon' });
			setIcon(icon, 'globe');
			const label = row.createSpan({
				cls: 'bfm-sheet-tab-label',
				text: tab.title || displayUrl(tab.displayUrl, 60) || 'New tab',
			});
			label.setAttribute('title', tab.displayUrl);
			row.addEventListener('click', () => {
				sheet.close();
				store.activate(tab.id);
				this.renderActiveTab();
			});
			const close = row.createSpan({ cls: 'bfm-sheet-tab-close' });
			setIcon(close, 'x');
			close.setAttribute('title', 'Close tab');
			close.addEventListener('click', (event) => {
				event.stopPropagation();
				this.closeTab(tab.id);
				sheet.close();
			});
		}
		const add = sheet.body.createDiv({ cls: 'bfm-sheet-tab is-new' });
		const addIcon = add.createSpan({ cls: 'bfm-sheet-tab-icon' });
		setIcon(addIcon, 'plus');
		add.createSpan({ cls: 'bfm-sheet-tab-label', text: 'New tab' });
		add.addEventListener('click', () => {
			sheet.close();
			this.newTab(this.plugin.settings.homePage);
		});
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

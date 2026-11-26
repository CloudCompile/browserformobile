import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import type AnimePlugin from '../main';
import { BROWSER_VIEW_TYPE } from './config';
import {
	downloadPercent,
	downloadSpeed,
	downloadSummary,
	type BrowserDownloadJob,
} from './downloads';
import type { BrowserNavSpec, BrowserTabHandle } from './engine';
import { decodeText } from './http';
import {
	filenameFromUrl,
	kindForUrl,
	mediaFromDocument,
	mediaItemForUrl,
	normalizeBrowserInput,
	type BrowserMediaItem,
} from './media';
import {
	BrowserBookmarksModal,
	BrowserMediaModal,
	MediaPickerModal,
} from './dialogs';

interface BrowserTab {
	id: string;
	title: string;
	url: string;
	frame: HTMLIFrameElement;
	mediaEl: HTMLElement;
	mode: 'frame' | 'media';
	hist: BrowserNavSpec[];
	idx: number;
	token: number;
	loading: boolean;
	blobUrl: string | null;
	media: BrowserMediaItem[];
}

export class BrowserView extends ItemView {
	private readonly plugin: AnimePlugin;
	private tabs: BrowserTab[] = [];
	private active: BrowserTab | null = null;
	private seq = 0;
	private tabsEl!: HTMLElement;
	private bar!: HTMLElement;
	private framesEl!: HTMLElement;
	private downloadsEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private input!: HTMLInputElement;
	private backBtn!: HTMLButtonElement;
	private fwdBtn!: HTMLButtonElement;
	private starBtn!: HTMLButtonElement;
	private mediaBtn!: HTMLButtonElement;
	private unsubscribe: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: AnimePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return BROWSER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Browser';
	}

	getIcon(): string {
		return 'globe';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('bfm-browser-view');
		this.tabsEl = this.contentEl.createDiv({ cls: 'bfm-browser-tabs' });
		this.bar = this.contentEl.createDiv({ cls: 'bfm-browser-bar' });
		this.backBtn = this.mkButton('arrow-left', 'Back', () => this.go(-1));
		this.fwdBtn = this.mkButton('arrow-right', 'Forward', () => this.go(1));
		this.mkButton('rotate-cw', 'Reload', () => {
			if (this.active) void this.loadTab(this.active);
		});
		this.input = this.bar.createEl('input', { cls: 'bfm-browser-url', type: 'text' });
		this.input.setAttribute('placeholder', 'Search or enter address');
		this.input.setAttribute('autocapitalize', 'off');
		this.input.setAttribute('autocorrect', 'off');
		this.input.setAttribute('spellcheck', 'false');
		this.input.setAttribute('enterkeyhint', 'go');
		this.input.addEventListener('focus', () => this.input.select());
		this.input.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			const url = normalizeBrowserInput(this.input.value, this.plugin.browserEngine.searchUrl());
			if (!url || !this.active) return;
			void this.navigate(this.active, { url });
			this.input.blur();
		});
		this.starBtn = this.mkButton('star', 'Bookmark', () => this.toggleBookmark());
		this.mediaBtn = this.mkButton('download', 'Download media', () => this.openMediaPicker());
		this.mkButton('more-vertical', 'Browser menu', (event) => this.openMenu(event));
		this.progressEl = this.contentEl.createDiv({ cls: 'bfm-browser-progress' });
		this.framesEl = this.contentEl.createDiv({ cls: 'bfm-browser-frames' });
		this.downloadsEl = this.contentEl.createDiv({ cls: 'bfm-browser-downloads' });
		this.unsubscribe = this.plugin.browserDownloads.subscribe(() => this.renderDownloads());
		this.renderDownloads();
		this.newTab();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		for (const tab of this.tabs) {
			this.plugin.browserEngine.unregisterTab(tab.id);
			if (tab.blobUrl) URL.revokeObjectURL(tab.blobUrl);
			tab.frame.remove();
			tab.mediaEl.remove();
		}
		this.tabs = [];
		this.active = null;
		this.contentEl.empty();
	}

	private mkButton(
		icon: string,
		label: string,
		onClick: (event: MouseEvent) => void,
	): HTMLButtonElement {
		const button = this.bar.createEl('button', { cls: 'bfm-browser-button' });
		button.setAttribute('aria-label', label);
		button.setAttribute('title', label);
		setIcon(button, icon);
		button.addEventListener('click', (event) => onClick(event));
		return button;
	}

	private openMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('New tab')
				.setIcon('plus')
				.onClick(() => this.newTab()),
		);
		menu.addItem((item) =>
			item
				.setTitle('Home')
				.setIcon('home')
				.onClick(() => {
											if (this.active) void this.navigate(this.active, { home: true });
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle('Bookmarks')
				.setIcon('bookmark')
				.onClick(() => this.openBookmarks()),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Download from URL')
				.setIcon('download')
				.onClick(() => this.plugin.openBrowserDownload({ referer: this.active?.url })),
		);
		menu.addItem((item) =>
			item
				.setTitle('Open in system browser')
				.setIcon('external-link')
				.onClick(() => {
					if (this.active?.url) this.plugin.browserEngine.openExternal(this.active.url);
				}),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Close tab')
				.setIcon('x')
				.onClick(() => {
					if (this.active) this.closeTab(this.active);
				}),
		);
		menu.showAtMouseEvent(event);
	}

	newTab(spec?: BrowserNavSpec): BrowserTab {
		const id = `b${++this.seq}`;
		const frame = this.framesEl.createEl('iframe', { cls: 'bfm-browser-frame' });
		frame.setAttribute(
			'allow',
			'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-read; clipboard-write',
		);
		frame.setAttribute('allowfullscreen', 'true');
		const mediaEl = this.framesEl.createDiv({ cls: 'bfm-browser-media' });
		const tab: BrowserTab = {
			id,
			title: 'New tab',
			url: '',
			frame,
			mediaEl,
			mode: 'frame',
			hist: [],
			idx: -1,
			token: 0,
			loading: false,
			blobUrl: null,
			media: [],
		};
		this.tabs.push(tab);
		const handle: BrowserTabHandle = {
			handleNav: (next) => this.handleNav(tab, next),
			addMedia: (item) => this.addMedia(tab, item),
			setTitle: (title) => {
				if (!title) return;
				tab.title = title;
				if (this.active === tab) this.refresh();
			},
		};
		this.plugin.browserEngine.registerTab(id, handle);
		this.switchTo(tab);
		void this.navigate(tab, spec ?? { home: true });
		return tab;
	}

	private switchTo(tab: BrowserTab): void {
		this.active = tab;
		for (const other of this.tabs) {
			other.frame.toggleClass('is-active', other === tab && other.mode === 'frame');
			other.mediaEl.toggleClass('is-active', other === tab && other.mode === 'media');
		}
		this.refresh();
	}

	private closeTab(tab: BrowserTab): void {
		const index = this.tabs.indexOf(tab);
		if (index < 0) return;
		this.plugin.browserEngine.unregisterTab(tab.id);
		if (tab.blobUrl) URL.revokeObjectURL(tab.blobUrl);
		tab.frame.remove();
		tab.mediaEl.remove();
		this.tabs.splice(index, 1);
		if (this.tabs.length === 0) {
			this.newTab();
			return;
		}
		if (this.active === tab) {
			const next = this.tabs[Math.max(0, index - 1)] ?? this.tabs[0];
			if (next) this.switchTo(next);
			else this.newTab();
		} else this.refresh();
	}

	private handleNav(tab: BrowserTab, spec: BrowserNavSpec): void {
		if (spec.newTab) {
			this.newTab({ ...spec, newTab: false });
			return;
		}
		void this.navigate(tab, spec);
	}

	private async navigate(tab: BrowserTab, spec: BrowserNavSpec): Promise<void> {
		tab.hist = tab.hist.slice(0, tab.idx + 1);
		tab.hist.push(spec);
		tab.idx = tab.hist.length - 1;
		await this.loadTab(tab);
	}

	private go(delta: number): void {
		const tab = this.active;
		if (!tab) return;
		const index = tab.idx + delta;
		if (index < 0 || index >= tab.hist.length) return;
		tab.idx = index;
		void this.loadTab(tab);
	}

	private async loadTab(tab: BrowserTab): Promise<void> {
		const spec = tab.hist[tab.idx];
		if (!spec) return;
		const token = ++tab.token;
		tab.loading = true;
		tab.media = [];
		tab.mediaEl.empty();
		if (spec.home) {
			tab.url = '';
			tab.title = 'Home';
			this.showHtml(tab, this.plugin.browserEngine.homeHtml(tab.id));
			tab.loading = false;
			this.refresh();
			return;
		}
		const url = spec.url;
		if (!url) {
			tab.loading = false;
			this.refresh();
			return;
		}
		tab.url = url;
		this.refresh();

		// Direct media is handed to a native element instead of being fetched
		// whole. That is both the memory-safe path and the one that plays video
		// reliably: the iframe's CSP and codec environment no longer apply.
		const directKind = kindForUrl(url);
		if (directKind === 'video' || directKind === 'audio' || directKind === 'image' || directKind === 'hls') {
			tab.title = filenameFromUrl(url);
			const item: BrowserMediaItem = { url, kind: directKind, title: tab.title };
			this.showMedia(tab, item);
			tab.loading = false;
			this.refresh();
			return;
		}

		try {
			const response = await this.plugin.browserEngine.request({
				url,
				method: spec.method || 'GET',
				headers: {
					accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'upgrade-insecure-requests': '1',
					...(spec.headers ?? {}),
				},
				body: spec.body ?? null,
			});
			if (token !== tab.token) return;
			tab.url = response.url || url;
			const contentType = response.headers['content-type'] || '';
			if (!contentType || /html|xhtml/i.test(contentType)) {
				const built = this.plugin.browserEngine.buildDoc(
					decodeText(response.bytes, contentType),
					tab.url,
					tab.id,
				);
				if (this.plugin.settings.browserInline) {
					await this.plugin.browserEngine.inlineResources(built.doc, built.baseUrl, tab.url);
				}
				if (token !== tab.token) return;
				tab.title = built.title || hostOf(tab.url);
				this.showHtml(tab, this.plugin.browserEngine.serialize(built.doc));
			} else {
				const kind = kindForUrl(tab.url, contentType);
				tab.title = filenameFromUrl(tab.url);
				if (kind !== 'file') {
					const item: BrowserMediaItem = { url: tab.url, kind, title: tab.title, mime: contentType };
					this.showMedia(tab, item);
				} else {
					this.showBlob(tab, response.bytes, contentType);
				}
			}
		} catch (error) {
			if (token !== tab.token) return;
			tab.title = 'Error';
			this.showHtml(tab, this.plugin.browserEngine.errorHtml(url, error));
		} finally {
			if (token === tab.token) {
				tab.loading = false;
				this.refresh();
			}
		}
	}

	private showHtml(tab: BrowserTab, html: string): void {
		this.clearBlob(tab);
		tab.mode = 'frame';
		tab.mediaEl.empty();
		tab.mediaEl.removeClass('is-active');
		tab.frame.addClass('is-active');
		tab.frame.removeAttribute('src');
		// A changing comment forces a reload even when the document is identical.
		tab.frame.srcdoc = html.replace('<!DOCTYPE html>', `<!DOCTYPE html><!--${Date.now()}-->`);
	}

	private showBlob(tab: BrowserTab, bytes: Uint8Array, type: string): void {
		this.clearBlob(tab);
		tab.mode = 'frame';
		tab.mediaEl.empty();
		tab.mediaEl.removeClass('is-active');
		tab.frame.addClass('is-active');
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		tab.blobUrl = URL.createObjectURL(new Blob([buffer], { type }));
		tab.frame.removeAttribute('srcdoc');
		tab.frame.src = tab.blobUrl;
	}

	private showMedia(tab: BrowserTab, item: BrowserMediaItem): void {
		this.clearBlob(tab);
		tab.mode = 'media';
		tab.frame.removeClass('is-active');
		tab.mediaEl.addClass('is-active');
		tab.mediaEl.empty();
		tab.media = [item];
		if (item.kind === 'hls') {
			this.mediaMessage(
				tab,
				item,
				'HLS playlist detected. Download it to convert the stream to a playable MP4.',
			);
			return;
		}
		if (item.kind === 'video') {
			const video = tab.mediaEl.createEl('video', { cls: 'bfm-browser-video' });
			video.controls = true;
			video.autoplay = true;
			video.setAttribute('playsinline', '');
			video.setAttribute('webkit-playsinline', '');
			video.src = item.url;
			video.addEventListener('error', () => {
				this.mediaMessage(
					tab,
					item,
					'This browser could not play the video directly. Download it, then play it from the downloads tray, or open it in the system browser.',
				);
			});
			return;
		}
		if (item.kind === 'audio') {
			const audio = tab.mediaEl.createEl('audio', { cls: 'bfm-browser-audio' });
			audio.controls = true;
			audio.autoplay = true;
			audio.src = item.url;
			return;
		}
		const image = tab.mediaEl.createEl('img', { cls: 'bfm-browser-image' });
		image.src = item.url;
		image.addEventListener('error', () => {
			this.mediaMessage(tab, item, 'This image could not be loaded. Try downloading it instead.');
		});
		this.refresh();
	}

	private mediaMessage(tab: BrowserTab, item: BrowserMediaItem, message: string): void {
		tab.mediaEl.empty();
		const card = tab.mediaEl.createDiv({ cls: 'bfm-browser-media-message' });
		card.createEl('strong', { text: item.title || 'Media' });
		card.createEl('p', { text: message });
		const actions = card.createDiv({ cls: 'bfm-browser-media-actions' });
		const download = actions.createEl('button', { cls: 'mod-cta', text: 'Download' });
		download.addEventListener('click', () => this.enqueue([item], this.plugin.settings.browserDownloadFolder));
		const external = actions.createEl('button', { text: 'Open in system browser' });
		external.addEventListener('click', () => this.plugin.browserEngine.openExternal(item.url));
		if (item.kind !== 'image') {
			const playLater = actions.createEl('button', { text: 'Download and play' });
			playLater.addEventListener('click', () => this.playAfterDownload(item));
		}
	}

	private clearBlob(tab: BrowserTab): void {
		if (tab.blobUrl) {
			URL.revokeObjectURL(tab.blobUrl);
			tab.blobUrl = null;
		}
	}

	private addMedia(tab: BrowserTab, item: BrowserMediaItem): void {
		if (!item.url || tab.media.some((entry) => entry.url === item.url)) return;
		tab.media.push(item);
		if (tab.media.length > 100) tab.media.shift();
		if (this.active === tab) this.mediaBtn.addClass('has-media');
	}

	private collectMedia(tab: BrowserTab): BrowserMediaItem[] {
		const found = new Map<string, BrowserMediaItem>();
		for (const item of tab.media) found.set(item.url, item);
		if (tab.mode === 'frame') {
			try {
				const doc = tab.frame.contentDocument;
				if (doc) {
					for (const item of mediaFromDocument(doc, tab.url)) {
						if (!found.has(item.url)) found.set(item.url, item);
					}
				}
			} catch {
				/* A frame that has navigated away can deny access. */
			}
			const current = mediaItemForUrl(tab.url);
			if (current && !found.has(current.url)) found.set(current.url, current);
		}
		return Array.from(found.values());
	}

	private openMediaPicker(): void {
		const tab = this.active;
		if (!tab) return;
		const items = this.collectMedia(tab);
		new MediaPickerModal(this.app, {
			items,
			folder: this.plugin.settings.browserDownloadFolder,
			pageUrl: tab.url,
			onDownload: (picked, folder) => this.enqueue(picked, folder),
			onPlay: (item) => this.openPlayer(item),
			onDirect: (folder) => {
				this.plugin.openBrowserDownload({ referer: tab.url, folder });
			},
		}).open();
	}

	private openPlayer(item: BrowserMediaItem): void {
		new BrowserMediaModal(this.app, {
			item,
			onDownload: () => this.enqueue([item], this.plugin.settings.browserDownloadFolder),
			onDownloadAndPlay:
				item.kind === 'image' ? undefined : () => this.playAfterDownload(item),
			onExternal: () => this.plugin.browserEngine.openExternal(item.url),
		}).open();
	}

	/** Download first, then open the finished file in the native player. */
	private playAfterDownload(item: BrowserMediaItem): void {
		let job: BrowserDownloadJob;
		try {
			job = this.plugin.enqueueBrowserDownload({
				url: item.url,
				folder: this.plugin.settings.browserDownloadFolder,
				referer: this.active?.url || undefined,
				kind: item.kind,
				filename: item.title,
			});
		} catch (error) {
			new Notice(error instanceof Error ? error.message : 'That video could not be queued.');
			return;
		}
		new Notice('Downloading. Playback starts when it finishes.');
		const unsubscribe = this.plugin.browserDownloads.subscribe(() => {
			if (job.status === 'done') {
				unsubscribe();
				if (job.filePath) void this.plugin.playBrowserFile(job.filePath, job.filename);
			} else if (job.status === 'failed' || job.status === 'cancelled') {
				unsubscribe();
			}
		});
	}

	private enqueue(items: BrowserMediaItem[], folder: string): void {
		let queued = 0;
		for (const item of items) {
			try {
				void this.plugin.enqueueBrowserDownload({
					url: item.url,
					folder,
					referer: this.active?.url || undefined,
					kind: item.kind,
					filename: item.title,
				});
				queued++;
			} catch (error) {
				new Notice(error instanceof Error ? error.message : 'That item could not be queued.');
			}
		}
		if (queued > 0) {
			new Notice(`${queued} download${queued === 1 ? '' : 's'} queued.`);
			this.renderDownloads();
		}
	}

	private toggleBookmark(): void {
		const tab = this.active;
		if (!tab?.url) {
			new Notice('Open a page before bookmarking it.');
			return;
		}
		const added = this.plugin.toggleBrowserBookmark(tab.title, tab.url);
		new Notice(added ? 'Bookmarked.' : 'Bookmark removed.');
		this.refresh();
	}

	private openBookmarks(): void {
		new BrowserBookmarksModal(this.app, {
			bookmarks: this.plugin.browserBookmarks,
			onOpen: (url) => {
				if (this.active) void this.navigate(this.active, { url });
			},
			onRemove: (url) => this.plugin.removeBrowserBookmark(url),
		}).open();
	}

	private refresh(): void {
		this.tabsEl.empty();
		for (const tab of this.tabs) {
			const row = this.tabsEl.createDiv({
				cls: `bfm-browser-tab${tab === this.active ? ' is-active' : ''}`,
			});
			const title = row.createSpan({ cls: 'bfm-browser-tab-title', text: tab.title || 'New tab' });
			title.setAttribute('title', tab.url || tab.title);
			row.addEventListener('click', () => this.switchTo(tab));
			const close = row.createEl('button', {
				cls: 'bfm-browser-tab-close',
				attr: { 'aria-label': 'Close tab' },
			});
			setIcon(close, 'x');
			close.addEventListener('click', (event) => {
				event.stopPropagation();
				this.closeTab(tab);
			});
		}
		const plus = this.tabsEl.createEl('button', { cls: 'bfm-browser-new-tab', attr: { 'aria-label': 'New tab' } });
		setIcon(plus, 'plus');
		plus.addEventListener('click', () => this.newTab());
		const tab = this.active;
		if (!tab) return;
		this.backBtn.disabled = tab.idx <= 0;
		this.fwdBtn.disabled = tab.idx >= tab.hist.length - 1;
		this.bar.toggleClass('is-loading', tab.loading);
		this.progressEl.toggleClass('is-active', tab.loading);
		if (document.activeElement !== this.input) this.input.value = tab.url || '';
		this.starBtn.toggleClass('is-on', Boolean(tab.url) && this.plugin.browserBookmarks.some((bookmark) => bookmark.url === tab.url));
		this.mediaBtn.toggleClass('has-media', tab.media.length > 0);
		this.mediaBtn.disabled = !tab.url && tab.mode === 'frame';
	}

	private renderDownloads(): void {
		if (!this.downloadsEl) return;
		const jobs = this.plugin.browserDownloads.jobs;
		this.downloadsEl.empty();
		this.downloadsEl.toggleClass('is-visible', jobs.length > 0);
		if (jobs.length === 0) return;
		const header = this.downloadsEl.createDiv({ cls: 'bfm-browser-downloads-header' });
		header.createSpan({ text: 'Downloads' });
		const clear = header.createEl('button', { cls: 'bfm-browser-link-button', text: 'Clear finished' });
		clear.addEventListener('click', () => this.plugin.browserDownloads.clearFinished());
		for (const job of jobs.slice(0, 4)) {
			this.renderJob(job);
		}
	}

	private renderJob(job: BrowserDownloadJob): void {
		const row = this.downloadsEl.createDiv({ cls: `bfm-browser-download is-${job.status}` });
		const copy = row.createDiv({ cls: 'bfm-browser-download-copy' });
		const title = copy.createDiv({ cls: 'bfm-browser-download-title', text: job.filename });
		title.setAttribute('title', job.filePath ?? job.url);
		const percent = downloadPercent(job);
		const detail = copy.createDiv({ cls: 'bfm-browser-download-detail' });
		detail.setText(
			[downloadSummary(job), job.status === 'running' ? downloadSpeed(job) : ''].filter(Boolean).join(' · '),
		);
		const track = row.createDiv({ cls: 'bfm-browser-download-track' });
		const fill = track.createDiv({ cls: 'bfm-browser-download-fill' });
		if (percent !== null) fill.setCssProps({ width: `${percent}%` });
		else fill.addClass('is-indeterminate');
		if (job.status === 'done' && job.filePath && /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|aac|ogg|wav|flac)$/i.test(job.filePath)) {
			const path = job.filePath;
			const play = row.createEl('button', {
				cls: 'bfm-browser-icon-button',
				attr: { 'aria-label': `Play ${job.filename}` },
			});
			setIcon(play, 'play');
			play.addEventListener('click', () => void this.plugin.playBrowserFile(path, job.filename));
		}
		if (job.status === 'queued' || job.status === 'running') {
			const cancel = row.createEl('button', {
				cls: 'bfm-browser-icon-button',
				attr: { 'aria-label': `Cancel ${job.filename}` },
			});
			setIcon(cancel, 'x');
			cancel.addEventListener('click', () => this.plugin.browserDownloads.cancel(job.id));
		}
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname || url;
	} catch {
		return url;
	}
}

import { App, Modal, Notice, Setting, setIcon, type TextComponent } from 'obsidian';
import { normalizeDirectUrl, type BrowserBookmark, type BrowserMediaItem } from './media';

interface PickerOptions {
	items: BrowserMediaItem[];
	folder: string;
	pageUrl: string;
	onDownload: (items: BrowserMediaItem[], folder: string) => void;
	onPlay: (item: BrowserMediaItem) => void;
	onDirect: (folder: string) => void;
}

function kindLabel(kind: BrowserMediaItem['kind']): string {
	if (kind === 'hls') return 'HLS stream';
	if (kind === 'video') return 'Video';
	if (kind === 'image') return 'Image';
	if (kind === 'audio') return 'Audio';
	return 'File';
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname || url;
	} catch {
		return url;
	}
}

/** Choose which images, videos and links on the page to save. */
export class MediaPickerModal extends Modal {
	private readonly selected = new Set<string>();
	private folder: string;
	private listEl!: HTMLElement;
	private downloadButton!: HTMLButtonElement;
	private selectAll: HTMLInputElement | null = null;

	constructor(
		app: App,
		private readonly options: PickerOptions,
	) {
		super(app);
		this.folder = options.folder;
		// Preselect a small page's media; on a gallery page, let the user choose.
		if (options.items.length <= 3) {
			for (const item of options.items) this.selected.add(item.url);
		}
	}

	onOpen(): void {
		this.modalEl.addClass('bfm-browser-modal');
		this.titleEl.setText('Download media');
		this.contentEl.addClass('bfm-browser-dialog');
		const imageCount = this.options.items.filter((item) => item.kind === 'image').length;
		const videoCount = this.options.items.filter((item) => item.kind === 'video' || item.kind === 'hls').length;
		const otherCount = this.options.items.length - imageCount - videoCount;
		const summary = [
			imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : '',
			videoCount ? `${videoCount} video${videoCount === 1 ? '' : 's'}` : '',
			otherCount ? `${otherCount} link${otherCount === 1 ? '' : 's'}` : '',
		]
			.filter(Boolean)
			.join(', ');
		this.contentEl.createEl('p', {
			cls: 'bfm-browser-dialog-subtitle',
			text: summary ? `Found ${summary} on this page.` : 'No media was found on this page.',
		});
		const folderField = this.contentEl.createDiv({ cls: 'bfm-browser-field' });
		folderField.createEl('label', { text: 'Save to folder' });
		const folderInput = folderField.createEl('input', {
			cls: 'bfm-browser-input',
			type: 'text',
			value: this.folder,
		});
		folderInput.addEventListener('input', () => {
			this.folder = folderInput.value;
		});
		if (this.options.items.length > 0) {
			const selectRow = this.contentEl.createDiv({ cls: 'bfm-browser-selectall' });
			this.selectAll = selectRow.createEl('input', { type: 'checkbox' });
			this.selectAll.checked = this.selected.size === this.options.items.length;
			this.selectAll.addEventListener('change', () => {
				this.selected.clear();
				if (this.selectAll?.checked) {
					for (const item of this.options.items) this.selected.add(item.url);
				}
				this.renderList();
			});
			selectRow.createSpan({ text: 'Select all' });
		}
		this.listEl = this.contentEl.createDiv({ cls: 'bfm-browser-media-list' });
		this.renderList();
		const actions = this.contentEl.createDiv({ cls: 'bfm-browser-dialog-actions' });
		const direct = actions.createEl('button', { text: 'Download a URL' });
		direct.addEventListener('click', () => {
			this.options.onDirect(this.folder);
			this.close();
		});
		const cancel = actions.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		this.downloadButton = actions.createEl('button', { cls: 'mod-cta', text: 'Download selected' });
		this.downloadButton.addEventListener('click', () => this.download());
		this.updateCount();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderList(): void {
		this.listEl.empty();
		if (this.options.items.length === 0) {
			const empty = this.listEl.createDiv({ cls: 'bfm-browser-empty' });
			empty.createEl('strong', { text: 'Nothing to download here' });
			empty.createEl('p', { text: 'Open a direct file link, or paste one in the download dialog.' });
			this.updateCount();
			return;
		}
		for (const item of this.options.items) {
			const row = this.listEl.createEl('label', {
				cls: `bfm-browser-media-row${this.selected.has(item.url) ? ' is-selected' : ''}`,
			});
			const checkbox = row.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.selected.has(item.url);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) this.selected.add(item.url);
				else this.selected.delete(item.url);
				row.toggleClass('is-selected', checkbox.checked);
				this.updateCount();
			});
			const thumb = row.createDiv({ cls: 'bfm-browser-media-thumb' });
			if (item.kind === 'image' || (item.kind === 'video' && item.poster)) {
				const image = thumb.createEl('img', { attr: { loading: 'lazy', alt: '' } });
				image.src = item.poster || item.url;
				image.addEventListener('error', () => {
					image.remove();
					setIcon(thumb, item.kind === 'image' ? 'image' : 'film');
				});
			} else {
				setIcon(thumb, item.kind === 'video' || item.kind === 'hls' ? 'film' : item.kind === 'audio' ? 'music' : 'file');
			}
			const copy = row.createDiv({ cls: 'bfm-browser-media-copy' });
			copy.createDiv({ cls: 'bfm-browser-media-title', text: item.title || hostOf(item.url) });
			copy.createDiv({
				cls: 'bfm-browser-media-meta',
				text: `${kindLabel(item.kind)} · ${hostOf(item.url)}`,
			});
			if (item.kind === 'video' || item.kind === 'audio' || item.kind === 'image') {
				const play = row.createEl('button', {
					cls: 'bfm-browser-icon-button',
					attr: { 'aria-label': `Play ${item.title || 'media'}` },
				});
				setIcon(play, 'play');
				play.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					this.options.onPlay(item);
				});
			}
		}
		this.updateCount();
	}

	private updateCount(): void {
		const count = this.selected.size;
		this.downloadButton?.setText(count === 0 ? 'Download selected' : `Download ${count} selected`);
		this.downloadButton?.toggleClass('mod-cta', count > 0);
		if (this.selectAll) this.selectAll.checked = count === this.options.items.length;
	}

	private download(): void {
		const items = this.options.items.filter((item) => this.selected.has(item.url));
		if (items.length === 0) {
			new Notice('Select at least one item to download.');
			return;
		}
		this.options.onDownload(items, this.folder);
		this.close();
	}
}

export interface DirectDownloadRequest {
	url: string;
	filename?: string;
	folder: string;
	referer?: string;
}

interface DirectOptions {
	initialUrl?: string;
	referer?: string;
	folder: string;
	onSubmit: (request: DirectDownloadRequest) => void;
}

/** Paste a direct file URL, such as an MP4 or an image, and save it. */
export class CdnDownloadModal extends Modal {
	private urlInput!: TextComponent;
	private filenameInput!: TextComponent;
	private folderInput!: TextComponent;
	private refererInput!: TextComponent;

	constructor(
		app: App,
		private readonly options: DirectOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('bfm-browser-modal');
		this.titleEl.setText('Download from URL');
		this.contentEl.addClass('bfm-browser-dialog');
		this.contentEl.createEl('p', {
			cls: 'bfm-browser-dialog-subtitle',
			text: 'Save a direct file link, such as a video, image, audio file, archive or stream playlist. Web pages are opened in the browser instead.',
		});
		new Setting(this.contentEl)
			.setName('File URL')
			.setDesc('The direct link, not the page that contains it.')
			.addText((text) => {
				this.urlInput = text;
				text.setPlaceholder('https://example.com/video.mp4');
				text.setValue(this.options.initialUrl ?? '');
				text.inputEl.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') this.submit();
				});
			});
		new Setting(this.contentEl)
			.setName('Save as')
			.setDesc('Leave blank to use the name in the URL or the server response.')
			.addText((text) => {
				this.filenameInput = text;
				text.setPlaceholder('video.mp4');
			});
		new Setting(this.contentEl)
			.setName('Folder')
			.setDesc('Inside the vault.')
			.addText((text) => {
				this.folderInput = text;
				text.setValue(this.options.folder);
			});
		new Setting(this.contentEl)
			.setName('Referer')
			.setDesc('Optional. Some servers only allow a file when the request appears to come from their page.')
			.addText((text) => {
				this.refererInput = text;
				text.setValue(this.options.referer ?? '');
				text.setPlaceholder('Page address');
			});
		const actions = this.contentEl.createDiv({ cls: 'bfm-browser-dialog-actions' });
		const cancel = actions.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		const download = actions.createEl('button', { cls: 'mod-cta', text: 'Download' });
		download.addEventListener('click', () => this.submit());
		window.setTimeout(() => this.urlInput?.inputEl.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		const url = normalizeDirectUrl(this.urlInput?.getValue() ?? '');
		if (!url) {
			new Notice('Enter a direct web link.');
			return;
		}
		this.options.onSubmit({
			url,
			filename: this.filenameInput?.getValue().trim() || undefined,
			folder: this.folderInput?.getValue().trim() || this.options.folder,
			referer: this.refererInput?.getValue().trim() || undefined,
		});
		this.close();
	}
}

interface BookmarksOptions {
	bookmarks: BrowserBookmark[];
	onOpen: (url: string) => void;
	onRemove: (url: string) => void;
}

/** Manage the browser's bookmarks without navigating away from the page. */
export class BrowserBookmarksModal extends Modal {
	private listEl!: HTMLElement;
	private bookmarks: BrowserBookmark[];

	constructor(
		app: App,
		private readonly options: BookmarksOptions,
	) {
		super(app);
		this.bookmarks = [...options.bookmarks];
	}

	onOpen(): void {
		this.modalEl.addClass('bfm-browser-modal');
		this.titleEl.setText('Bookmarks');
		this.contentEl.addClass('bfm-browser-dialog');
		this.listEl = this.contentEl.createDiv({ cls: 'bfm-browser-bookmark-list' });
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.listEl.empty();
		if (this.bookmarks.length === 0) {
			const empty = this.listEl.createDiv({ cls: 'bfm-browser-empty' });
			empty.createEl('strong', { text: 'No bookmarks yet' });
			empty.createEl('p', { text: 'Use the star in the toolbar to save the page you are on.' });
			return;
		}
		for (const bookmark of this.bookmarks) {
			const row = this.listEl.createDiv({ cls: 'bfm-browser-bookmark-row' });
			const open = row.createEl('button', { cls: 'bfm-browser-bookmark-open' });
			open.createDiv({ cls: 'bfm-browser-bookmark-title', text: bookmark.title || hostOf(bookmark.url) });
			open.createDiv({ cls: 'bfm-browser-bookmark-url', text: hostOf(bookmark.url) });
			open.addEventListener('click', () => {
				this.options.onOpen(bookmark.url);
				this.close();
			});
			const remove = row.createEl('button', {
				cls: 'bfm-browser-icon-button',
				attr: { 'aria-label': `Remove ${bookmark.title || bookmark.url}` },
			});
			setIcon(remove, 'trash-2');
			remove.addEventListener('click', () => {
				this.options.onRemove(bookmark.url);
				this.bookmarks = this.bookmarks.filter((entry) => entry.url !== bookmark.url);
				this.render();
			});
		}
	}
}

interface PlayerOptions {
	item: BrowserMediaItem;
	onDownload: () => void;
	onDownloadAndPlay?: () => void;
	onExternal: () => void;
}

/**
 * Native media playback.
 *
 * The page iframe is the wrong place to diagnose a video: it inherits
 * Obsidian's CSP, may lose its player script, and Android's WebView handles
 * some containers differently inside `srcdoc`. This modal plays the direct URL
 * in the plugin's own document, the same element the video library uses.
 */
export class BrowserMediaModal extends Modal {
	constructor(
		app: App,
		private readonly options: PlayerOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('bfm-browser-modal');
		this.modalEl.addClass('bfm-browser-player-modal');
		const item = this.options.item;
		this.titleEl.setText(item.title || kindLabel(item.kind));
		this.contentEl.addClass('bfm-browser-player');
		if (item.kind === 'video' || item.kind === 'audio') {
			const media = this.contentEl.createEl(item.kind === 'video' ? 'video' : 'audio', {
				cls: 'bfm-browser-player-media',
			});
			media.controls = true;
			media.autoplay = true;
			media.setAttribute('playsinline', '');
			media.setAttribute('webkit-playsinline', '');
			media.src = item.url;
			const error = this.contentEl.createDiv({ cls: 'bfm-browser-media-error' });
			error.setCssProps({ display: 'none' });
			media.addEventListener('error', () => {
				error.setCssProps({ display: 'block' });
				error.setText(
					'This browser could not play the file directly. Download it, then play it from the downloads tray, or open it in the system browser.',
				);
			});
		} else if (item.kind === 'image') {
			const image = this.contentEl.createEl('img', { cls: 'bfm-browser-player-image' });
			image.src = item.url;
		} else {
			this.contentEl.createEl('p', {
				text: 'Stream playlists need converting before they can play here. Download it to get a video file.',
			});
		}
		const actions = this.contentEl.createDiv({ cls: 'bfm-browser-dialog-actions' });
		const external = actions.createEl('button', { text: 'Open in system browser' });
		external.addEventListener('click', () => this.options.onExternal());
		if (this.options.onDownloadAndPlay) {
			const later = actions.createEl('button', { text: 'Download and play' });
			later.addEventListener('click', () => {
				this.options.onDownloadAndPlay?.();
				this.close();
			});
		}
		const download = actions.createEl('button', { cls: 'mod-cta', text: 'Download' });
		download.addEventListener('click', () => {
			this.options.onDownload();
			this.close();
		});
	}

	onClose(): void {
		for (const media of Array.from(this.contentEl.querySelectorAll('video, audio'))) {
			const element = media as HTMLMediaElement;
			element.pause();
			element.removeAttribute('src');
			element.load();
		}
		this.contentEl.empty();
	}
}

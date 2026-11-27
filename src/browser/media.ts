import { sanitizeName } from '../destination';

/** Media and URL helpers. Everything here except `mediaFromDocument` is pure. */

export type BrowserMediaKind = 'image' | 'video' | 'audio' | 'file' | 'hls';

export interface BrowserMediaItem {
	url: string;
	kind: BrowserMediaKind;
	title?: string;
	poster?: string;
	mime?: string;
	width?: number;
	height?: number;
}

export interface BrowserBookmark {
	title: string;
	url: string;
}

const EXTENSION_KIND: Record<string, BrowserMediaKind> = {
	jpg: 'image',
	jpeg: 'image',
	png: 'image',
	gif: 'image',
	webp: 'image',
	avif: 'image',
	bmp: 'image',
	svg: 'image',
	mp4: 'video',
	webm: 'video',
	mov: 'video',
	m4v: 'video',
	mkv: 'video',
	avi: 'video',
	mp3: 'audio',
	m4a: 'audio',
	aac: 'audio',
	ogg: 'audio',
	oga: 'audio',
	wav: 'audio',
	flac: 'audio',
	m3u8: 'hls',
};

const MIME_EXTENSION: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'image/svg+xml': 'svg',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
	'video/x-matroska': 'mkv',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'audio/aac': 'aac',
	'audio/ogg': 'ogg',
	'audio/wav': 'wav',
	'audio/flac': 'flac',
	'application/vnd.apple.mpegurl': 'm3u8',
	'application/x-mpegurl': 'm3u8',
};

const KIND_EXTENSION: Record<BrowserMediaKind, string> = {
	image: 'jpg',
	video: 'mp4',
	audio: 'mp3',
	file: '',
	hls: 'mp4',
};

/** Lowercase extension without the dot, or an empty string. */
export function extensionOf(url: string): string {
	const clean = url.split('#')[0]?.split('?')[0] ?? '';
	const match = /\.([a-z0-9]{1,8})$/i.exec(clean);
	return match?.[1]?.toLowerCase() ?? '';
}

/** The media kind implied by a URL and, when known, its content type. */
export function kindForUrl(url: string, mime?: string): BrowserMediaKind {
	const extension = extensionOf(url);
	if (extension === 'm3u8') return 'hls';
	if (extension && EXTENSION_KIND[extension]) return EXTENSION_KIND[extension];
	const type = (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	if (type.startsWith('image/')) return 'image';
	if (type.startsWith('video/')) return 'video';
	if (type.startsWith('audio/')) return 'audio';
	if (type.includes('mpegurl')) return 'hls';
	return 'file';
}

/** Whether a URL points at media the picker can offer, rather than a page. */
export function isMediaUrl(url: string): boolean {
	return kindForUrl(url) !== 'file';
}

export function isHlsUrl(url: string): boolean {
	return kindForUrl(url) === 'hls';
}

/** Normalise a direct file link. Unlike the address bar, this never searches. */
export function normalizeDirectUrl(input: string): string | null {
	const value = input.trim();
	if (!value) return null;
	if (/^https?:\/\//i.test(value)) return value;
	if (/^\/\//.test(value)) return `https:${value}`;
	if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(value)) return `http://${value}`;
	if (!/\s/.test(value) && /^[^\s/]+\.[^\s/]{2,}(:\d+)?([/?#]|$)/.test(value)) return `https://${value}`;
	return null;
}

/** Turn the address bar's text into a URL or a search query. */
export function normalizeBrowserInput(input: string, searchUrl: string): string | null {
	const value = input.trim();
	if (!value) return null;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
	if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(value)) return `http://${value}`;
	if (!/\s/.test(value) && /^[^\s/]+\.[^\s/]{2,}(:\d+)?([/?#]|$)/.test(value)) return `https://${value}`;
	return searchUrl + encodeURIComponent(value);
}

/** The last path segment of a URL, decoded, or a generic fallback. */
export function filenameFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const segment = parsed.pathname.split('/').filter((part) => part.length > 0).pop();
		if (!segment) return 'download';
		try {
			return decodeURIComponent(segment);
		} catch {
			return segment;
		}
	} catch {
		return 'download';
	}
}

/** Read a filename from a Content-Disposition header, including `filename*`. */
export function parseContentDisposition(value: string | undefined | null): string | null {
	if (!value) return null;
	const extended = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value);
	if (extended?.[1]) {
		let raw = extended[1].trim().replace(/^"|"$/g, '');
		try {
			raw = decodeURIComponent(raw);
		} catch {
			/* Keep the encoded form; it is still a usable filename. */
		}
		return raw || null;
	}
	const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(value);
	const raw = plain?.[1] ?? plain?.[2];
	return raw?.trim().replace(/^"|"$/g, '') || null;
}

export function extensionForMime(mime: string | undefined): string {
	const type = (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	return MIME_EXTENSION[type] ?? '';
}

function trimFilename(name: string): string {
	let clean = sanitizeName(name).replace(/\s+/g, ' ').trim();
	if (!clean) clean = 'download';
	const extension = /(\.[a-z0-9]{1,8})$/i.exec(clean)?.[1] ?? '';
	const base = extension ? clean.slice(0, -extension.length) : clean;
	if (base.length > 100) clean = base.slice(0, 100) + extension;
	return clean;
}

function addExtension(name: string, url: string, mime: string | undefined, kind: BrowserMediaKind): string {
	if (kind === 'hls') {
		return `${name.replace(/\.[a-z0-9]{1,8}$/i, '') || 'video'}.mp4`;
	}
	if (/\.[a-z0-9]{1,8}$/i.test(name)) return name;
	const extension = extensionOf(url) || extensionForMime(mime) || KIND_EXTENSION[kind];
	return extension ? `${name}.${extension}` : name;
}

/**
 * Pick the filename for a download. The explicit name wins, then the server's
 * Content-Disposition, then the URL. A missing extension is filled from the
 * URL, content type, or media kind.
 */
export function filenameFor(
	requested: string | undefined,
	url: string,
	mime: string | undefined,
	disposition: string | undefined,
	kind: BrowserMediaKind,
): string {
	const header = parseContentDisposition(disposition);
	const name = requested?.trim() || header || filenameFromUrl(url);
	return trimFilename(addExtension(name, url, mime, kind));
}

/** Parse `bytes 0-1023/2048`; total is null for `*`. */
export function parseContentRange(value: string | undefined | null): {
	start: number;
	end: number;
	total: number | null;
} | null {
	if (!value) return null;
	const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(value);
	if (!match?.[1] || !match[2]) return null;
	const start = Number(match[1]);
	const end = Number(match[2]);
	const total = match[3] === '*' || match[3] === undefined ? null : Number(match[3]);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	return { start, end, total: total !== null && Number.isFinite(total) ? total : null };
}

/** Choose the largest candidate in a `srcset` attribute. */
export function selectSrcset(srcset: string | null | undefined): string | null {
	if (!srcset) return null;
	let best: string | null = null;
	let bestWeight = -1;
	for (const part of srcset.split(',')) {
		const pieces = part.trim().split(/\s+/);
		const url = pieces[0];
		if (!url) continue;
		const descriptor = pieces[1] ?? '';
		let weight = 1;
		if (descriptor.endsWith('w')) weight = Number.parseFloat(descriptor) || 0;
		else if (descriptor.endsWith('x')) weight = (Number.parseFloat(descriptor) || 0) * 1000;
		if (weight > bestWeight) {
			best = url;
			bestWeight = weight;
		}
	}
	return best;
}

function absoluteUrl(raw: string | null | undefined, baseUrl: string): string | null {
	if (!raw) return null;
	const value = raw.trim();
	if (!value) return null;
	if (/^(blob:|data:|about:|javascript:)/i.test(value)) return null;
	try {
		const parsed = new URL(value, baseUrl);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
	} catch {
		return null;
	}
}

function titleOf(element: Element, fallback: string): string {
	const label =
		element.getAttribute('aria-label') ??
		element.getAttribute('title') ??
		element.textContent ??
		'';
	const clean = label.replace(/\s+/g, ' ').trim();
	return (clean || fallback).slice(0, 120);
}

/** Every image, video, audio file and media link currently in a page. */
export function mediaFromDocument(doc: Document, baseUrl: string): BrowserMediaItem[] {
	const found = new Map<string, BrowserMediaItem>();
	const add = (
		raw: string | null | undefined,
		kind: BrowserMediaKind,
		title?: string,
		poster?: string,
		width?: number,
		height?: number,
	): void => {
		const url = absoluteUrl(raw, baseUrl);
		if (!url || found.has(url)) return;
		const item: BrowserMediaItem = { url, kind };
		if (title) item.title = title;
		const posterUrl = absoluteUrl(poster, baseUrl);
		if (posterUrl) item.poster = posterUrl;
		if (width && width > 0) item.width = width;
		if (height && height > 0) item.height = height;
		found.set(url, item);
	};

	for (const element of Array.from(doc.querySelectorAll('img, video, audio, a[href]'))) {
		if (element.tagName === 'IMG') {
			const image = element as HTMLImageElement;
			const source =
				image.getAttribute('data-bfm-source') ||
				image.currentSrc ||
				selectSrcset(image.getAttribute('srcset')) ||
				image.getAttribute('src') ||
				image.getAttribute('data-src') ||
				image.getAttribute('data-original') ||
				image.getAttribute('data-lazy-src');
			add(source, 'image', titleOf(image, 'Image'), undefined, image.naturalWidth, image.naturalHeight);
			continue;
		}
		if (element.tagName === 'VIDEO') {
			const video = element as HTMLVideoElement;
			const source =
				video.currentSrc ||
				video.getAttribute('src') ||
				video.querySelector('source[src]')?.getAttribute('src') ||
				null;
			add(source, 'video', titleOf(video, 'Video'), video.getAttribute('poster') ?? undefined, video.videoWidth, video.videoHeight);
			continue;
		}
		if (element.tagName === 'AUDIO') {
			const audio = element as HTMLAudioElement;
			const source =
				audio.currentSrc ||
				audio.getAttribute('src') ||
				audio.querySelector('source[src]')?.getAttribute('src') ||
				null;
			add(source, 'audio', titleOf(audio, 'Audio'));
			continue;
		}
		if (element.tagName === 'A') {
			const anchor = element as HTMLAnchorElement;
			const href = anchor.getAttribute('href');
			if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
			const kind = kindForUrl(href);
			if (kind === 'file' && !anchor.hasAttribute('download')) continue;
			add(href, kind, titleOf(anchor, filenameFromUrl(href)));
		}
	}

	// A <picture> may carry the largest source separately from its fallback img.
	for (const source of Array.from(doc.querySelectorAll('picture source[srcset]'))) {
		add(
			source.getAttribute('data-bfm-source') || selectSrcset(source.getAttribute('srcset')),
			'image',
			'Image',
		);
	}

	const items = Array.from(found.values());
	return items.slice(0, 250);
}

/** The item for the page itself, when it is a direct media file. */
export function mediaItemForUrl(url: string, mime?: string): BrowserMediaItem | null {
	const kind = kindForUrl(url, mime);
	if (kind === 'file') return null;
	return { url, kind, title: filenameFromUrl(url) };
}

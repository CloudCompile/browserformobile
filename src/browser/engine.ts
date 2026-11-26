import { Notice } from 'obsidian';
import type AnimePlugin from '../main';
import { BROWSER_ENGINES, BROWSER_QUICK_LINKS, DEFAULT_BROWSER_UA } from './config';
import { decodeText, nativeRequest, type NativeResponse } from './http';
import { injectedBrowserScript } from './injected';
import type { BrowserMediaItem } from './media';

export interface BrowserNavSpec {
	url?: string;
	home?: boolean;
	method?: string;
	body?: string;
	headers?: Record<string, string>;
	newTab?: boolean;
}

export interface BrowserTabHandle {
	handleNav(spec: BrowserNavSpec): void;
	addMedia(item: BrowserMediaItem): void;
	setTitle(title: string): void;
}

interface BridgeRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

interface BrowserBridge {
	request(options: BridgeRequest): Promise<NativeResponse>;
	nav(tab: string, spec: BrowserNavSpec): void;
	title(tab: string, title: string): void;
	external(url: string): void;
	media(tab: string, items: BrowserMediaItem[]): void;
	download(tab: string, options: { url: string; filename?: string; referer?: string }): void;
}

declare global {
	interface Window {
		__bfmBrowser?: BrowserBridge;
	}
}

interface BuiltDocument {
	doc: Document;
	baseUrl: string;
	title: string;
}

interface CapacitorBrowser {
	open?: (options: { url: string }) => unknown;
}

/**
 * The browser's network, document and bridge layer.
 *
 * The view owns tabs and the DOM; this class owns everything that has to be
 * shared between the injected scripts and the plugin: native requests, the
 * cleaned/instrumented document and the bridge object.
 */
export class BrowserEngine {
	private readonly tabs = new Map<string, BrowserTabHandle>();

	constructor(private readonly plugin: AnimePlugin) {}

	install(): void {
		const bridge: BrowserBridge = {
			request: (options) => this.request(options),
			nav: (tab, spec) => this.tabs.get(tab)?.handleNav(spec),
			title: (tab, title) => this.tabs.get(tab)?.setTitle(title),
			external: (url) => this.openExternal(url),
			media: (tab, items) => {
				const handle = this.tabs.get(tab);
				if (!handle) return;
				for (const item of items) handle.addMedia(item);
			},
			download: (_tab, options) => {
				if (!options.url) return;
				void this.plugin.enqueueBrowserDownload({
					url: options.url,
					filename: options.filename || undefined,
					referer: options.referer,
				});
			},
		};
		window.__bfmBrowser = bridge;
	}

	uninstall(): void {
		delete window.__bfmBrowser;
		this.tabs.clear();
	}

	registerTab(id: string, handle: BrowserTabHandle): void {
		this.tabs.set(id, handle);
	}

	unregisterTab(id: string): void {
		this.tabs.delete(id);
	}

	searchUrl(): string {
		const engine = BROWSER_ENGINES[this.plugin.settings.browserSearchEngine];
		return (engine ?? BROWSER_ENGINES.ddg).url;
	}

	/** A native request with the browser's user agent and language defaults. */
	async request(options: BridgeRequest): Promise<NativeResponse> {
		const headers: Record<string, string> = {
			'user-agent': this.plugin.settings.browserUserAgent || DEFAULT_BROWSER_UA,
			accept: '*/*',
			'accept-language': typeof navigator === 'undefined' ? 'en-US,en;q=0.9' : navigator.language || 'en-US,en;q=0.9',
		};
		for (const [key, value] of Object.entries(options.headers ?? {})) {
			headers[key.toLowerCase()] = value;
		}
		return nativeRequest({
			url: options.url,
			method: options.method || 'GET',
			headers,
			body: options.body,
		});
	}

	/**
	 * Clean a page and inject the bridge. Response headers (CSP, X-Frame-Options)
	 * never apply because the result is loaded as `srcdoc`.
	 */
	buildDoc(text: string, finalUrl: string, tabId: string): BuiltDocument {
		const doc = new DOMParser().parseFromString(text, 'text/html');
		for (const meta of Array.from(doc.querySelectorAll('meta[http-equiv]'))) {
			const name = (meta.getAttribute('http-equiv') || '').toLowerCase();
			if (name === 'content-security-policy' || name === 'x-frame-options' || name === 'refresh') {
				meta.remove();
			}
		}
		for (const node of Array.from(doc.querySelectorAll('script[integrity], link[integrity]'))) {
			node.removeAttribute('integrity');
			node.removeAttribute('crossorigin');
		}
		let baseUrl = finalUrl;
		const oldBase = doc.querySelector('base[href]');
		if (oldBase) {
			try {
				baseUrl = new URL(oldBase.getAttribute('href') || finalUrl, finalUrl).href;
			} catch {
				/* Keep the page URL. */
			}
			oldBase.remove();
		}
		const head = doc.head ?? doc.createElement('head');
		if (!doc.head) doc.documentElement.prepend(head);
		const base = doc.createElement('base');
		base.setAttribute('href', baseUrl);
		const config = JSON.stringify({ tab: tabId, url: finalUrl }).replace(/</g, '\\u003c');
		const script = doc.createElement('script');
		script.textContent = `(${injectedBrowserScript.toString()})(${config});`;
		head.prepend(script);
		head.prepend(base);
		return { doc, baseUrl, title: (doc.title || '').trim() };
	}

	serialize(doc: Document): string {
		return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
	}

	/**
	 * An `srcdoc` document inherits Obsidian's own CSP, which can block remote
	 * styles, scripts and fonts. Fetch them natively and embed them instead.
	 */
	async inlineResources(doc: Document, baseUrl: string, pageUrl: string): Promise<void> {
		const getFile = async (url: string): Promise<{ text: string; url: string }> => {
			const response = await this.request({
				url,
				method: 'GET',
				headers: { referer: pageUrl, accept: '*/*' },
				body: null,
			});
			if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
			return {
				text: decodeText(response.bytes, response.headers['content-type']),
				url: response.url || url,
			};
		};
		const pool = async <T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> => {
			let index = 0;
			await Promise.all(
				Array.from({ length: Math.min(limit, items.length) }, async () => {
					while (index < items.length) {
						const item = items[index++];
						if (item === undefined) continue;
						try {
							await task(item);
						} catch (error) {
							this.plugin.debug('browser.inline.failed', {
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
				}),
			);
		};
		let fontBudget = 12;
		const processCss = async (css: string, cssUrl: string, depth: number): Promise<string> => {
			if (depth < 3) {
				const importRe = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?\s*([^;]*);/gi;
				for (const match of Array.from(css.matchAll(importRe))) {
					let replacement = '';
					try {
						const imported = await getFile(new URL(match[1] ?? '', cssUrl).href);
						replacement = await processCss(imported.text, imported.url, depth + 1);
						const media = (match[2] ?? '').trim();
						if (media) replacement = `@media ${media}{${replacement}}`;
					} catch {
						/* Leave the import in place; it may still load from the base URL. */
					}
					css = css.replace(match[0] ?? '', () => replacement);
				}
			}
			const urlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
			const parts = Array.from(css.matchAll(urlRe));
			const replacements = await Promise.all(
				parts.map(async (match) => {
					const raw = (match[2] ?? '').trim();
					if (/^(data:|#|about:|blob:)/i.test(raw)) return match[0] ?? '';
					let absolute: string;
					try {
						absolute = new URL(raw, cssUrl).href;
					} catch {
						return match[0] ?? '';
					}
					if (/\.(woff2?|ttf|otf)([?#]|$)/i.test(absolute) && fontBudget > 0) {
						fontBudget--;
						try {
							const response = await this.request({
								url: absolute,
								method: 'GET',
								headers: { referer: pageUrl, accept: '*/*' },
								body: null,
							});
							if (response.status < 400 && response.bytes.length < 600_000) {
								const mime = /woff2/i.test(absolute) ? 'font/woff2' : /woff/i.test(absolute) ? 'font/woff' : 'font/ttf';
								return `url("data:${mime};base64,${bytesToBase64(response.bytes)}")`;
							}
						} catch {
							/* Fall through to the absolute URL. */
						}
					}
					return `url("${absolute}")`;
				}),
			);
			let replacementIndex = 0;
			return css.replace(urlRe, () => replacements[replacementIndex++] ?? '');
		};

		const links = Array.from(doc.querySelectorAll("link[rel~='stylesheet'][href]")).filter(
			(link) => !/alternate/i.test(link.getAttribute('rel') || ''),
		);
		await pool(links, 6, async (link) => {
			const file = await getFile(new URL(link.getAttribute('href') || '', baseUrl).href);
			const style = doc.createElement('style');
			const media = link.getAttribute('media');
			if (media) style.setAttribute('media', media);
			style.textContent = await processCss(file.text, file.url, 0);
			link.replaceWith(style);
		});

		const scripts = Array.from(doc.querySelectorAll('script[src]')).filter((script) => {
			const type = (script.getAttribute('type') || '').toLowerCase();
			return (!type || type === 'text/javascript' || type === 'application/javascript') && !script.hasAttribute('nomodule');
		});
		const deferred: { order: number; node: HTMLScriptElement }[] = [];
		await pool(scripts, 6, async (script) => {
			const file = await getFile(new URL(script.getAttribute('src') || '', baseUrl).href);
			const node = doc.createElement('script');
			node.textContent = file.text.replace(/<\/script/gi, '<\\/script');
			if (script.hasAttribute('defer') && !script.hasAttribute('async')) {
				script.remove();
				deferred.push({ order: scripts.indexOf(script), node });
			} else {
				script.replaceWith(node);
			}
		});
		deferred.sort((left, right) => left.order - right.order);
		for (const entry of deferred) (doc.body ?? doc.documentElement).appendChild(entry.node);
	}

	private escape(value: string): string {
		return String(value).replace(/[&<>"']/g, (character) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
		);
	}

	/** The browser's own front page: a search box, bookmarks and quick links. */
	homeHtml(tabId: string): string {
		const engine = BROWSER_ENGINES[this.plugin.settings.browserSearchEngine] ?? BROWSER_ENGINES.ddg;
		const bookmarkHtml = this.plugin.browserBookmarks
			.map(
				(bookmark) =>
					`<a class="tile" href="${this.escape(bookmark.url)}">${this.escape(bookmark.title || hostOf(bookmark.url))}<small>${this.escape(hostOf(bookmark.url))}</small></a>`,
			)
			.join('');
		const quickHtml = BROWSER_QUICK_LINKS.map(
			(link) =>
				`<a class="tile" href="${this.escape(link.url)}">${this.escape(link.title)}<small>${this.escape(hostOf(link.url))}</small></a>`,
		).join('');
		const raw = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:24px 16px;background:#fff;color:#222}
h1{font-size:22px;margin:0 0 4px}
p{color:#777;margin:0 0 18px;font-size:14px}
form{display:flex;gap:8px;margin-bottom:24px}
input[type=text]{flex:1;font-size:16px;padding:11px 14px;border:1px solid #ccc;border-radius:22px;min-width:0}
button{font-size:16px;padding:11px 16px;border:0;border-radius:22px;background:#6c5ce7;color:#fff}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#777;margin:22px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.tile{display:block;padding:12px;border:1px solid #e2e2e2;border-radius:12px;color:#222;text-decoration:none;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile small{display:block;font-weight:400;color:#888;margin-top:2px;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<h1>Browser</h1><p>Search the web or enter an address.</p>
<form action="${this.escape(this.searchUrl().split('?')[0] ?? 'https://duckduckgo.com/')}" method="get"><input type="text" name="q" placeholder="Search or enter address" autocomplete="off"><button type="submit">Go</button></form>
${bookmarkHtml ? `<h2>Bookmarks</h2><div class="grid">${bookmarkHtml}</div>` : ''}
<h2>Quick links</h2><div class="grid">${quickHtml}</div>
</body></html>`;
		return this.serialize(this.buildDoc(raw, engine.url, tabId).doc);
	}

	errorHtml(url: string, error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;padding:24px 16px;background:#fff;color:#222}code{word-break:break-all;color:#b00}</style></head>
<body><h2>Couldn't load this page</h2><p><code>${this.escape(url)}</code></p><p>${this.escape(message)}</p><p>Check the address or your connection, then press reload.</p></body></html>`;
	}

	openExternal(url: string): void {
		try {
			const plugins = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor?.Plugins;
			const browser = plugins?.Browser as CapacitorBrowser | undefined;
			if (browser?.open && /^https?:/i.test(url)) {
				browser.open({ url });
				return;
			}
		} catch {
			/* Fall through to window.open. */
		}
		window.open(url, '_blank');
	}

	notice(message: string): void {
		new Notice(message);
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname || url;
	} catch {
		return url;
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	}
	return btoa(binary);
}

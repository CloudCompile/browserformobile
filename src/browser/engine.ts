import { Notice } from 'obsidian';
import type AnimePlugin from '../main';
import { BrowserAssetCache } from './assets';
import { framingAllowed, hostOf, parseMetaRefresh, type MetaRefresh } from './compat';
import { BROWSER_ENGINES, BROWSER_QUICK_LINKS, DEFAULT_BROWSER_UA } from './config';
import { BrowserCookieJar } from './cookies';
import { base64ToBytes, decodeText, nativeRequest, type NativeResponse } from './http';
import { injectedBrowserScript } from './injected';
import { selectSrcset, type BrowserMediaItem } from './media';
import {
	normaliseImportMap,
	parseImportMapJson,
	readModuleImports,
	resolveModuleSpecifier,
	rewriteModuleSpecifiers,
	type BrowserImportMap,
} from './modules';

export type BrowserSiteMode = 'auto' | 'direct' | 'proxy';

export interface BrowserNavSpec {
	url?: string;
	home?: boolean;
	method?: string;
	body?: string;
	bodyBase64?: string;
	headers?: Record<string, string>;
	newTab?: boolean;
	/** Set when this navigation came from a meta refresh. */
	fromRefresh?: boolean;
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
	bodyBase64?: string | null;
}

interface BrowserBridge {
	request(options: BridgeRequest): Promise<NativeResponse>;
	nav(tab: string, spec: BrowserNavSpec): void;
	title(tab: string, title: string): void;
	external(url: string): void;
	media(tab: string, items: BrowserMediaItem[]): void;
	download(tab: string, options: { url: string; filename?: string; referer?: string }): void;
	readCookie(tab: string, url: string): string;
	writeCookie(tab: string, url: string, value: string): void;
}

declare global {
	interface Window {
		__bfmBrowser?: BrowserBridge;
	}
}

export interface BuiltDocument {
	doc: Document;
	baseUrl: string;
	title: string;
	refresh: MetaRefresh | null;
}

interface CapacitorBrowser {
	open?: (options: { url: string }) => unknown;
}

const MODULE_LIMIT = 80;
const MODULE_BYTES_LIMIT = 24 * 1024 * 1024;
const MODULE_DEPTH_LIMIT = 12;
const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)([?#]|$)/i;

/**
 * The browser's network, document and bridge layer.
 *
 * The view owns tabs and the DOM; this class owns everything that has to be
 * shared between the injected scripts and the plugin: native requests, cookies,
 * the cleaned/instrumented document and the bridge object.
 */
export class BrowserEngine {
	private readonly tabs = new Map<string, BrowserTabHandle>();
	private readonly cookies: BrowserCookieJar;
	private readonly assets = new BrowserAssetCache();
	private readonly moduleBlobs = new Map<string, Set<string>>();
	private saveTimer: number | null = null;

	constructor(private readonly plugin: AnimePlugin) {
		this.cookies = new BrowserCookieJar(plugin.browserCookies ?? []);
		this.cookies.onChange(() => {
			this.plugin.browserCookies = this.cookies.persisted();
			this.scheduleSave();
		});
	}

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
			readCookie: (_tab, url) => this.cookies.headerFor(url, false),
			writeCookie: (_tab, url, value) => this.cookies.write(url, value),
		};
		window.__bfmBrowser = bridge;
	}

	uninstall(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		if (this.plugin.browserCookies) this.plugin.browserCookies = this.cookies.persisted();
		this.assets.dispose();
		this.releaseAllModuleBlobs();
		delete window.__bfmBrowser;
		this.tabs.clear();
	}

	registerTab(id: string, handle: BrowserTabHandle): void {
		this.tabs.set(id, handle);
	}

	unregisterTab(id: string): void {
		this.tabs.delete(id);
		this.resetTab(id);
	}

	/** Drop page-owned blob URLs before a navigation replaces the document. */
	resetTab(id: string): void {
		this.assets.release(id);
		this.releaseModuleBlobs(id);
	}

	searchUrl(): string {
		const engine = BROWSER_ENGINES[this.plugin.settings.browserSearchEngine];
		return (engine ?? BROWSER_ENGINES.ddg).url;
	}

	/** The Cookie header a download for this URL should carry. */
	cookieHeader(url: string): string {
		return this.cookies.headerFor(url);
	}

	compatibilityEnabled(): boolean {
		return this.plugin.settings.browserCompatibility !== false;
	}

	siteMode(host: string): BrowserSiteMode {
		const saved = this.plugin.browserSiteModes?.[host];
		return saved === 'direct' || saved === 'proxy' ? saved : 'auto';
	}

	setSiteMode(host: string, mode: BrowserSiteMode): void {
		const modes = { ...(this.plugin.browserSiteModes ?? {}) };
		if (mode === 'auto') delete modes[host];
		else modes[host] = mode;
		this.plugin.browserSiteModes = modes;
		this.scheduleSave();
	}

	/** Whether a normal `iframe src` should be tried for this page. */
	canUseDirect(host: string, headers: Record<string, string>): boolean {
		const mode = this.siteMode(host);
		if (mode === 'direct') return true;
		if (mode === 'proxy') return false;
		if (!this.compatibilityEnabled()) return false;
		return framingAllowed(headers);
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.saveSettings();
		}, 800);
	}

	/** A native request with the browser's user agent, cookies and language defaults. */
	async request(options: BridgeRequest): Promise<NativeResponse> {
		const headers: Record<string, string> = {
			'user-agent': this.plugin.settings.browserUserAgent || DEFAULT_BROWSER_UA,
			accept: '*/*',
			'accept-language':
				typeof navigator === 'undefined'
					? 'en-US,en;q=0.9'
					: navigator.language || 'en-US,en;q=0.9',
		};
		for (const [key, value] of Object.entries(options.headers ?? {})) {
			headers[key.toLowerCase()] = value;
		}
		if (!headers.cookie) {
			const cookie = this.cookies.headerFor(options.url);
			if (cookie) headers.cookie = cookie;
		}
		const body = options.bodyBase64 ? base64ToBytes(options.bodyBase64) : options.body;
		const response = await nativeRequest({
			url: options.url,
			method: options.method || 'GET',
			headers,
			body,
		});
		this.cookies.storeAll(response.setCookies, response.url || options.url);
		return response;
	}

	/**
	 * Clean a page and inject the bridge. Response headers (CSP, X-Frame-Options)
	 * never apply because the result is loaded as `srcdoc`.
	 */
	buildDoc(text: string, finalUrl: string, tabId: string): BuiltDocument {
		const doc = new DOMParser().parseFromString(text, 'text/html');
		let refresh: MetaRefresh | null = null;
		for (const meta of Array.from(doc.querySelectorAll('meta[http-equiv]'))) {
			const name = (meta.getAttribute('http-equiv') || '').toLowerCase();
			if (name === 'refresh') {
				refresh = parseMetaRefresh(meta.getAttribute('content') || '', finalUrl);
				meta.remove();
			} else if (name === 'content-security-policy' || name === 'x-frame-options') {
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
		return { doc, baseUrl, title: (doc.title || '').trim(), refresh };
	}

	serialize(doc: Document): string {
		return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
	}

	/**
	 * An `srcdoc` document inherits Obsidian's own CSP, which can block remote
	 * styles, scripts and fonts. Fetch them natively and embed them instead.
	 *
	 * Returns the number of resources that could not be loaded, which the view
	 * uses to explain a blank page.
	 */
	async inlineResources(doc: Document, baseUrl: string, pageUrl: string, tabId: string): Promise<number> {
		let failures = 0;
		let fontBudget = 12;
		let imageBudget = 40;
		const getBytes = async (
			url: string,
			accept = '*/*',
		): Promise<{ bytes: Uint8Array; type: string; url: string }> => {
			const response = await this.request({
				url,
				method: 'GET',
				headers: { referer: pageUrl, accept },
				body: null,
			});
			if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
			return {
				bytes: response.bytes,
				type: response.headers['content-type'] ?? '',
				url: response.url || url,
			};
		};
		const getFile = async (url: string): Promise<{ text: string; url: string }> => {
			const file = await getBytes(url);
			return { text: decodeText(file.bytes, file.type), url: file.url };
		};
		const pool = async <T>(
			items: T[],
			limit: number,
			task: (item: T) => Promise<void>,
		): Promise<void> => {
			let index = 0;
			await Promise.all(
				Array.from({ length: Math.min(limit, items.length) }, async () => {
					while (index < items.length) {
						const item = items[index++];
						if (item === undefined) continue;
						try {
							await task(item);
						} catch (error) {
							failures++;
							this.plugin.debug('browser.inline.failed', {
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
				}),
			);
		};

		const absolute = (raw: string, relativeTo: string): string | null => {
			try {
				const url = new URL(raw, relativeTo);
				return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
			} catch {
				return null;
			}
		};
		const proxyImage = async (raw: string, relativeTo: string): Promise<string | null> => {
			const url = absolute(raw, relativeTo);
			if (!url || imageBudget <= 0) return null;
			imageBudget--;
			return this.assets.get(tabId, url, async (assetUrl) => {
				const file = await getBytes(assetUrl, 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8');
				const type = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
				if (!type.startsWith('image/') && !IMAGE_URL.test(assetUrl)) {
					throw new Error('The asset is not an image.');
				}
				return { bytes: file.bytes, type: type || 'application/octet-stream', url: file.url };
			});
		};
		const rewriteSrcset = async (value: string, relativeTo: string): Promise<string> => {
			const candidates = value.split(',');
			const out: string[] = [];
			for (const candidate of candidates) {
				const parts = candidate.trim().split(/\s+/);
				const raw = parts.shift() ?? '';
				if (!raw) continue;
				const proxied = await proxyImage(raw, relativeTo);
				const resolved = proxied ?? absolute(raw, relativeTo);
				if (!resolved) continue;
				out.push([resolved, ...parts].join(' '));
			}
			return out.join(', ');
		};

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
					const resolved = absolute(raw, cssUrl);
					if (!resolved) return match[0] ?? '';
					if (/\.(woff2?|ttf|otf)([?#]|$)/i.test(resolved) && fontBudget > 0) {
						fontBudget--;
						try {
							const response = await getBytes(resolved);
							if (response.bytes.length < 600_000) {
								const mime = /woff2/i.test(resolved)
									? 'font/woff2'
									: /woff/i.test(resolved)
										? 'font/woff'
										: 'font/ttf';
								return `url("data:${mime};base64,${bytesToBase64(response.bytes)}")`;
							}
						} catch {
							/* Fall through to the absolute URL. */
						}
					}
					if (IMAGE_URL.test(resolved) && imageBudget > 0) {
						const proxied = await proxyImage(resolved, cssUrl);
						if (proxied) return `url("${proxied}")`;
					}
					return `url("${resolved}")`;
				}),
			);
			let replacementIndex = 0;
			return css.replace(urlRe, () => replacements[replacementIndex++] ?? '');
		};

		await this.inlineModuleScripts(doc, baseUrl, pageUrl, tabId, getFile);

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

		for (const style of Array.from(doc.querySelectorAll('style'))) {
			if (!style.textContent || style.textContent.length < 8) continue;
			try {
				style.textContent = await processCss(style.textContent, baseUrl, 0);
			} catch (error) {
				failures++;
				this.plugin.debug('browser.inline.style.failed', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const images = Array.from(doc.querySelectorAll('img, picture source[srcset], link[rel~="icon"][href]'));
		await pool(images, 6, async (element) => {
			if (element.tagName === 'IMG') {
				const image = element as HTMLImageElement;
				const original =
					selectSrcset(image.getAttribute('srcset')) ||
					image.getAttribute('src') ||
					image.getAttribute('data-src') ||
					image.getAttribute('data-original') ||
					image.getAttribute('data-lazy-src');
				const originalUrl = original ? absolute(original, baseUrl) : null;
				if (originalUrl) image.setAttribute('data-bfm-source', originalUrl);
				for (const attribute of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
					const raw = image.getAttribute(attribute);
					if (!raw) continue;
					const proxied = await proxyImage(raw, baseUrl);
					if (proxied) image.setAttribute(attribute, proxied);
				}
				const srcset = image.getAttribute('srcset');
				if (srcset) {
					const proxied = await rewriteSrcset(srcset, baseUrl);
					if (proxied) image.setAttribute('srcset', proxied);
				}
			} else if (element.tagName === 'SOURCE') {
				const srcset = element.getAttribute('srcset');
				if (srcset) {
					const original = selectSrcset(srcset);
					const originalUrl = original ? absolute(original, baseUrl) : null;
					if (originalUrl) element.setAttribute('data-bfm-source', originalUrl);
					const proxied = await rewriteSrcset(srcset, baseUrl);
					if (proxied) element.setAttribute('srcset', proxied);
				}
			} else {
				const href = element.getAttribute('href');
				if (href) {
					const proxied = await proxyImage(href, baseUrl);
					if (proxied) element.setAttribute('href', proxied);
				}
			}
		});

		for (const video of Array.from(doc.querySelectorAll('video[poster]'))) {
			const poster = video.getAttribute('poster');
			if (!poster) continue;
			const proxied = await proxyImage(poster, baseUrl);
			if (proxied) video.setAttribute('poster', proxied);
		}

		return failures;
	}

	/**
	 * Fetch the module graph and rewrite it into blob modules with an import map.
	 * The page still executes at the app origin, but its module specifiers now
	 * point at natively fetched sources rather than the network roots.
	 */
	private async inlineModuleScripts(
		doc: Document,
		baseUrl: string,
		pageUrl: string,
		tabId: string,
		getFile: (url: string) => Promise<{ text: string; url: string }>,
	): Promise<void> {
		const allScripts = Array.from(doc.querySelectorAll('script'));
		const external = allScripts.filter((script) => {
			const type = (script.getAttribute('type') || '').toLowerCase();
			return type === 'module' && script.hasAttribute('src') && !script.hasAttribute('nomodule');
		});
		const inline = allScripts.filter((script) => {
			const type = (script.getAttribute('type') || '').toLowerCase();
			return type === 'module' && !script.hasAttribute('src');
		});
		if (external.length === 0 && inline.length === 0) return;

		let pageMap: BrowserImportMap = { imports: {}, scopes: {} };
		for (const element of Array.from(doc.querySelectorAll('script[type="importmap"]'))) {
			const parsed = parseImportMapJson(element.textContent || '', baseUrl);
			if (parsed) {
				pageMap = {
					imports: { ...pageMap.imports, ...parsed.imports },
					scopes: { ...pageMap.scopes, ...parsed.scopes },
				};
			}
			element.remove();
		}
		const importMap = normaliseImportMap(pageMap, baseUrl);

		const graph = new Map<string, string>();
		const queue: { url: string; depth: number }[] = [];
		let totalBytes = 0;
		const enqueue = (url: string | null, depth: number): void => {
			if (!url || !/^https?:/i.test(url) || graph.has(url) || depth > MODULE_DEPTH_LIMIT) return;
			if (queue.some((entry) => entry.url === url)) return;
			queue.push({ url, depth });
		};

		for (const script of external) {
			try {
				enqueue(new URL(script.getAttribute('src') || '', baseUrl).href, 0);
			} catch {
				/* An invalid src is left for the page to handle. */
			}
		}
		for (const script of inline) {
			const imports = await readModuleImports(script.textContent || '');
			for (const entry of imports) {
				enqueue(resolveModuleSpecifier(entry.specifier, pageUrl, importMap), 0);
			}
		}

		while (queue.length > 0 && graph.size < MODULE_LIMIT && totalBytes < MODULE_BYTES_LIMIT) {
			const batch = queue.splice(0, Math.min(6, MODULE_LIMIT - graph.size));
			await Promise.all(
				batch.map(async ({ url, depth }) => {
					if (graph.has(url)) return;
					try {
						const file = await getFile(url);
						if (totalBytes + file.text.length > MODULE_BYTES_LIMIT) return;
						totalBytes += file.text.length;
						graph.set(url, file.text);
						const imports = await readModuleImports(file.text);
						for (const entry of imports) {
							enqueue(resolveModuleSpecifier(entry.specifier, url, importMap), depth + 1);
						}
					} catch (error) {
						this.plugin.debug('browser.module.failed', {
							url,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}),
			);
		}
		if (graph.size === 0) return;

		const mappings: Record<string, string> = {};
		for (const [url, source] of graph) {
			const imports = await readModuleImports(source);
			const rewritten = rewriteModuleSpecifiers(source, imports, (specifier) =>
				resolveModuleSpecifier(specifier, url, importMap),
			);
			try {
				const blob = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
				mappings[url] = blob;
				this.trackModuleBlob(tabId, blob);
			} catch {
				/* Blob creation is best effort; an unmapped module stays remote. */
			}
		}
		if (Object.keys(mappings).length === 0) return;

		const mergedImports = { ...importMap.imports, ...mappings };
		const mapScript = doc.createElement('script');
		mapScript.type = 'importmap';
		mapScript.textContent = JSON.stringify({
			imports: mergedImports,
			scopes: importMap.scopes,
		}).replace(/</g, '\\u003c');
		const firstModule = doc.querySelector('script[type="module"]');
		if (firstModule?.parentNode) firstModule.parentNode.insertBefore(mapScript, firstModule);
		else (doc.head ?? doc.documentElement).prepend(mapScript);

		for (const script of external) {
			let url: string;
			try {
				url = new URL(script.getAttribute('src') || '', baseUrl).href;
			} catch {
				continue;
			}
			const source = graph.get(url);
			if (!source) continue;
			const imports = await readModuleImports(source);
			const rewritten = rewriteModuleSpecifiers(source, imports, (specifier) =>
				resolveModuleSpecifier(specifier, url, importMap),
			);
			const node = doc.createElement('script');
			node.type = 'module';
			if (script.hasAttribute('async')) node.setAttribute('async', '');
			node.textContent = rewritten.replace(/<\/script/gi, '<\\/script');
			script.replaceWith(node);
		}

		for (const script of inline) {
			const source = script.textContent || '';
			const imports = await readModuleImports(source);
			const rewritten = rewriteModuleSpecifiers(source, imports, (specifier) =>
				resolveModuleSpecifier(specifier, pageUrl, importMap),
			);
			if (rewritten !== source) script.textContent = rewritten;
		}
	}

	private trackModuleBlob(tabId: string, blob: string): void {
		let urls = this.moduleBlobs.get(tabId);
		if (!urls) {
			urls = new Set();
			this.moduleBlobs.set(tabId, urls);
		}
		urls.add(blob);
	}

	private releaseModuleBlobs(tabId: string): void {
		const urls = this.moduleBlobs.get(tabId);
		if (!urls) return;
		for (const url of urls) URL.revokeObjectURL(url);
		this.moduleBlobs.delete(tabId);
	}

	private releaseAllModuleBlobs(): void {
		for (const tabId of Array.from(this.moduleBlobs.keys())) this.releaseModuleBlobs(tabId);
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
			const plugins = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
				?.Plugins;
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

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	}
	return btoa(binary);
}

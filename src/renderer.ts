import { injectBridge, postCookiesToFrame, registerBridgeChannel, unregisterBridgeChannel } from './bridge';
import { loadPage } from './proxy';
import type { CookieRecord, RenderMode } from './types';
import { generateId, hostOf } from './utils';

export interface NavigateOptions {
	method?: string;
	body?: string;
	contentType?: string;
}

export interface RendererEvents {
	onTitle(title: string): void;
	onError(message: string, options?: { suggestProxy?: boolean }): void;
	/** A script error inside the page. Not fatal: the page is still on screen. */
	onPageError(): void;
	onNavigate(url: string, options?: NavigateOptions): void;
	onOpenExternal(url: string): void;
	onCookie(raw: string, url: string): void;
	onReady(resolvedUrl: string): void;
}

export interface RendererContext {
	container: HTMLElement;
	url: string;
	displayUrl: string;
	cookies: CookieRecord[];
	proxyBase: string;
	/** When false, the native HTTP client is used instead of the proxy. */
	directFetch: boolean;
	/** Allow the page's own scripts to run in the sandboxed frame. */
	runScripts: boolean;
	events: RendererEvents;
}

export interface Renderer {
	readonly kind: RenderMode;
	mount(): Promise<void>;
	unmount(): void;
	setCookies(cookies: CookieRecord[]): void;
}

const IFRAME_CLASS = 'bfm-frame';
const LOAD_TIMEOUT_MS = 7000;
const BRIDGE_READY_FALLBACK_MS = 1500;

/**
 * Loads a URL straight into an iframe. Works for sites that allow framing and
 * benefits from the platform's own cookie and session handling, but a growing
 * number of sites refuse to be embedded.
 *
 * A refused embed cannot be detected from the host: the browser renders an
 * error page in the frame, and for any cross-origin frame `contentDocument` is
 * null regardless of whether the load succeeded. The caller therefore checks
 * the site's framing headers before choosing this renderer; here we only guard
 * against a frame that never finishes loading.
 */
export class DirectRenderer implements Renderer {
	readonly kind: RenderMode = 'direct';
	private frame: HTMLIFrameElement | null = null;
	private timer: number | null = null;
	private settled = false;

	constructor(private readonly context: RendererContext) {}

	async mount(): Promise<void> {
		const { container, url, events } = this.context;
		const frame = container.createEl('iframe', {
			cls: IFRAME_CLASS,
			attr: {
				src: url,
				sandbox:
					'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
				referrerpolicy: 'no-referrer',
			},
		});
		frame.setAttribute('allow', 'clipboard-write; fullscreen');
		this.frame = frame;

		frame.addEventListener('load', () => {
			if (this.settled) return;
			this.settled = true;
			this.clearTimer();
			events.onReady(url);
		});

		this.timer = window.setTimeout(() => {
			if (this.settled) return;
			this.settled = true;
			events.onError(
				'This site did not finish loading. It may refuse to be embedded.',
				{ suggestProxy: true },
			);
		}, LOAD_TIMEOUT_MS);
	}

	unmount(): void {
		this.clearTimer();
		this.frame?.remove();
		this.frame = null;
	}

	setCookies(): void {
		/* Direct frames use the platform's own cookie store. */
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}
}

/**
 * Fetches page HTML through the configured CORS proxy and renders it in an
 * opaque-origin sandboxed frame. Navigation and cookies are relayed through an
 * injected bridge script, so pages keep working without leaving the plugin.
 */
export class ProxyRenderer implements Renderer {
	readonly kind: RenderMode = 'proxy';
	private frame: HTMLIFrameElement | null = null;
	private channel = `bfm-${generateId()}`;
	private blobUrl: string | null = null;
	private readyTimer: number | null = null;

	constructor(private readonly context: RendererContext) {}

	async mount(): Promise<void> {
		const { container, url, cookies, proxyBase, directFetch, runScripts, events } =
			this.context;
		registerBridgeChannel(this.channel, (message) => {
			switch (message.type) {
				case 'title':
					events.onTitle(message.title);
					break;
				case 'navigate':
					events.onNavigate(message.url, {
						method: message.method,
						body: message.body,
						contentType: message.contentType,
					});
					break;
				case 'openExternal':
					events.onOpenExternal(message.url);
					break;
				case 'cookie':
					events.onCookie(message.raw, message.url);
					break;
				case 'error':
					// A page's own script error does not mean the page failed to
					// load; treating it as fatal would blank a page that rendered.
					events.onPageError();
					break;
				case 'ready':
					events.onReady(url);
					break;
			}
		});

		const result = await loadPage(url, {
			proxyBase,
			directFetch,
			runScripts,
			cookies,
			ignoreCookies: cookies.length === 0,
		});

		if (!result.ok) {
			unregisterBridgeChannel(this.channel);
			events.onError(result.message);
			return;
		}

		const parsed = safeUrl(result.url);
		const html = injectBridge(result.html, {
			channel: this.channel,
			host: parsed?.hostname.toLowerCase() ?? hostOf(url),
			path: parsed?.pathname ?? '/',
			baseUrl: result.url,
			cookies,
		});

		const frame = container.createEl('iframe', {
			cls: IFRAME_CLASS,
			attr: {
				sandbox: 'allow-scripts allow-forms allow-modals allow-downloads',
				referrerpolicy: 'no-referrer',
			},
		});
		frame.setAttribute('allow', 'clipboard-write; fullscreen');
		this.frame = frame;

		frame.addEventListener('load', () => {
			this.clearReadyTimer();
			postCookiesToFrame(frame, this.channel, this.context.cookies);
			events.onReady(result.url);
		});

		// srcdoc keeps the sandbox opaque while still resolving relative URLs
		// through the injected <base> tag.
		frame.srcdoc = html;

		// The bridge announces readiness on DOMContentLoaded. If that never
		// arrives the page is still usable, so stop showing the loading state.
		this.readyTimer = window.setTimeout(() => {
			this.readyTimer = null;
			events.onReady(result.url);
		}, BRIDGE_READY_FALLBACK_MS);
	}

	unmount(): void {
		unregisterBridgeChannel(this.channel);
		this.clearReadyTimer();
		if (this.blobUrl) {
			URL.revokeObjectURL(this.blobUrl);
			this.blobUrl = null;
		}
		this.frame?.remove();
		this.frame = null;
	}

	setCookies(cookies: CookieRecord[]): void {
		if (this.frame) postCookiesToFrame(this.frame, this.channel, cookies);
	}

	private clearReadyTimer(): void {
		if (this.readyTimer !== null) {
			window.clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}
	}
}

function safeUrl(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

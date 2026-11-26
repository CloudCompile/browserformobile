/**
 * The script injected into each page.
 *
 * It is serialised with `Function.prototype.toString()`, so every identifier it
 * uses at runtime must be declared inside the function. It runs in an `srcdoc`
 * iframe, which shares the parent's origin, so it can call the bridge directly.
 * The build target is ES2021 and esbuild does not inject helpers into this
 * function, which keeps the serialised source self-contained.
 */

interface BrowserBridgeRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

interface BrowserBridgeResponse {
	status: number;
	statusText: string;
	url: string;
	headers: Record<string, string>;
	bytes: Uint8Array;
}

interface BrowserBridge {
	request(options: BrowserBridgeRequest): Promise<BrowserBridgeResponse>;
	nav(tab: string, spec: Record<string, unknown>): void;
	title(tab: string, title: string): void;
	external(url: string): void;
	media(tab: string, items: unknown[]): void;
	download(tab: string, options: Record<string, unknown>): void;
}

interface InjectedConfig {
	tab: string;
	url: string;
}

export function injectedBrowserScript(cfg: InjectedConfig): void {
	const bridge = (window.parent as Window & { __bfmBrowser?: BrowserBridge }).__bfmBrowser;
	if (!bridge) return;
	const B = bridge;
	const TAB = cfg.tab;
	const reported = new Set<string>();
	const abs = (value: string): string => new URL(String(value), document.baseURI).href;
	const mediaKind = (url: string): string | null => {
		const clean = url.split('#')[0]?.split('?')[0] ?? '';
		const ext = /\.([a-z0-9]{1,8})$/i.exec(clean)?.[1]?.toLowerCase() ?? '';
		if (ext === 'm3u8') return 'hls';
		if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(ext)) return 'image';
		if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'].includes(ext)) return 'video';
		if (['mp3', 'm4a', 'aac', 'ogg', 'oga', 'wav', 'flac'].includes(ext)) return 'audio';
		return null;
	};
	const reportMedia = (
		url: string,
		extras: Record<string, unknown>,
		explicitKind?: string | null,
	): void => {
		if (!/^https?:/i.test(url)) return;
		const kind = explicitKind ?? mediaKind(url);
		if (!kind || reported.has(url)) return;
		reported.add(url);
		try {
			B.media(TAB, [{ url, kind, ...extras }]);
		} catch {
			/* A page can outlive the view during navigation. */
		}
	};
	const captureRequest = (url: string): void => {
		reportMedia(url, {});
	};
	const itemFor = (element: Element): Record<string, unknown> | null => {
		const tag = element.tagName;
		if (tag === 'IMG') {
			const image = element as HTMLImageElement;
			const url = image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || '';
			if (!url) return null;
			return { url: abs(url), kind: 'image', title: image.alt || image.title || '' };
		}
		if (tag === 'VIDEO') {
			const video = element as HTMLVideoElement;
			const source = video.currentSrc || video.getAttribute('src') || video.querySelector('source[src]')?.getAttribute('src') || '';
			if (!source) return null;
			return {
				url: abs(source),
				kind: 'video',
				title: video.title || '',
				poster: video.poster ? abs(video.poster) : undefined,
			};
		}
		if (tag === 'AUDIO') {
			const audio = element as HTMLAudioElement;
			const source = audio.currentSrc || audio.getAttribute('src') || audio.querySelector('source[src]')?.getAttribute('src') || '';
			if (!source) return null;
			return { url: abs(source), kind: 'audio', title: audio.title || '' };
		}
		if (tag === 'A') {
			const anchor = element as HTMLAnchorElement;
			const href = anchor.getAttribute('href');
			if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) return null;
			const kind = mediaKind(href);
			if (!kind) return null;
			return { url: abs(href), kind, title: (anchor.textContent || '').trim().slice(0, 120) };
		}
		return null;
	};
	const buildBody = async (body: unknown, headers: Record<string, string>): Promise<string | null> => {
		if (body == null) return null;
		if (typeof body === 'string') return body;
		if (body instanceof URLSearchParams) {
			if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
			return body.toString();
		}
		if (typeof FormData !== 'undefined' && body instanceof FormData) {
			const params = new URLSearchParams();
			body.forEach((value, key) => {
				if (typeof value === 'string') params.append(key, value);
			});
			headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
			return params.toString();
		}
		if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.text();
		if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
		if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
		try {
			return JSON.stringify(body) ?? '';
		} catch {
			return '';
		}
	};
	const cleanHeaders = (headers: Record<string, string> | undefined): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers ?? {})) {
			const lower = key.toLowerCase();
			if (lower === 'set-cookie' || lower === 'content-encoding' || lower === 'content-length' || lower === 'transfer-encoding') continue;
			out[key] = value;
		}
		return out;
	};

	window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const options = init ?? {};
		const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
		const source: string = request
			? request.url
			: input instanceof URL
				? input.href
				: typeof input === 'string'
					? input
					: input.url;
		const url = abs(source);
		const method = String(options.method ?? (request ? request.method : 'GET')).toUpperCase();
		const headers: Record<string, string> = {};
		try {
			new Headers(options.headers ?? (request ? request.headers : undefined)).forEach((value, key) => {
				headers[key] = value;
			});
		} catch {
			/* Ignore malformed request headers. */
		}
		let body = options.body !== undefined ? options.body : null;
		if (request && body === null && method !== 'GET' && method !== 'HEAD') body = await request.clone().text();
		body = method === 'GET' || method === 'HEAD' ? null : await buildBody(body, headers);
		if (!headers.referer) headers.referer = cfg.url;
		if (method !== 'GET' && !headers.origin) headers.origin = new URL(cfg.url).origin;
		captureRequest(url);
		const response = await B.request({ url, method, headers, body });
		const type = String(response.headers['content-type'] || '');
		if (/mpegurl/i.test(type)) reportMedia(response.url || url, { mime: type }, 'hls');
		const bytes = new Uint8Array(response.bytes);
		const empty = response.status === 101 || response.status === 204 || response.status === 205 || response.status === 304;
		const result = new Response(empty ? null : bytes, {
			status: response.status < 200 ? 200 : response.status,
			statusText: response.statusText || '',
			headers: cleanHeaders(response.headers),
		});
		try {
			Object.defineProperty(result, 'url', { value: response.url || url });
		} catch {
			/* The URL is informational; a read-only Response is still usable. */
		}
		return result;
	};

	class BrowserXHR extends EventTarget {
		readyState = 0;
		status = 0;
		statusText = '';
		response: unknown = null;
		responseText = '';
		responseURL = '';
		responseType = '';
		timeout = 0;
		withCredentials = false;
		upload = new EventTarget();
		onreadystatechange: ((event: Event) => void) | null = null;
		onload: ((event: Event) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onabort: ((event: Event) => void) | null = null;
		onloadend: ((event: Event) => void) | null = null;
		private method = 'GET';
		private url = '';
		private headers: Record<string, string> = {};
		private responseHeaders: Record<string, string> = {};
		private aborted = false;

		static UNSENT = 0;
		static OPENED = 1;
		static HEADERS_RECEIVED = 2;
		static LOADING = 3;
		static DONE = 4;

		private fire(type: string): void {
			const event = new Event(type);
			const owner = this as unknown as Record<string, unknown>;
			const handler = owner['on' + type];
			if (typeof handler === 'function') {
				try {
					(handler as (event: Event) => void).call(this, event);
				} catch (error) {
					console.error(error);
				}
			}
			this.dispatchEvent(event);
		}

		open(method: string, url: string | URL): void {
			this.method = String(method || 'GET').toUpperCase();
			this.url = abs(String(url));
			this.readyState = 1;
			this.fire('readystatechange');
		}

		setRequestHeader(key: string, value: string): void {
			const lower = String(key).toLowerCase();
			this.headers[lower] = this.headers[lower] ? `${this.headers[lower]}, ${value}` : String(value);
		}

		overrideMimeType(): void {
			/* Not needed by the plugin; accepted for compatibility. */
		}

		getResponseHeader(key: string): string | null {
			const value = this.responseHeaders[String(key).toLowerCase()];
			return value === undefined ? null : value;
		}

		getAllResponseHeaders(): string {
			return Object.keys(this.responseHeaders)
				.map((key) => `${key}: ${this.responseHeaders[key]}`)
				.join('\r\n') + '\r\n';
		}

		abort(): void {
			this.aborted = true;
			this.readyState = 0;
			this.fire('abort');
		}

		send(body?: unknown): void {
			const headers = Object.assign({}, this.headers);
			if (!headers.referer) headers.referer = cfg.url;
			if (this.method !== 'GET' && !headers.origin) headers.origin = new URL(cfg.url).origin;
			captureRequest(this.url);
			buildBody(this.method === 'GET' || this.method === 'HEAD' ? null : body, headers)
				.then((encoded) => B.request({ url: this.url, method: this.method, headers, body: encoded }))
				.then((response) => {
					if (this.aborted) return;
					this.status = response.status;
					this.statusText = response.statusText || '';
					this.responseURL = response.url || this.url;
					this.responseHeaders = cleanHeaders(response.headers);
					const type = String(response.headers['content-type'] || '');
					if (/mpegurl/i.test(type)) reportMedia(this.responseURL, { mime: type }, 'hls');
					const bytes = new Uint8Array(response.bytes);
					this.readyState = 2;
					this.fire('readystatechange');
					this.readyState = 3;
					this.fire('readystatechange');
					if (this.responseType === 'arraybuffer') {
						this.response = bytes.buffer;
					} else if (this.responseType === 'blob') {
						this.response = new Blob([bytes], { type: this.responseHeaders['content-type'] || '' });
					} else {
						const text = new TextDecoder('utf-8').decode(bytes);
						this.responseText = text;
						if (this.responseType === 'json') {
							try {
								this.response = JSON.parse(text);
							} catch {
								this.response = null;
							}
						} else if (this.responseType === 'document') {
							this.response = new DOMParser().parseFromString(text, 'text/html');
						} else {
							this.response = text;
						}
					}
					this.readyState = 4;
					this.fire('readystatechange');
					this.fire('load');
					this.fire('loadend');
				})
				.catch(() => {
					if (this.aborted) return;
					this.readyState = 4;
					this.fire('readystatechange');
					this.fire('error');
					this.fire('loadend');
				});
		}
	}
	window.XMLHttpRequest = BrowserXHR as unknown as typeof XMLHttpRequest;

	const originalPush = history.pushState.bind(history);
	const originalReplace = history.replaceState.bind(history);
	history.pushState = function (data: unknown, unused: string, url?: string | URL | null): void {
		try {
			originalPush(data, unused, url);
		} catch {
			/* srcdoc cannot hold a real site URL; the address bar tracks it instead. */
		}
	};
	history.replaceState = function (data: unknown, unused: string, url?: string | URL | null): void {
		try {
			originalReplace(data, unused, url);
		} catch {
			/* See above. */
		}
	};

	window.open = function (url?: string | URL): Window | null {
		if (url) {
			try {
				B.nav(TAB, { url: abs(String(url)), newTab: true });
			} catch {
				/* The view may have closed. */
			}
		}
		return null;
	};

	document.addEventListener(
		'click',
		(event: MouseEvent) => {
			if (event.defaultPrevented || event.button !== 0) return;
			const target = event.target as Element | null;
			const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
			if (!anchor) return;
			const raw = anchor.getAttribute('href') || '';
			if (/^(mailto:|tel:|intent:|market:)/i.test(raw)) {
				event.preventDefault();
				B.external(raw);
				return;
			}
			if (/^(javascript:|data:|blob:)/i.test(raw)) return;
			let url: URL;
			try {
				url = new URL(anchor.href, document.baseURI);
			} catch {
				return;
			}
			if (anchor.hasAttribute('download')) {
				event.preventDefault();
				B.download(TAB, {
					url: url.href,
					filename: anchor.getAttribute('download') || '',
					referer: cfg.url,
				});
				return;
			}
			event.preventDefault();
			if (url.href.split('#')[0] === cfg.url.split('#')[0] && url.hash !== '') {
				const id = decodeURIComponent(url.hash.slice(1));
				const element = id && (document.getElementById(id) || document.getElementsByName(id)[0]);
				if (element) element.scrollIntoView();
				return;
			}
			B.nav(TAB, { url: url.href, newTab: anchor.target === '_blank' });
		},
		true,
	);

	document.addEventListener(
		'contextmenu',
		(event: MouseEvent) => {
			const target = event.target as Element | null;
			const element = target?.closest?.('img, video, audio, a[href]');
			if (!element) return;
			const item = itemFor(element);
			if (!item) return;
			event.preventDefault();
			try {
				B.media(TAB, [item]);
			} catch {
				/* The view may have closed. */
			}
		},
		true,
	);

	document.addEventListener(
		'submit',
					(event: SubmitEvent) => {
				if (event.defaultPrevented) return;
				const form = event.target;
				if (!(form instanceof HTMLFormElement)) return;
				event.preventDefault();
								const submitter = event.submitter;
			const method = String(
				submitter?.getAttribute('formmethod') || form.getAttribute('method') || 'GET',
			).toUpperCase();
			const action = new URL(
				submitter?.getAttribute('formaction') || form.getAttribute('action') || document.baseURI,
				document.baseURI,
			);
			const data = new FormData(form);
			const submitterName = submitter?.getAttribute('name');
			if (submitterName) data.append(submitterName, submitter?.getAttribute('value') ?? '');
			const params = new URLSearchParams();
			data.forEach((value, key) => {
				if (typeof value === 'string') params.append(key, value);
			});
			if (method === 'POST') {
				B.nav(TAB, {
					url: action.href,
					method: 'POST',
					body: params.toString(),
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
				});
			} else {
				action.search = params.toString();
				B.nav(TAB, { url: action.href });
			}
		},
		true,
	);
	HTMLFormElement.prototype.submit = function (): void {
		if (this.requestSubmit) this.requestSubmit();
	};

	// Mobile WebViews only play inline when the attribute is present, and many
	// sites add their video element after the first load.
	const prepareVideos = (): void => {
		for (const video of Array.from(document.querySelectorAll('video'))) {
			video.setAttribute('playsinline', '');
			video.setAttribute('webkit-playsinline', '');
		}
	};
	prepareVideos();
	window.addEventListener('load', prepareVideos);
	try {
		new MutationObserver(prepareVideos).observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
	} catch {
		/* Video preparation is best effort. */
	}

	let lastTitle = '';
	const reportTitle = (): void => {
		const title = document.title || '';
		if (!title || title === lastTitle) return;
		lastTitle = title;
		try {
			B.title(TAB, title);
		} catch {
			/* The view may have closed. */
		}
	};
	window.addEventListener('load', reportTitle);
	try {
		new MutationObserver(reportTitle).observe(document.head || document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	} catch {
		/* Title reporting is best effort. */
	}
}

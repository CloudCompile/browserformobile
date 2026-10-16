import { requestUrl } from 'obsidian';
import type { CookieRecord } from './types';

export interface ProxySuccess {
	ok: true;
	/** Absolute URL after following redirects, when the proxy reports it. */
	url: string;
	contentType: string;
	/** Page HTML with `<base>` injected and remote scripts neutralised. */
	html: string;
}

export interface ProxyFailure {
	ok: false;
	status: number;
	message: string;
}

export type ProxyResult = ProxySuccess | ProxyFailure;

export interface ProxyRequestOptions {
	/** Overrides the settings value when supplied. */
	proxyBase?: string;
	method?: string;
	body?: string;
	contentType?: string;
	cookies?: CookieRecord[];
	/** Skip cookie attachment (used for cookie-less reloads). */
	ignoreCookies?: boolean;
	/** Set to false to force every request through the proxy. */
	directFetch?: boolean;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 900;

/** Default CORS proxy endpoint, shared with the settings defaults. */
export const DEFAULT_PROXY_BASE = 'https://api.allorigins.win/get?url=';

interface ProxyEndpoint {
	base: string;
	headers?: Record<string, string>;
}

/**
 * Endpoints tried in order after the default proxy fails. Public proxies are
 * unreliable and the default allorigins endpoint regularly returns 5xx, so a
 * single failure should not leave the page unloadable. Each base accepts the
 * target URL appended, encoded, and only page HTML is requested. r.jina.ai
 * needs an explicit header or it returns markdown instead of HTML.
 */
const FALLBACK_PROXIES: ProxyEndpoint[] = [
	{ base: 'https://r.jina.ai/', headers: { 'x-respond-with': 'html' } },
	{ base: 'https://api.allorigins.win/raw?url=' },
];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Build the `<base>` tag so relative links and assets resolve against the real
 * site rather than the Blob URL the document is served from.
 */
function baseTag(target: URL): string {
	const href = `${target.protocol}//${target.host}${target.pathname}${target.search}`;
	return `<base href="${escapeHtml(href)}">`;
}

function stripIntegrity(html: string): string {
	return html
		.replace(/\sintegrity\s*=\s*"[^"]*"/gi, '')
		.replace(/\sintegrity\s*=\s*'[^']*'/gi, '');
}

function neutraliseMeta(html: string): string {
	return html.replace(
		/<meta\b[^>]*http-equiv\s*=\s*["']?(content-security-policy|x-frame-options|refresh)["']?[^>]*>/gi,
		'<!-- removed restrictive meta -->',
	);
}

function injectAfterHeadOpen(html: string, injection: string): string {
	const match = /<head\b[^>]*>/i.exec(html);
	if (match && match.index >= 0) {
		const at = match.index + match[0].length;
		return `${html.slice(0, at)}${injection}${html.slice(at)}`;
	}
	const htmlOpen = /<html\b[^>]*>/i.exec(html);
	if (htmlOpen && htmlOpen.index >= 0) {
		const at = htmlOpen.index + htmlOpen[0].length;
		return `${html.slice(0, at)}<head>${injection}</head>${html.slice(at)}`;
	}
	return `${injection}${html}`;
}

/**
 * Add `<base>`, remove integrity attributes and restrictive meta tags, and
 * disable remote scripts. Inline scripts are kept so pages that render on the
 * client still work; the browser view runs them in a sandboxed frame.
 */
export function rewriteHtml(html: string, targetUrl: string): string {
	let target: URL;
	try {
		target = new URL(targetUrl);
	} catch {
		return html;
	}
	let output = neutraliseMeta(html);
	output = stripIntegrity(output);
	output = output.replace(
		/<script\b([^>]*)\ssrc\s*=\s*(["'])(.*?)\2([^>]*)>/gi,
		(_match, before: string, _quote: string, src: string, after: string) =>
			`<script${before} data-blocked-src="${escapeHtml(src)}"${after}>/* remote script blocked */</script>`,
	);
	output = injectAfterHeadOpen(output, baseTag(target));
	return output;
}

function buildProxyUrl(proxyBase: string, targetUrl: string): string {
	const encoded = encodeURIComponent(targetUrl);
	if (proxyBase.includes('%s')) {
		return proxyBase.replace('%s', encoded);
	}
	return `${proxyBase}${encoded}`;
}

function cookieHeaderFor(target: URL, cookies: CookieRecord[]): string {
	const now = Date.now();
	const host = target.hostname.toLowerCase();
	const matches = cookies.filter((cookie) => {
		if (cookie.expires !== null && cookie.expires < now) return false;
		const domain = cookie.domain.replace(/^\./, '').toLowerCase();
		if (!host.endsWith(domain)) return false;
		if (cookie.secure && target.protocol !== 'https:') return false;
		const path = cookie.path || '/';
		if (!target.pathname.startsWith(path)) return false;
		return true;
	});
	return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function readProxyPayload(
	status: number,
	contentType: string,
	text: string,
	targetUrl: string,
): ProxyResult {
	if (status >= 400) {
		return { ok: false, status, message: `Proxy responded with ${status}.` };
	}
	const looksJson = contentType.includes('application/json') || /^\s*\{/.test(text);
	if (looksJson) {
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			return { ok: false, status, message: 'The proxy returned invalid JSON.' };
		}
		const record = payload as {
			contents?: unknown;
			status?: { http_code?: number; url?: string; content_type?: string };
		};
		const upstreamStatus = record.status?.http_code ?? 200;
		if (upstreamStatus >= 400) {
			return {
				ok: false,
				status: upstreamStatus,
				message: `The site returned ${upstreamStatus}.`,
			};
		}
		const contents = typeof record.contents === 'string' ? record.contents : '';
		if (contents.trim() === '') {
			return {
				ok: false,
				status,
				message: 'The proxy returned an empty page for this address.',
			};
		}
		const resolved = record.status?.url ?? targetUrl;
		return {
			ok: true,
			url: resolved,
			contentType: record.status?.content_type ?? 'text/html',
			html: rewriteHtml(contents, resolved),
		};
	}
	return {
		ok: true,
		url: targetUrl,
		contentType: contentType || 'text/html',
		html: rewriteHtml(text, targetUrl),
	};
}

function buildHeaders(
	target: URL,
	options: ProxyRequestOptions,
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		'Accept-Language': 'en-US,en;q=0.9',
	};
	if (!options.ignoreCookies && options.cookies && options.cookies.length > 0) {
		const cookie = cookieHeaderFor(target, options.cookies);
		if (cookie) headers.Cookie = cookie;
	}
	return headers;
}

/**
 * Fetch the page with Obsidian's native HTTP client. On mobile this is the
 * platform's own networking stack and on desktop it is Electron's, so it is not
 * subject to the browser's same-origin rules and needs no third-party proxy.
 * This is the preferred path: it is faster, private, and returns the live page.
 */
async function directRequest(
	url: string,
	target: URL,
	options: ProxyRequestOptions,
): Promise<ProxyResult> {
	const method = options.method ?? 'GET';
	try {
		const response = await requestUrl({
			url,
			method,
			headers: buildHeaders(target, options),
			body: options.body,
			contentType: options.contentType,
			throw: false,
		});
		if (response.status >= 400) {
			return {
				ok: false,
				status: response.status,
				message: `The site returned ${response.status}.`,
			};
		}
		const contentType = response.headers['content-type'] ?? '';
		if (contentType && !/html|xml|text/i.test(contentType)) {
			return {
				ok: false,
				status: response.status,
				message: `This address is not a web page (${contentType}).`,
			};
		}
		return {
			ok: true,
			url,
			contentType: contentType || 'text/html',
			html: rewriteHtml(response.text, url),
		};
	} catch (error) {
		return {
			ok: false,
			status: 0,
			message: error instanceof Error ? error.message : 'Network request failed.',
		};
	}
}

/**
 * Decide whether a page can be framed from its response headers. Cross-origin
 * frames cannot be inspected from the host, and Chromium's blocked-frame error
 * page looks exactly like a normal cross-origin document (`contentDocument` is
 * null either way), so headers are the only reliable signal. A blocked embed
 * otherwise renders an empty frame with no error, which is what made direct
 * mode look broken.
 */
export function framePolicyFromHeaders(headers: Record<string, string>): {
	blocked: boolean;
	reason?: string;
} {
	const lower: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		lower[key.toLowerCase()] = value;
	}
	const xfo = lower['x-frame-options']?.trim().toLowerCase();
	if (xfo) {
		if (xfo.includes('deny')) {
			return { blocked: true, reason: 'This site refuses to be embedded (X-Frame-Options: deny).' };
		}
		if (xfo.includes('sameorigin')) {
			return {
				blocked: true,
				reason: 'This site only allows being embedded by itself (X-Frame-Options: SAMEORIGIN).',
			};
		}
	}
	const csp = lower['content-security-policy'];
	if (csp) {
		const match = /frame-ancestors([^;]*)/i.exec(csp);
		if (match && match[1]) {
			const value = match[1].trim().toLowerCase();
			if (value.includes('none') || value.includes("'self'") || value.includes('self')) {
				return {
					blocked: true,
					reason: 'This site only allows being embedded by itself (Content-Security-Policy frame-ancestors).',
				};
			}
		}
	}
	return { blocked: false };
}

const framePolicyCache = new Map<string, { blocked: boolean; reason?: string }>();

/**
 * Ask the site for its framing policy with a lightweight HEAD request. Direct
 * mode cannot detect a refused embed after the fact, so the plugin checks the
 * headers up front and picks the proxy instead of rendering an empty frame.
 * Failures here are non-fatal: an unknown policy is treated as frameable.
 */
export async function probeFramePolicy(
	url: string,
	options: ProxyRequestOptions = {},
): Promise<{ blocked: boolean; reason?: string }> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return { blocked: false };
	}
	const cached = framePolicyCache.get(target.origin);
	if (cached) return cached;
	const headers = buildHeaders(target, options);
	try {
		const head = await requestUrl({
			url,
			method: 'HEAD',
			headers,
			throw: false,
		});
		if (head.status < 400) {
			const policy = framePolicyFromHeaders(head.headers ?? {});
			framePolicyCache.set(target.origin, policy);
			return policy;
		}
	} catch {
		/* Fall through to a GET, which some servers prefer over HEAD. */
	}
	try {
		const get = await requestUrl({ url, method: 'GET', headers, throw: false });
		if (get.status >= 400) return { blocked: false };
		const policy = framePolicyFromHeaders(get.headers ?? {});
		framePolicyCache.set(target.origin, policy);
		return policy;
	} catch {
		return { blocked: false };
	}
}

/**
 * Fetch a page for the browser view. Tries the native HTTP client first and
 * falls back to the configured CORS proxy, which is only needed when the direct
 * request is refused or the user has opted to always proxy.
 */
export async function loadPage(
	url: string,
	options: ProxyRequestOptions = {},
): Promise<ProxyResult> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return { ok: false, status: 0, message: 'The address is not a valid URL.' };
	}
	if (target.protocol !== 'http:' && target.protocol !== 'https:') {
		return { ok: false, status: 0, message: 'Only http and https addresses can be opened.' };
	}

	if (options.directFetch !== false) {
		const direct = await directRequest(url, target, options);
		if (direct.ok) return direct;
		if (!options.proxyBase) return direct;
	}

	return proxyRequest(url, options);
}

/**
 * Fetch a page through the CORS proxy. Retries transient failures because
 * public proxies such as allorigins.win occasionally return 5xx responses, and
 * tries a couple of fallback endpoints when the configured one keeps failing.
 */
export async function proxyRequest(
	url: string,
	options: ProxyRequestOptions = {},
): Promise<ProxyResult> {
	const proxyBase = options.proxyBase;
	if (!proxyBase) {
		return { ok: false, status: 0, message: 'No CORS proxy is configured.' };
	}
	const method = options.method ?? 'GET';
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return { ok: false, status: 0, message: 'The address is not a valid URL.' };
	}

	const headers = buildHeaders(target, options);

	// The configured endpoint is authoritative, so only add fallbacks for plain
	// GETs; a POST body cannot be replayed against a different proxy.
	const endpoints: ProxyEndpoint[] = [{ base: proxyBase }];
	if (method === 'GET') {
		for (const fallback of FALLBACK_PROXIES) {
			if (fallback.base !== proxyBase) endpoints.push(fallback);
		}
	}

	let lastMessage = 'The proxy could not load the page.';
	let lastStatus = 0;

	for (const endpoint of endpoints) {
		const requestUrlValue = buildProxyUrl(endpoint.base, url);
		const endpointHeaders = endpoint.headers
			? { ...headers, ...endpoint.headers }
			: headers;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			try {
				const response = await requestUrl({
					url: requestUrlValue,
					method,
					headers: endpointHeaders,
					body: options.body,
					contentType: options.contentType,
					throw: false,
				});
				lastStatus = response.status;
				const contentType = response.headers['content-type'] ?? '';
				const result = readProxyPayload(response.status, contentType, response.text, url);
				if (result.ok) return result;
				lastMessage = result.message;
				// A definitive client error will not be fixed by retrying.
				if (response.status < 500) return result;
			} catch (error) {
				lastMessage = error instanceof Error ? error.message : 'Network request failed.';
				lastStatus = 0;
			}
			if (attempt < MAX_ATTEMPTS - 1) {
				await sleep(RETRY_DELAY_MS * (attempt + 1));
			}
		}
	}

	return { ok: false, status: lastStatus, message: lastMessage };
}

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
	/**
	 * True when this endpoint could not serve the request but a different
	 * endpoint still might (bad payload, empty body, upstream error page). A
	 * definitive failure — the site itself returning 404 — leaves this unset so
	 * the chain stops instead of hammering every proxy.
	 */
	endpointFailure?: boolean;
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
	/** Allow the page's own scripts to run in the sandboxed frame. */
	runScripts?: boolean;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 900;

/** Default CORS proxy endpoint, shared with the settings defaults. */
export const DEFAULT_PROXY_BASE = 'https://api.allorigins.win/get?url=';

interface ProxyEndpoint {
	base: string;
	headers?: Record<string, string>;
	/** Methods this endpoint relays. Defaults to GET only. */
	methods?: string[];
}

/**
 * Endpoints tried in order after the default proxy fails. Public proxies are
 * unreliable and the default allorigins endpoint regularly returns 5xx, so a
 * single failure should not leave the page unloadable. Each base accepts the
 * target URL appended, encoded, and only page HTML is requested. r.jina.ai
 * needs an explicit header or it returns markdown instead of HTML.
 */
const FALLBACK_PROXIES: ProxyEndpoint[] = [
	{
		base: 'https://cors-proxy.christopher-j-hauser2025.workers.dev/?url=',
		methods: ['GET', 'POST'],
	},
	{ base: 'https://r.jina.ai/', headers: { 'x-respond-with': 'html' } },
	{ base: 'https://api.cors.lol/?url=' },
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

/**
 * Elements whose bodies are raw text: the HTML parser does not interpret markup
 * inside them, so the rewriter must not either. `script` is handled separately
 * by {@link blockRemoteScripts}; the rest are copied verbatim.
 */
const RAW_TEXT_ELEMENTS = 'script|style|textarea|title';
const OTHER_RAW_TEXT = 'style|textarea|title';

/**
 * Run `transform` on the parts of the document that are markup, leaving opaque
 * regions untouched. Script bodies are opaque: a page may hold markup in a
 * string (DuckDuckGo's loader writes `<script src=...>` via `document.write`),
 * and rewriting inside it would emit a literal `</script>` that ends the real
 * block early and breaks the page.
 */
function transformOutsideOpaqueBlocks(
	html: string,
	transform: (chunk: string) => string,
): string {
	const opaque = new RegExp(
		`<(${RAW_TEXT_ELEMENTS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
		'gi',
	);
	let result = '';
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = opaque.exec(html)) !== null) {
		result += transform(html.slice(last, match.index));
		result += match[0];
		last = match.index + match[0].length;
	}
	return result + transform(html.slice(last));
}

/**
 * Replace remote `<script src=...>` tags with inert placeholders.
 *
 * This walks the document as the HTML parser would. An inline script body ends
 * at the first real `</script>`, so any `<script src=...>` appearing before that
 * is a string inside the script (DuckDuckGo's loader writes one via
 * `document.write`) and must be left alone; rewriting it would emit a literal
 * `</script>` and truncate the block. Only a tag at markup level is neutralised.
 */
function blockRemoteScripts(html: string): string {
	const openTag = /^<script\b[^>]*>/i;
	const rawText = new RegExp(`^<(${OTHER_RAW_TEXT})\\b[^>]*>`, 'i');
	const closeTag = /<\/script\s*>/i;
	let result = '';
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		if (lt === -1) {
			result += html.slice(i);
			break;
		}
		result += html.slice(i, lt);
		const rest = html.slice(lt);

		// Raw-text bodies (style, textarea, title) contain no tags: copy verbatim.
		const raw = rawText.exec(rest);
		if (raw) {
			const name = raw[1];
			const after = lt + raw[0].length;
			const close = new RegExp(`</${name}\\s*>`, 'i').exec(html.slice(after));
			const end = close ? after + close.index + close[0].length : html.length;
			result += html.slice(lt, end);
			i = end;
			continue;
		}

		const open = openTag.exec(rest);
		if (!open) {
			result += '<';
			i = lt + 1;
			continue;
		}
		const tag = open[0];
		const after = lt + tag.length;
		const close = closeTag.exec(html.slice(after));
		const end = close ? after + close.index + close[0].length : html.length;

		if (/\ssrc\s*=/i.test(tag)) {
			// Replace the whole tag so the original src (and integrity) is gone.
			const src = /\ssrc\s*=\s*(["']?)([^"'>\s]*)\1/i.exec(tag);
			result += `<script data-blocked-src="${escapeHtml(src?.[2] ?? '')}">/* remote script blocked */</script>`;
		} else {
			// Inline script: copy the body verbatim so nothing inside is rewritten.
			result += html.slice(lt, end);
		}
		i = end;
	}
	return result;
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
 * Add `<base>` and remove integrity attributes and restrictive meta tags.
 * Remote scripts are disabled unless `runScripts` is set; when they are kept,
 * inline scripts still run, so client-rendered pages work in the sandboxed
 * frame. The frame is opaque either way, so pages cannot reach the plugin.
 */
export function rewriteHtml(html: string, targetUrl: string, runScripts = false): string {
	let target: URL;
	try {
		target = new URL(targetUrl);
	} catch {
		return html;
	}
	let output = transformOutsideOpaqueBlocks(html, (chunk) =>
		stripIntegrity(neutraliseMeta(chunk)),
	);
	// Blocking scripts is a privacy measure, not a requirement of the frame: the
	// sandbox already runs scripts. Keeping them off breaks every site that
	// renders on the client, so it is opt-out.
	output = runScripts ? stripIntegrity(output) : blockRemoteScripts(output);
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
	runScripts: boolean,
): ProxyResult {
	if (status >= 500) {
		// A 5xx is the proxy failing, not the site: another endpoint may still work.
		return {
			ok: false,
			status,
			message: `Proxy responded with ${status}.`,
			endpointFailure: true,
		};
	}
	if (status >= 400) {
		return { ok: false, status, message: `Proxy responded with ${status}.` };
	}
	const looksJson = contentType.includes('application/json') || /^\s*\{/.test(text);
	if (looksJson) {
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			return {
				ok: false,
				status,
				message: 'The proxy returned invalid JSON.',
				endpointFailure: true,
			};
		}
		const record = payload as {
			contents?: unknown;
			status?: { http_code?: number; url?: string; content_type?: string };
		};
		const upstreamStatus = record.status?.http_code ?? 200;
		if (upstreamStatus >= 500) {
			// The site errored transiently; a different proxy may reach it.
			return {
				ok: false,
				status: upstreamStatus,
				message: `The site returned ${upstreamStatus}.`,
				endpointFailure: true,
			};
		}
		if (upstreamStatus >= 400) {
			// 4xx is the site's own verdict — retrying elsewhere will not help.
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
				endpointFailure: true,
			};
		}
		const resolved = record.status?.url ?? targetUrl;
		return {
			ok: true,
			url: resolved,
			contentType: record.status?.content_type ?? 'text/html',
			html: rewriteHtml(contents, resolved, runScripts),
		};
	}
	return {
		ok: true,
		url: targetUrl,
		contentType: contentType || 'text/html',
		html: rewriteHtml(text, targetUrl, runScripts),
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
			html: rewriteHtml(response.text, url, options.runScripts),
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
 * null either way), so headers are the only reliable signal. Without this check
 * a blocked embed renders `ERR_BLOCKED_BY_RESPONSE` and looks like a dead page.
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
			return {
				blocked: true,
				reason: 'This site refuses to be embedded (X-Frame-Options: deny).',
			};
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
			if (value.includes('none') || value.includes('self')) {
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
 * Ask the site for its framing policy before choosing the direct renderer.
 * Direct mode cannot detect a refused embed after the fact, so the plugin reads
 * the headers up front and picks the proxy instead of rendering a blocked frame.
 *
 * A GET is used rather than a HEAD because some servers only attach framing
 * headers to a real navigation — news.ycombinator.com sends
 * `X-Frame-Options: DENY` on GET but nothing on HEAD, so a HEAD-only check would
 * miss it. Results are cached per origin. Failures are non-fatal: an unknown
 * policy is treated as frameable so the direct path still gets its chance.
 */
export async function probeFramePolicy(
	url: string,
): Promise<{ blocked: boolean; reason?: string }> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return { blocked: false };
	}
	const cached = framePolicyCache.get(target.origin);
	if (cached) return cached;
	const headers = buildHeaders(target, {});
	// A cheap HEAD is conclusive when it already advertises a refusal.
	try {
		const head = await requestUrl({ url, method: 'HEAD', headers, throw: false });
		if (head.status < 400) {
			const policy = framePolicyFromHeaders(head.headers ?? {});
			if (policy.blocked) {
				framePolicyCache.set(target.origin, policy);
				return policy;
			}
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

	// A user who points the plugin at their own proxy expects only that endpoint
	// to be used, so the public fallbacks apply solely to the shipped default.
	// Endpoints that cannot relay the current method (a POST body cannot be
	// replayed everywhere) are skipped.
	const endpoints: ProxyEndpoint[] = [{ base: proxyBase }];
	if (proxyBase === DEFAULT_PROXY_BASE) {
		for (const fallback of FALLBACK_PROXIES) {
			const allowed = fallback.methods ?? ['GET'];
			if (allowed.includes(method)) endpoints.push(fallback);
		}
	}

	let lastMessage = 'The proxy could not load the page.';
	let lastStatus = 0;

	for (const endpoint of endpoints) {
		const requestUrlValue = buildProxyUrl(endpoint.base, url);
		const endpointHeaders = endpoint.headers
			? { ...headers, ...endpoint.headers }
			: headers;
		let endpointFailed = false;
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
				const result = readProxyPayload(
					response.status,
					contentType,
					response.text,
					url,
					options.runScripts === true,
				);
				if (result.ok) return result;
				lastMessage = result.message;
				// The endpoint answered but could not serve the page. Move on to
				// the next proxy rather than retrying a body that will not change.
				if (result.endpointFailure) {
					endpointFailed = true;
					break;
				}
				// A definitive client error will not be fixed by retrying, but a
				// rate limit or timeout is transient, so keep trying other endpoints.
				const transient = response.status === 429 || response.status === 408;
				if (response.status < 500 && !transient) return result;
			} catch (error) {
				lastMessage = error instanceof Error ? error.message : 'Network request failed.';
				lastStatus = 0;
			}
			if (attempt < MAX_ATTEMPTS - 1) {
				await sleep(RETRY_DELAY_MS * (attempt + 1));
			}
		}
		if (endpointFailed) continue;
	}

	return { ok: false, status: lastStatus, message: lastMessage };
}

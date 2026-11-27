/**
 * A cookie jar for pages rendered through the native HTTP layer.
 *
 * A page in the browser is served from `srcdoc`, so the WebView's own cookie
 * store belongs to Obsidian, not to the site. Native requests therefore have to
 * carry the site's cookies explicitly, and `document.cookie` has to be bridged
 * back to this jar. Only non-session cookies are persisted; a session cookie
 * should not outlive the app run that received it.
 */

export type BrowserSameSite = 'Strict' | 'Lax' | 'None';

export interface BrowserCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	/** Epoch milliseconds, or null for a session cookie. */
	expires: number | null;
	secure: boolean;
	httpOnly: boolean;
	sameSite: BrowserSameSite | null;
	/** True when the cookie came from a Set-Cookie without a Domain attribute. */
	hostOnly: boolean;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function normaliseHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, '');
}

function defaultPath(pathname: string): string {
	if (!pathname || !pathname.startsWith('/')) return '/';
	const index = pathname.lastIndexOf('/');
	return index <= 0 ? '/' : pathname.slice(0, index);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
	if (requestPath === cookiePath) return true;
	if (!requestPath.startsWith(cookiePath)) return false;
	if (cookiePath.endsWith('/')) return true;
	return requestPath.charAt(cookiePath.length) === '/';
}

function domainMatches(host: string, cookie: BrowserCookie): boolean {
	if (cookie.hostOnly) return host === cookie.domain;
	return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function isExpired(cookie: BrowserCookie, now: number): boolean {
	return cookie.expires !== null && cookie.expires <= now;
}

/** Parse one Set-Cookie header. Returns null for a malformed or foreign cookie. */
export function parseSetCookie(header: string, requestUrl: string): BrowserCookie | null {
	const value = header.trim();
	if (!value) return null;
	const pieces = value.split(';');
	const pair = pieces.shift() ?? '';
	const equals = pair.indexOf('=');
	if (equals <= 0) return null;
	const name = pair.slice(0, equals).trim();
	const cookieValue = pair.slice(equals + 1).trim();
	if (!TOKEN.test(name)) return null;

	let url: URL;
	try {
		url = new URL(requestUrl);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	const host = normaliseHost(url.hostname);
	let domain = host;
	let hostOnly = true;
	let path = defaultPath(url.pathname);
	let expires: number | null = null;
	let maxAge: number | null = null;
	let secure = false;
	let httpOnly = false;
	let sameSite: BrowserSameSite | null = null;
	const now = Date.now();

	for (const piece of pieces) {
		const index = piece.indexOf('=');
		const key = (index < 0 ? piece : piece.slice(0, index)).trim().toLowerCase();
		const raw = index < 0 ? '' : piece.slice(index + 1).trim();
		if (key === 'domain' && raw) {
			const candidate = normaliseHost(raw.replace(/^\./, ''));
			if (!candidate) continue;
			if (candidate !== host && !host.endsWith(`.${candidate}`)) return null;
			domain = candidate;
			hostOnly = false;
		} else if (key === 'path' && raw.startsWith('/')) {
			path = raw;
		} else if (key === 'expires' && raw) {
			const parsed = Date.parse(raw);
			if (Number.isFinite(parsed)) expires = parsed;
		} else if (key === 'max-age' && raw) {
			const seconds = Number(raw);
			if (Number.isFinite(seconds)) maxAge = now + seconds * 1000;
		} else if (key === 'secure') {
			secure = true;
		} else if (key === 'httponly') {
			httpOnly = true;
		} else if (key === 'samesite' && raw) {
			const normalised = raw.toLowerCase();
			if (normalised === 'strict') sameSite = 'Strict';
			else if (normalised === 'lax') sameSite = 'Lax';
			else if (normalised === 'none') sameSite = 'None';
		}
	}

	if (maxAge !== null) expires = maxAge;
	// A Secure cookie set over http would never be sent back; accepting it only
	// creates a cookie that silently does nothing.
	if (secure && url.protocol !== 'https:') return null;
	return { name, value: cookieValue, domain, path, expires, secure, httpOnly, sameSite, hostOnly };
}

/**
 * The Cookie header for a request. Longer paths come first, which is the order
 * servers expect when two cookies share a name at different paths.
 */
export function cookieHeader(cookies: BrowserCookie[], requestUrl: string, now = Date.now()): string {
	let url: URL;
	try {
		url = new URL(requestUrl);
	} catch {
		return '';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
	const host = normaliseHost(url.hostname);
	const path = url.pathname || '/';
	return cookies
		.filter(
			(cookie) =>
				!isExpired(cookie, now) &&
				domainMatches(host, cookie) &&
				pathMatches(path, cookie.path) &&
				(!cookie.secure || url.protocol === 'https:'),
		)
		.sort((left, right) => right.path.length - left.path.length)
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join('; ');
}

function sameCookie(left: BrowserCookie, right: BrowserCookie): boolean {
	return (
		left.name === right.name &&
		left.domain === right.domain &&
		left.path === right.path &&
		left.hostOnly === right.hostOnly
	);
}

/** A mutable cookie store shared by the native request layer and page script. */
export class BrowserCookieJar {
	private cookies: BrowserCookie[] = [];
	private change: (() => void) | null = null;

	constructor(initial: BrowserCookie[] = []) {
		this.load(initial);
	}

	onChange(listener: () => void): void {
		this.change = listener;
	}

	load(cookies: BrowserCookie[]): void {
		const now = Date.now();
		this.cookies = cookies.filter(
			(cookie) =>
				typeof cookie?.name === 'string' &&
				typeof cookie.value === 'string' &&
				typeof cookie.domain === 'string' &&
				typeof cookie.path === 'string' &&
				(cookie.expires === null || cookie.expires > now),
		);
	}

	all(): BrowserCookie[] {
		this.prune();
		return this.cookies.map((cookie) => ({ ...cookie }));
	}

	/** Only cookies a normal browser would persist across a restart. */
	persisted(): BrowserCookie[] {
		return this.all().filter((cookie) => cookie.expires !== null);
	}

	headerFor(url: string, includeHttpOnly = true): string {
		const cookies = includeHttpOnly ? this.cookies : this.cookies.filter((cookie) => !cookie.httpOnly);
		return cookieHeader(cookies, url);
	}

	/** Apply one Set-Cookie header. Returns true when the jar changed. */
	store(header: string, requestUrl: string): boolean {
		const cookie = parseSetCookie(header, requestUrl);
		if (!cookie) return false;
		const now = Date.now();
		const index = this.cookies.findIndex((entry) => sameCookie(entry, cookie));
		if (cookie.expires !== null && cookie.expires <= now) {
			if (index >= 0) this.cookies.splice(index, 1);
			else return false;
		} else if (index >= 0) {
			this.cookies[index] = cookie;
		} else {
			this.cookies.push(cookie);
		}
		this.change?.();
		return true;
	}

	storeAll(headers: string[] | undefined, requestUrl: string): void {
		for (const header of headers ?? []) this.store(header, requestUrl);
	}

	/** Handle a page's `document.cookie = "name=value; Path=/..."` write. */
	write(requestUrl: string, value: string): void {
		this.store(value, requestUrl);
	}

	prune(): void {
		const now = Date.now();
		this.cookies = this.cookies.filter((cookie) => !isExpired(cookie, now));
	}
}

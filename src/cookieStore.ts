import type { CookieRecord } from './types';

/** Remove expired cookies and duplicates, keeping the most recent value. */
export function pruneCookies(cookies: CookieRecord[]): CookieRecord[] {
	const now = Date.now();
	const kept = new Map<string, CookieRecord>();
	for (const cookie of cookies) {
		if (cookie.expires !== null && cookie.expires < now) continue;
		if (!cookie.name) continue;
		const key = `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`;
		kept.set(key, cookie);
	}
	return Array.from(kept.values());
}

function parseExpiry(attributes: Map<string, string>): number | null {
	const maxAge = attributes.get('max-age');
	if (maxAge !== undefined) {
		const seconds = Number.parseInt(maxAge, 10);
		if (Number.isFinite(seconds)) return Date.now() + seconds * 1000;
	}
	const expires = attributes.get('expires');
	if (expires !== undefined) {
		const parsed = Date.parse(expires);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/** Parse a `document.cookie`-style assignment string into a cookie record.
 * Returns null when the string is empty or malformed, or when it tries to set a
 * domain that does not match the page it came from. */
export function parseCookieString(raw: string, requestHost: string): CookieRecord | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const segments = trimmed.split(';');
	const first = segments.shift() ?? '';
	const separator = first.indexOf('=');
	if (separator < 0) return null;
	const name = first.slice(0, separator).trim();
	const value = first.slice(separator + 1).trim();
	if (!name) return null;

	const attributes = new Map<string, string>();
	for (const segment of segments) {
		const eq = segment.indexOf('=');
		if (eq < 0) {
			attributes.set(segment.trim().toLowerCase(), '');
		} else {
			attributes.set(
				segment.slice(0, eq).trim().toLowerCase(),
				segment.slice(eq + 1).trim(),
			);
		}
	}

	const domainAttr = attributes.get('domain');
	const host = requestHost.toLowerCase();
	const domain = (domainAttr ?? host).replace(/^\./, '').toLowerCase();
	if (domainAttr !== undefined && host !== domain && !host.endsWith(`.${domain}`)) {
		return null;
	}
	const hostOnly = !domainAttr;

	return {
		name,
		value,
		domain,
		path: attributes.get('path') || '/',
		expires: parseExpiry(attributes),
		secure: attributes.has('secure'),
		httpOnly: attributes.has('httponly'),
		hostOnly,
	};
}

export function cookieMatchesHost(cookie: CookieRecord, host: string): boolean {
	const target = host.toLowerCase();
	if (cookie.hostOnly) return cookie.domain === target;
	return target === cookie.domain || target.endsWith(`.${cookie.domain}`);
}

/** Merge a parsed cookie into a jar, replacing any cookie with the same identity. */
export function mergeCookie(cookies: CookieRecord[], incoming: CookieRecord): CookieRecord[] {
	const next = cookies.filter(
		(cookie) =>
			!(
				cookie.name === incoming.name &&
				cookie.domain === incoming.domain &&
				cookie.path === incoming.path
			),
	);
	if (incoming.expires !== null && incoming.expires <= Date.now()) {
		return next;
	}
	next.push(incoming);
	return next;
}

/** Serialise cookies for display and for export to the vault. */
export function cookiesToNetscape(cookies: CookieRecord[]): string {
	const lines = ['# Netscape HTTP Cookie File'];
	for (const cookie of cookies) {
		const domain = cookie.hostOnly ? cookie.domain : `.${cookie.domain}`;
		const expiry = cookie.expires === null ? 0 : Math.floor(cookie.expires / 1000);
		lines.push(
			[
				domain,
				cookie.hostOnly ? 'FALSE' : 'TRUE',
				cookie.path,
				cookie.secure ? 'TRUE' : 'FALSE',
				String(expiry),
				cookie.name,
				cookie.value,
			].join('\t'),
		);
	}
	return lines.join('\n');
}

/** Pure helpers with no Obsidian or DOM dependencies. */

/**
 * The server-rendered DuckDuckGo endpoint, not the JavaScript app at
 * `duckduckgo.com/?q=`. Search results are fetched through the proxy, where the
 * SPA shell renders empty and is far heavier; this endpoint returns usable
 * result markup directly.
 */
export const DEFAULT_SEARCH_TEMPLATE = 'https://html.duckduckgo.com/html/?q=%s';

/**
 * The pre-1.0.6 default. The JavaScript app at this address renders empty when
 * fetched through the proxy, so stored settings still pointing here are moved to
 * the server-rendered endpoint. A user-chosen search engine is left alone.
 */
export const LEGACY_SEARCH_TEMPLATE = 'https://duckduckgo.com/?q=%s';

export function generateId(): string {
	const cryptoObj = typeof crypto !== 'undefined' ? crypto : undefined;
	if (cryptoObj && 'randomUUID' in cryptoObj) {
		return cryptoObj.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/;

/**
 * Decide whether the text looks like a URL rather than a search phrase.
 * Bare hostnames such as `example.com` count as URLs.
 */
export function looksLikeUrl(input: string): boolean {
	const value = input.trim();
	if (!value) return false;
	if (/\s/.test(value)) return false;
	if (SCHEME_RE.test(value)) return true;
	if (IPV4_RE.test(value)) return true;
	const host = value.split(/[/?#]/)[0] ?? '';
	if (host === 'localhost') return true;
	return /^[^\s.]+(\.[^\s.]+)+$/.test(host);
}

/** Turn arbitrary address-bar text into an absolute http(s) URL. */
export function normalizeInput(input: string, searchTemplate = DEFAULT_SEARCH_TEMPLATE): string {
	const value = input.trim();
	if (!value) return '';
	if (SCHEME_RE.test(value)) {
		try {
			return new URL(value).toString();
		} catch {
			return value;
		}
	}
	if (looksLikeUrl(value)) {
		try {
			return new URL(`https://${value}`).toString();
		} catch {
			/* fall through to search */
		}
	}
	const template = searchTemplate.includes('%s')
		? searchTemplate
		: DEFAULT_SEARCH_TEMPLATE;
	return template.replace('%s', encodeURIComponent(value));
}

/** Extract the hostname of a URL, or an empty string when it cannot be parsed. */
export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/** Shorten a URL for tab labels and history rows. */
export function displayUrl(url: string, maxLength = 60): string {
	let pretty = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
	if (pretty.length > maxLength) {
		pretty = `${pretty.slice(0, maxLength - 1)}…`;
	}
	return pretty;
}

export function titleFromUrl(url: string): string {
	const host = hostOf(url);
	return host || displayUrl(url, 40) || 'New tab';
}

/** Only http and https may be loaded or opened externally. */
export function isAllowedWebUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/** De-duplicate an array while preserving order. */
export function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

/**
 * Minimal glob matcher supporting `*` and `?`, used to test proxy bypass rules.
 */
export function matchesGlob(value: string, pattern: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.');
	return new RegExp(`^${escaped}$`, 'i').test(value);
}

/** What `VaultAdapter.list` reports for one folder. */
export interface FolderListing {
	files: string[];
	folders: string[];
}

/**
 * `VaultAdapter.list` returns the *vault-relative path* of each child, not the
 * bare name, so a child must be used as-is. Joining the folder back on produces
 * `folder/folder/child`. This normalises either shape to a vault-relative path:
 * a child that already starts with the folder is kept, and a bare name is joined
 * to it. An empty folder yields the child unchanged.
 */
export function childPath(folder: string, child: string): string {
	const base = folder.replace(/^\/+|\/+$/g, '');
	if (!base) return child;
	if (child === base || child.startsWith(`${base}/`)) return child;
	return `${base}/${child}`;
}

/**
 * Walk a folder tree and return every file that matches `accept`, as
 * vault-relative paths. An empty `folder` walks the vault root. `adapter.list`
 * can throw on a folder that vanished mid-walk; that folder is skipped rather
 * than failing the whole scan.
 */
export async function collectFiles(
	adapter: {
		list(path: string): Promise<FolderListing>;
		exists(path: string): Promise<boolean>;
	},
	folder: string,
	accept: (path: string) => boolean,
): Promise<string[]> {
	const found: string[] = [];
	const walk = async (current: string): Promise<void> => {
		let listing: FolderListing;
		try {
			listing = await adapter.list(current);
		} catch {
			return;
		}
		for (const file of listing.files) {
			const path = childPath(current, file);
			if (accept(path)) found.push(path);
		}
		for (const child of listing.folders) {
			await walk(childPath(current, child));
		}
	};
	const root = folder.replace(/^\/+|\/+$/g, '');
	if (root && !(await adapter.exists(root))) return found;
	await walk(root);
	return found;
}

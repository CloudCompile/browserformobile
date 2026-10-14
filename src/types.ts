/** Shared types for the browser plugin. */

/** How a page is rendered inside the plugin. */
export type RenderMode = 'direct' | 'proxy';

/** Cookie scoping. Host-only cookies are keyed by exact host; otherwise subdomains share them. */
export interface CookieRecord {
	name: string;
	value: string;
	domain: string;
	path: string;
	/** Epoch milliseconds, or null for a session cookie. */
	expires: number | null;
	secure: boolean;
	httpOnly: boolean;
	/** Host-only cookies are sent only to the exact host that set them. */
	hostOnly: boolean;
}

export interface BookmarkRecord {
	id: string;
	title: string;
	url: string;
	createdAt: number;
}

export interface HistoryRecord {
	id: string;
	title: string;
	url: string;
	visitedAt: number;
}

export interface TabState {
	id: string;
	title: string;
	/** Canonical, possibly rewritten URL used as the iframe source. */
	url: string;
	/** Original, user-facing URL. */
	displayUrl: string;
	history: string[];
	historyIndex: number;
	renderMode: RenderMode;
	/** True when the current entry was served through the proxy. */
	proxied: boolean;
	lastError: string | null;
}

export interface BrowserData {
	tabs: TabState[];
	activeTabId: string | null;
	history: HistoryRecord[];
	bookmarks: BookmarkRecord[];
	cookies: CookieRecord[];
}

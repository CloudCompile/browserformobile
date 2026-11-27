/** Constants shared by the browser view, settings and injected page script. */

export type BrowserSearchEngine = 'ddg' | 'brave' | 'google' | 'bing' | 'startpage';

export const BROWSER_VIEW_TYPE = 'browser-for-mobile-browser';

/**
 * Empty means "use this device's own browser identity". The resolver in
 * `ua.ts` turns it into the phone's real UA, with WebView markers removed.
 */
export const AUTO_BROWSER_UA = '';

/** The fixed Pixel UA shipped by 5.5.5; migrated to automatic on load. */
export const LEGACY_DEFAULT_BROWSER_UA =
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/** Fallback only when the platform does not expose a usable UA. */
export const DEFAULT_BROWSER_UA = LEGACY_DEFAULT_BROWSER_UA;

export const BROWSER_ENGINES: Record<BrowserSearchEngine, { name: string; url: string }> = {
	ddg: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
	brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
	google: { name: 'Google', url: 'https://www.google.com/search?q=' },
	bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
	startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=' },
};

export const BROWSER_QUICK_LINKS: { title: string; url: string }[] = [
	{ title: 'DuckDuckGo', url: 'https://duckduckgo.com/' },
	{ title: 'Wikipedia', url: 'https://en.m.wikipedia.org/' },
	{ title: 'Hacker News', url: 'https://news.ycombinator.com/' },
	{ title: 'GitHub', url: 'https://github.com/' },
	{ title: 'Internet Archive', url: 'https://archive.org/' },
];

/**
 * Search engines stay in proxy mode even when their headers would allow a
 * direct frame. A direct frame is cross-origin, so its result links with
 * `target="_blank"` escape to the system browser; the proxied page keeps them
 * inside the plugin's own tab.
 */
const SEARCH_ENGINE_HOSTS = [
	'duckduckgo.com',
	'google.com',
	'bing.com',
	'search.brave.com',
	'startpage.com',
	'search.yahoo.com',
	'yandex.com',
	'yandex.ru',
	'baidu.com',
	'ecosia.org',
	'qwant.com',
	'ask.com',
];

/** Whether a host belongs to a search engine that must stay proxied. */
export function isSearchEngineHost(host: string): boolean {
	const value = host.trim().toLowerCase().replace(/^www\./, '');
	if (!value) return false;
	// Google uses country domains (google.co.uk, google.de, …).
	if (/^google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(value)) return true;
	return SEARCH_ENGINE_HOSTS.some((known) => value === known || value.endsWith(`.${known}`));
}

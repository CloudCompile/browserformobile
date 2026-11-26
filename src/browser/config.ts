/** Constants shared by the browser view, settings and injected page script. */

export type BrowserSearchEngine = 'ddg' | 'ddg_html' | 'brave' | 'google' | 'bing' | 'startpage';

export const BROWSER_VIEW_TYPE = 'browser-for-mobile-browser';

export const DEFAULT_BROWSER_UA =
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

export const BROWSER_ENGINES: Record<BrowserSearchEngine, { name: string; url: string }> = {
	ddg: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
	ddg_html: { name: 'DuckDuckGo (no-JS version)', url: 'https://html.duckduckgo.com/html/?q=' },
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

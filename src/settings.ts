import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { DEFAULT_API_BASE } from './animeApi';
import type BrowserPlugin from './main';
import { DEFAULT_PROXY_BASE } from './proxy';
import { DEFAULT_SEARCH_TEMPLATE } from './utils';

export interface BrowserSettings {
	homePage: string;
	searchTemplate: string;
	/** Base URL of the CORS proxy used by the proxy renderer. */
	proxyBase: string;
	/** Fetch pages with the native HTTP client before falling back to the proxy. */
	directFetch: boolean;
	/** Prefer the proxy renderer for every page instead of only when framing fails. */
	preferProxy: boolean;
	/** Persist a cookie jar and expose it to proxied pages. */
	enableCookies: boolean;
	/** Let proxied pages run their own scripts so client-rendered sites work. */
	runScripts: boolean;
	/** Ask before clearing history, cookies, or the cache. */
	confirmDestructiveActions: boolean;
	openExternalLinksInSystemBrowser: boolean;
	/** Base URL of the anime API used by the downloader. */
	animeApiBase: string;
	/** Preferred stream height in pixels. The closest available is used. */
	downloadQuality: number;
	/** MP4 is a single playable file; TS streams to disk with lower memory. */
	downloadFormat: 'mp4' | 'ts';
	/** Vault-relative folder, or an absolute path when `downloadExternal`. */
	downloadFolder: string;
	/** Save outside the vault. Desktop only; ignored on mobile. */
	downloadExternal: boolean;
	/** Filename template supporting {series}, {ep}, {ep:02}, {title}, {ext}. */
	downloadFilenameTemplate: string;
	/** Parallel segment requests per episode. */
	downloadSegmentConcurrency: number;
	/** Episodes downloaded at the same time. */
	downloadMaxConcurrentJobs: number;
}

export const DEFAULT_SETTINGS: BrowserSettings = {
	homePage: 'https://duckduckgo.com/',
	searchTemplate: DEFAULT_SEARCH_TEMPLATE,
	proxyBase: DEFAULT_PROXY_BASE,
	directFetch: true,
	preferProxy: false,
	enableCookies: true,
	// Off breaks every site that renders on the client (search engines, SPAs).
	runScripts: true,
	confirmDestructiveActions: true,
	openExternalLinksInSystemBrowser: false,
	animeApiBase: DEFAULT_API_BASE,
	// Sources are 720p, so this is the usual answer; the closest variant is used
	// when a stream does not offer the exact height.
	downloadQuality: 720,
	// MP4 is what users expect to play; TS is offered for low-memory mobile runs.
	downloadFormat: 'mp4',
	downloadFolder: 'Anime',
	downloadExternal: false,
	downloadFilenameTemplate: '{series} - {ep:02} - {title}.{ext}',
	// The CDN answers HTTP 429 above four parallel segment requests.
	downloadSegmentConcurrency: 3,
	downloadMaxConcurrentJobs: 2,
};

export class BrowserSettingTab extends PluginSettingTab {
	plugin: BrowserPlugin;

	constructor(app: App, plugin: BrowserPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Declarative settings used by Obsidian 1.13 and later. The imperative
	 * `display()` below is the fallback for older versions.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Home page',
				desc: 'Page loaded when you open a new tab or the browser.',
				control: {
					type: 'text',
					key: 'homePage',
					placeholder: 'https://example.com',
				},
			},
			{
				name: 'Search template',
				desc: 'Use %s where the search terms should go.',
				control: {
					type: 'text',
					key: 'searchTemplate',
					placeholder: DEFAULT_SEARCH_TEMPLATE,
				},
			},
			{
				name: 'Fetch pages directly',
				desc: "Use the app's built-in HTTP client before falling back to the proxy. This is faster and keeps the request off third-party services. Turn it off to send every request through the proxy.",
				control: { type: 'toggle', key: 'directFetch' },
			},
			{
				name: 'Proxy endpoint',
				desc: 'Fallback endpoint for pages the browser cannot fetch or frame directly. The default is allorigins.win, with built-in fallbacks (a Cloudflare Worker, r.jina.ai, cors.lol). Set your own endpoint to use only that one. Only page HTML is requested; the response is sanitised before it is displayed.',
				control: { type: 'text', key: 'proxyBase' },
			},
			{
				name: 'Always use proxy',
				desc: 'Route every page through the proxy. Slower and not suitable for sites that require a real login, but it works around sites that refuse to be embedded.',
				control: { type: 'toggle', key: 'preferProxy' },
			},
			{
				name: 'Run page scripts',
				desc: 'Let proxied pages run their own scripts. Most modern sites render in the browser and come up blank or broken without this. Turning it off blocks third-party scripts but breaks those sites.',
				control: { type: 'toggle', key: 'runScripts' },
			},
			{
				name: 'Enable cookie jar',
				desc: 'Store cookies locally and share them with proxied pages. Cookies never leave your device except in requests to the site they belong to.',
				control: { type: 'toggle', key: 'enableCookies' },
			},
			{
				name: 'Confirm destructive actions',
				desc: 'Ask before clearing history, cookies, or the browser cache.',
				control: { type: 'toggle', key: 'confirmDestructiveActions' },
			},
			{
				name: 'Open external links in system browser',
				desc: 'When enabled, links that cannot be shown inside the plugin open in your device browser instead.',
				control: { type: 'toggle', key: 'openExternalLinksInSystemBrowser' },
			},
			{
				name: 'Anime API endpoint',
				desc: 'Base URL of the anime catalogue used by the downloader. Change this if you self-host the API.',
				control: { type: 'text', key: 'animeApiBase', placeholder: DEFAULT_API_BASE },
			},
			{
				name: 'Download quality',
				desc: 'Preferred stream height in pixels. Sources are usually 720p only, so the closest available quality is used.',
				control: {
					type: 'dropdown',
					key: 'downloadQuality',
					options: { '1080': '1080p', '720': '720p', '480': '480p', '360': '360p' },
				},
			},
			{
				name: 'Download format',
				desc: 'MP4 gives a single playable file but holds the whole episode in memory while it converts. TS writes the raw stream straight to disk, which is lighter on mobile.',
				control: {
					type: 'dropdown',
					key: 'downloadFormat',
					options: { mp4: 'MP4 (playable file)', ts: 'TS (raw stream, low memory)' },
				},
			},
			{
				name: 'Download folder',
				desc: 'Folder for downloaded files, relative to the vault. On mobile the vault is the only location a plugin can write to.',
				control: { type: 'text', key: 'downloadFolder', placeholder: 'Anime' },
			},
			{
				name: 'Save outside the vault',
				desc: 'Desktop only. Write downloads to an absolute path, such as a mounted SD card. Ignored on mobile, where Obsidian cannot write to an SD card.',
				control: { type: 'toggle', key: 'downloadExternal' },
			},
			{
				name: 'Filename template',
				desc: 'Use {series}, {ep}, {ep:02}, {title}, and {ext} as placeholders. Invalid filename characters are replaced with underscores.',
				control: {
					type: 'text',
					key: 'downloadFilenameTemplate',
					placeholder: '{series} - {ep:02} - {title}.{ext}',
				},
			},
			{
				name: 'Parallel segments',
				desc: 'Segments fetched at the same time per episode. The stream CDN starts refusing requests above four, so keep this low.',
				control: { type: 'slider', key: 'downloadSegmentConcurrency', min: 1, max: 8, step: 1 },
			},
			{
				name: 'Parallel episodes',
				desc: 'Episodes downloaded at the same time. Each episode uses the segment limit above, so the total load is the two multiplied together.',
				control: { type: 'slider', key: 'downloadMaxConcurrentJobs', min: 1, max: 4, step: 1 },
			},
		];
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

}

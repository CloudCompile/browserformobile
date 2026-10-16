import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
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

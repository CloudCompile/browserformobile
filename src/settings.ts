import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { DEFAULT_API_BASE } from './animeApi';
import type AnimePlugin from './main';

import { DEFAULT_SERVER_BASE, DEFAULT_SERVER_MODEL, LOCAL_MODELS } from './llm';

export interface AnimeSettings {
        /** Ask before deleting files or clearing the download log. */
        confirmDestructiveActions: boolean;
        /** Base URL of the anime API used by the downloader. */
        animeApiBase: string;
        /**
         * Cache anime API responses on disk. The API is slow to answer because it
         * runs serverless, where no cache of its own survives between requests, so
         * repeating a search or re-opening a series would otherwise re-fetch it.
         */
        animeCacheEnabled: boolean;
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
        /**
         * Which decision model re-ranks recommendations, if any. `off` uses the
         * catalogue's votes and a text match only.
         */
        recommendationModel: 'off' | 'local' | 'hosted';
        /**
         * API key for the hosted decision model. The taste profile and candidate
         * titles are the only things sent, and only when `recommendationModel` is
         * `hosted`.
         */
        jevApiKey: string;
        /**
         * Whether a language model curates the recommendations, and how it is
         * reached. `server` is a model on the user's own machine; `api` is a
         * hosted endpoint. Both are off by default.
         */
        llmProvider: 'off' | 'in-process' | 'server' | 'api';
        /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
        llmBaseUrl: string;
        /** Model name as the server knows it. */
        llmModel: string;
        /** Bearer token for a hosted endpoint. Empty for a local server. */
        llmApiKey: string;
        /**
         * Offer the model a web search tool. Off by default because it is the one
         * part that sends a query to a third party of the user's choosing.
         */
        llmWebSearch: boolean;
        /** Search endpoint that accepts `?q=` and returns JSON or text. */
        llmSearchUrl: string;
        /**
         * Which local model the in-process provider loads, by id from
         * `LOCAL_MODELS`. Runs inside the plugin through WebAssembly.
         */
        llmLocalModel: string;
        /** Apply the glass effect to the plugin's panels. Desktop only. */
        glassEffect: boolean;
}

export const DEFAULT_SETTINGS: AnimeSettings = {
        confirmDestructiveActions: true,
        animeApiBase: DEFAULT_API_BASE,
        animeCacheEnabled: true,
        // Sources are 720p, so this is the usual answer; the closest variant is used
        // when a stream does not offer the exact height.
        downloadQuality: 720,
        // MP4 is what users expect to play; TS is offered for low-memory mobile runs.
        downloadFormat: 'mp4',
        downloadFolder: 'Anime',
        downloadExternal: false,
        downloadFilenameTemplate: '{series} - {ep:02} - {title}.{ext}',
        // Benchmarked against the live CDN: throughput plateaus around four to six
        // parallel segments and does not improve above that — the CDN starts
        // answering 429 above roughly four in flight. The pool halves on a 429 and
        // will not climb back past the level that failed, so a higher setting is now
        // safe (it used to stall for minutes) but is rarely any faster.
        downloadSegmentConcurrency: 6,
        downloadMaxConcurrentJobs: 1,
        // Off by default: the baseline needs no download, no key and no network, and
        // both model options cost the user something — a 6 MB fetch, or sending
        // their taste profile to a third party.
        recommendationModel: 'off',
        jevApiKey: '',
        llmProvider: 'off',
        llmBaseUrl: DEFAULT_SERVER_BASE,
        llmModel: DEFAULT_SERVER_MODEL,
        llmApiKey: '',
        llmWebSearch: false,
        llmSearchUrl: '',
        llmLocalModel: 'lfm2.5-230m',
        glassEffect: false,
};

export class AnimeSettingTab extends PluginSettingTab {
        plugin: AnimePlugin;

        constructor(app: App, plugin: AnimePlugin) {
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
                                name: 'Anime API endpoint',
                                desc: 'Base URL of the anime catalogue used by the downloader. Change this if you self-host the API.',
                                control: { type: 'text', key: 'animeApiBase', placeholder: DEFAULT_API_BASE },
                        },
                        {
                                name: 'Cache anime details',
                                desc: 'Store search results, series details, episode lists, and stream URLs on disk so repeating a lookup is instant. The API answers slowly because it runs without a persistent cache of its own. Only anime API responses are stored.',
                                control: { type: 'toggle', key: 'animeCacheEnabled' },
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
                                desc: 'MP4 gives a single playable file and is converted as it downloads. TS writes the raw stream to disk with slightly less work but plays in fewer apps.',
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
                                desc: 'Segments fetched at the same time per episode. The stream CDN refuses requests above a few in flight, so higher is not faster — the download halves this on its own when it is refused.',
                                control: { type: 'slider', key: 'downloadSegmentConcurrency', min: 1, max: 16, step: 1 },
                        },
                        {
                                name: 'Parallel episodes',
                                desc: 'Episodes downloaded at the same time. Each episode uses the segment limit above, so the total load is the two multiplied together.',
                                control: { type: 'slider', key: 'downloadMaxConcurrentJobs', min: 1, max: 4, step: 1 },
                        },
                        {
                                name: 'Recommendation model',
                                desc: "How recommendations are refined. Catalogue only uses the site's own related-series votes plus a text match and needs no download. Local decision model fetches a 6 MB model once and runs it entirely on your device, so nothing leaves it. Hosted decision model sends your download history and the candidate titles to TypeSafe (typesafe.ai); it needs an API key below.",
                                control: {
                                        type: 'dropdown',
                                        key: 'recommendationModel',
                                        options: {
                                                off: 'Catalogue only',
                                                local: 'Local decision model (offline, 6 MB)',
                                                hosted: 'Hosted decision model (Jev)',
                                        },
                                },
                        },
                        {
                                name: 'Jev API key',
                                desc: 'Only used when the hosted model is selected. Your download history and the recommended titles are sent to TypeSafe with this key. Leave empty to disable the hosted model.',
                                control: { type: 'text', key: 'jevApiKey', placeholder: 'TYPESAFE_API_KEY' },
                        },
                        {
                                name: 'Curate with a language model',
                                desc: 'Let a language model re-order and prune the recommendations, with tools so it can look titles up before choosing. Model server runs a model on your own machine (Ollama, LM Studio, llama.cpp) and keeps everything on your network. Hosted API works with no local setup but sends your history and the candidate titles to that provider. Off leaves the catalogue ranking untouched.',
                                control: {
                                        type: 'dropdown',
                                        key: 'llmProvider',
                                        options: {
                                                off: 'Off',
                                                'in-process': 'In this plugin (offline, ~150 MB)',
                                                server: 'Model server on my machine',
                                                api: 'Hosted API',
                                        },
                                },
                        },
                        {
                                name: 'Local model',
                                desc: 'Used when curating in this plugin. Runs entirely on your device through WebAssembly: no server, no account, nothing sent anywhere. It needs roughly the model size in free memory, so the smallest is the safest on a phone. The runtime is about 9 MB and is downloaded once, then cached.',
                                control: {
                                        type: 'dropdown',
                                        key: 'llmLocalModel',
                                        options: Object.fromEntries(LOCAL_MODELS.map((model) => [model.id, model.label])),
                                },
                        },
                        {
                                name: 'Model server URL',
                                desc: 'OpenAI-compatible base URL. Ollama uses http://localhost:11434/v1, LM Studio http://localhost:1234/v1.',
                                control: { type: 'text', key: 'llmBaseUrl', placeholder: DEFAULT_SERVER_BASE },
                        },
                        {
                                name: 'Model name',
                                desc: 'The model to ask. Any instruction-tuned model works; Liquid AI LFM2.5 230M, 350M and 1.2B are small enough to run alongside Obsidian. Pull it first, e.g. ollama pull hf.co/LiquidAI/LFM2.5-230M-GGUF.',
                                control: { type: 'text', key: 'llmModel', placeholder: DEFAULT_SERVER_MODEL },
                        },
                        {
                                name: 'Model API key',
                                desc: 'Only for a hosted API. Left empty for a server on your own machine.',
                                control: { type: 'text', key: 'llmApiKey', placeholder: 'sk-...' },
                        },
                        {
                                name: 'Let the model search the web',
                                desc: 'Gives the model a web search tool for titles the catalogue does not know. Off by default: it is the only part that sends a query to a third party, and the catalogue lookup above is usually enough.',
                                control: { type: 'toggle', key: 'llmWebSearch' },
                        },
                        {
                                name: 'Search endpoint',
                                desc: 'Used only when web search is on. Any URL that accepts a q parameter and returns text or JSON.',
                                control: { type: 'text', key: 'llmSearchUrl', placeholder: 'https://example.com/search?q=' },
                        },
                        {
                                name: 'Glass effect',
                                desc: "Apply a translucent glass surface to the plugin's panels. Desktop only: it needs the compositor to blur what is behind the panel, which is too costly on a phone. Off by default.",
                                control: { type: 'toggle', key: 'glassEffect' },
                        },
                        {
                                name: 'Confirm destructive actions',
                                desc: 'Ask before deleting a downloaded file or clearing the download log.',
                                control: { type: 'toggle', key: 'confirmDestructiveActions' },
                        },
                ];
        }

        getControlValue(key: string): unknown {
                return (this.plugin.settings as unknown as Record<string, unknown>)[key];
        }

        async setControlValue(key: string, value: unknown): Promise<void> {
                (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
                if (key === 'animeCacheEnabled') {
                        // Take effect at once rather than on the next reload.
                        this.plugin.applyAnimeCacheSetting();
                }
                if (key === 'recommendationModel') {
                        // Release the model weights as soon as the model is switched off.
                        this.plugin.applyRecommendationModelSetting();
                }
                if (key === 'glassEffect') {
                        this.plugin.applyGlassSetting();
                }
                await this.plugin.saveSettings();
        }
}

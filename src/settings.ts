import {
        App,
        PluginSettingTab,
        type SettingDefinition,
        type SettingDefinitionItem,
} from 'obsidian';
import { DEFAULT_API_BASE } from './animeApi';
import type AnimePlugin from './main';
import {
        AUTO_BROWSER_UA,
        BROWSER_ENGINES,
        type BrowserSearchEngine,
} from './browser/config';

import { DEFAULT_SERVER_BASE, DEFAULT_SERVER_MODEL, LOCAL_MODELS } from './llm';

export const DEFAULT_FILENAME_TEMPLATE = '{seriesFolder}/{series} - {ep:02} - {title}.{ext}';

export interface AnimeSettings {
        /** Ask before deleting files or clearing the download log. */
        confirmDestructiveActions: boolean;
        /** Base URL of the anime API used by the downloader. */
        animeApiBase: string;
        /**
         * The one 18+ opt-in. The finder's source tab and the downloader's
         * search both read it, so the two can never disagree.
         */
        showAdultContent: boolean;
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
        /** Folder for files saved from the browser, relative to the vault. */
        browserDownloadFolder: string;
        /** User agent the embedded browser sends; empty detects this device. */
        browserUserAgent: string;
        /** Search engine used by the browser address bar and home page. */
        browserSearchEngine: BrowserSearchEngine;
        /** Inline remote styles, scripts and fonts into browser pages. */
        browserInline: boolean;
        /** Try a direct, real-origin iframe when the site allows framing. */
        browserCompatibility: boolean;
        /** Save outside the vault. Desktop only; ignored on mobile. */
        downloadExternal: boolean;
        /** Filename template supporting {series}, {ep}, {ep:02}, {title}, {ext}. */
        downloadFilenameTemplate: string;
        /**
         * Save the stream's subtitle track as a WebVTT file next to the video,
         * which the player then shows. Off by default: it adds a second set of
         * requests per episode, and streams without subtitles are unaffected.
         */
        downloadSubtitles: boolean;
        /** Show the sidecar subtitles when the player opens. */
        subtitlesOn: boolean;
        /** How large the subtitle cues render in the player. */
        subtitleSize: 'small' | 'normal' | 'large';
        /** Subtitles this many milliseconds later than the track's own timing. */
        subtitleDelayMs: number;
        /** Advance to the next episode of the series when one finishes. */
        autoPlayNext: boolean;
        /**
         * Try dubbed servers first when the default one offers no file. Dub
         * availability follows the catalogue — many series are subbed only, and
         * for those this changes nothing.
         */
        preferDub: boolean;
        /** Parallel segment requests per episode. */
        downloadSegmentConcurrency: number;
        /** Episodes downloaded at the same time. */
        downloadMaxConcurrentJobs: number;
        /**
         * Continue queued and paused downloads when Obsidian starts, instead of
         * waiting for the queue to be opened. Off by default: an unattended
         * resume is not what everyone wants on opening a note-taking app. On
         * devices that report a metered connection the resume is held off
         * regardless; iOS exposes no signal, so there it always resumes.
         */
        autoResumeOnLaunch: boolean;
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
        /** Write a detailed diagnostic log while downloads and repairs run. */
        debugMode: boolean;
        /**
         * Reveal the full settings page. The everyday page is deliberately
         * short: most of these knobs matter only when something is not working,
         * and showing all of them at once made the page unreadable.
         */
        settingsAdvanced: boolean;
}

export const DEFAULT_SETTINGS: AnimeSettings = {
        confirmDestructiveActions: true,
        animeApiBase: DEFAULT_API_BASE,
        // Off by default: the adult source is a separate catalogue, and the
        // plugin should not reach for it until the user asks.
        showAdultContent: false,
        animeCacheEnabled: true,
        // Sources are 720p, so this is the usual answer; the closest variant is used
        // when a stream does not offer the exact height.
        downloadQuality: 720,
        // MP4 is what users expect to play; TS is offered for low-memory mobile runs.
        downloadFormat: 'mp4',
        downloadFolder: 'Anime',
        browserDownloadFolder: 'Browser',
        browserUserAgent: AUTO_BROWSER_UA,
        browserSearchEngine: 'ddg',
        browserInline: true,
        browserCompatibility: true,
        downloadExternal: false,
        downloadFilenameTemplate: DEFAULT_FILENAME_TEMPLATE,
        // Off by default: subtitles cost a second set of segment requests per
        // episode, and the sidecar is only useful when the source has a track.
        downloadSubtitles: false,
        // The defaults that make a sidecar behave like the platform player:
        // on at normal size with the track's own timing.
        subtitlesOn: true,
        subtitleSize: 'normal',
        subtitleDelayMs: 0,
        // Off: an unattended advance downloads nothing, but it does roll two
        // watch records into one sitting without being asked to.
        autoPlayNext: false,
        // Sub first: the fallback walk keeps the default response's audio track,
        // and most of the catalogue is subbed only.
        preferDub: false,
        // Benchmarked against the live CDN: throughput plateaus around four to six
        // parallel segments and does not improve above that — the CDN starts
        // answering 429 above roughly four in flight. The pool halves on a 429 and
        // will not climb back past the level that failed, so a higher setting is now
        // safe (it used to stall for minutes) but is rarely any faster.
        downloadSegmentConcurrency: 6,
        downloadMaxConcurrentJobs: 1,
        // Off by default: resuming automatically on launch downloads without
        // anyone watching, which is not what everyone wants — and on a metered
        // connection it can cost money. Opt-in, and held off on a connection the
        // device reports as metered.
        autoResumeOnLaunch: false,
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
        debugMode: false,
        settingsAdvanced: false,
};



/**
 * One definition per setting. Typed as a total record over `AnimeSettings`, so
 * adding a setting without a definition fails the build instead of rendering a
 * group that throws.
 */
const DEFS: Record<keyof AnimeSettings, SettingDefinition[]> = {
        'settingsAdvanced': [
                {
                        name: 'Advanced settings',
                        desc: 'Show every setting, including API endpoints, parallel downloads, model servers and diagnostics. Off keeps this page to the choices that matter day to day.',
                        control: { type: 'toggle', key: 'settingsAdvanced' },
                },
        ],
        'animeApiBase': [
                {
                        name: 'Anime API endpoint',
                                        desc: 'Base URL of the anime catalogue used by the downloader. Change this if you self-host the API.',
                                        control: { type: 'text', key: 'animeApiBase', placeholder: DEFAULT_API_BASE },
                },
        ],
        'showAdultContent': [
                {
                        name: 'Show 18+ titles',
                                        desc: 'Reveal the opt-in 18+ source in the finder and include its titles in downloader searches. One switch for both pages; off by default.',
                                        control: { type: 'toggle', key: 'showAdultContent' },
                },
        ],
        'animeCacheEnabled': [
                {
                        name: 'Cache anime details',
                                        desc: 'Store search results, series details, episode lists, and stream URLs on disk so repeating a lookup is instant. The API answers slowly because it runs without a persistent cache of its own. Only anime API responses are stored.',
                                        control: { type: 'toggle', key: 'animeCacheEnabled' },
                },
        ],
        'downloadQuality': [
                {
                        name: 'Download quality',
                                        desc: 'Preferred stream height in pixels. Sources are usually 720p only, so the closest available quality is used.',
                                        control: {
                                                type: 'dropdown',
                                                key: 'downloadQuality',
                                                options: { '1080': '1080p', '720': '720p', '480': '480p', '360': '360p' },
                                        },
                },
        ],
        'downloadFormat': [
                {
                        name: 'Download format',
                                        desc: 'MP4 gives a single playable file, converted as it downloads — the right choice for watching, and what the library and repair tools expect. TS keeps the raw stream for archiving or remuxing later; browsers cannot play it.',
                                        control: {
                                                type: 'dropdown',
                                                key: 'downloadFormat',
                                                options: { mp4: 'MP4 (playable file)', ts: 'TS (raw stream, archive)' },
                                        },
                },
        ],
        'downloadFolder': [
                {
                        name: 'Download folder',
                                        desc: 'Folder for downloaded files, relative to the vault. On mobile the vault is the only location a plugin can write to.',
                                        control: { type: 'text', key: 'downloadFolder', placeholder: 'Anime' },
                },
        ],
        'browserDownloadFolder': [
                {
                        name: 'Browser download folder',
                                        desc: 'Folder for images, videos and files saved from the browser, relative to the vault. Keep it separate from your anime library if you do not want browser media scanned there.',
                                        control: { type: 'text', key: 'browserDownloadFolder', placeholder: 'Browser' },
                },
        ],
        'browserSearchEngine': [
                {
                        name: 'Browser search engine',
                                        desc: 'Used by the browser address bar and its home page.',
                                        control: {
                                                type: 'dropdown',
                                                key: 'browserSearchEngine',
                                                options: Object.fromEntries(
                                                        Object.entries(BROWSER_ENGINES).map(([key, value]) => [key, value.name]),
                                                ),
                                        },
                },
        ],
        'browserUserAgent': [
                {
                        name: 'Browser user agent',
                                        desc: 'Automatic uses this device\u2019s own browser identity, with WebView markers removed, so sites see the actual phone rather than a generic desktop or Pixel string. Enter a custom string only to override it; use a desktop string if you want a site\u2019s desktop layout.',
                                        control: { type: 'text', key: 'browserUserAgent', placeholder: 'Automatic (this device)' },
                },
        ],
        'browserInline': [
                {
                        name: 'Inline browser styles and scripts',
                                        desc: 'Fetch remote stylesheets, scripts, modules, fonts and images natively and embed them, because a page in the browser inherits the app content security policy. Turn this off only to test a rendering problem.',
                                        control: { type: 'toggle', key: 'browserInline' },
                },
        ],
        'browserCompatibility': [
                {
                        name: 'Browser compatibility mode',
                                        desc: 'Try loading a page directly at its own address when the site allows embedding. This gives real cookies, modules, scripts and storage, but the download and media controls cannot inspect that page. Turn it off to always use download mode; the per-site menu overrides this.',
                                        control: { type: 'toggle', key: 'browserCompatibility' },
                },
        ],
        'downloadExternal': [
                {
                        name: 'Save outside the vault',
                                        desc: 'Desktop only. Write downloads to an absolute path, such as a mounted SD card. Ignored on mobile, where Obsidian cannot write to an SD card.',
                                        control: { type: 'toggle', key: 'downloadExternal' },
                },
        ],
        'downloadFilenameTemplate': [
                {
                        name: 'Filename template',
                                        desc: 'Use {series}, {seriesFolder}, {ep}, {ep:02}, {title}, and {ext}. The default puts every episode in a folder named after its series; seasons stay together.',
                                        control: {
                                                type: 'text',
                                                key: 'downloadFilenameTemplate',
                                                placeholder: DEFAULT_FILENAME_TEMPLATE,
                                        },
                },
        ],
        'downloadSubtitles': [
                {
                        name: 'Download subtitles',
                                        desc: 'Save the stream\u2019s subtitle track as a WebVTT file next to the video; the player shows it automatically. Streams without subtitles download exactly as before. Off by default because it adds a second set of requests per episode.',
                                        control: { type: 'toggle', key: 'downloadSubtitles' },
                },
        ],
        'subtitlesOn': [
                {
                        name: 'Show subtitles in the player',
                                        desc: 'Whether a downloaded sidecar starts visible. The player\u2019s own subtitle controls change this too.',
                                        control: { type: 'toggle', key: 'subtitlesOn' },
                },
        ],
        'subtitleSize': [
                {
                        name: 'Subtitle text size',
                                        desc: 'How large subtitles render in the player.',
                                        control: {
                                                type: 'dropdown',
                                                key: 'subtitleSize',
                                                options: { small: 'Small', normal: 'Normal', large: 'Large' },
                                        },
                },
        ],
        'subtitleDelayMs': [
                {
                        name: 'Subtitle delay',
                        desc: 'Shift subtitles later by this many milliseconds, to line them up with an encode whose audio leads. Negative values move them earlier.',
                        control: { type: 'slider', key: 'subtitleDelayMs', min: -5000, max: 5000, step: 100 },
                },
        ],
        'autoPlayNext': [
                {
                        name: 'Auto-play the next episode',
                                        desc: 'When an episode finishes, start the next one of the same series. Off by default \u2014 advancing is one tap on the player\u2019s Next button either way.',
                                        control: { type: 'toggle', key: 'autoPlayNext' },
                },
        ],
        'preferDub': [
                {
                        name: 'Prefer dub',
                                        desc: 'Try dubbed servers first when the default one offers no downloadable file. Dub availability follows the catalogue \u2014 many series are subbed only, and for those this changes nothing.',
                                        control: { type: 'toggle', key: 'preferDub' },
                },
        ],
        'downloadSegmentConcurrency': [
                {
                        name: 'Parallel segments',
                                        desc: 'Segments fetched at the same time per episode. The stream CDN refuses requests above a few in flight, so higher is not faster — the download halves this on its own when it is refused.',
                                        control: { type: 'slider', key: 'downloadSegmentConcurrency', min: 1, max: 16, step: 1 },
                },
        ],
        'downloadMaxConcurrentJobs': [
                {
                        name: 'Parallel episodes',
                                        desc: 'Episodes downloaded at the same time. Each episode uses the segment limit above, so the total load is the two multiplied together.',
                                        control: { type: 'slider', key: 'downloadMaxConcurrentJobs', min: 1, max: 4, step: 1 },
                },
        ],
        'autoResumeOnLaunch': [
                {
                        name: 'Resume downloads on launch',
                                        desc: 'Continue queued and paused downloads when Obsidian starts, instead of waiting for the queue to be opened. Devices that report a metered connection (data saving, cellular) hold the resume until you start it yourself; iOS exposes no connection signal, so there it always resumes.',
                                        control: { type: 'toggle', key: 'autoResumeOnLaunch' },
                },
        ],
        'recommendationModel': [
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
        ],
        'jevApiKey': [
                {
                        name: 'Jev API key',
                                        desc: 'Only used when the hosted model is selected. Your download history and the recommended titles are sent to TypeSafe with this key. Leave empty to disable the hosted model.',
                                        control: { type: 'text', key: 'jevApiKey', placeholder: 'TYPESAFE_API_KEY' },
                },
        ],
        'llmProvider': [
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
        ],
        'llmLocalModel': [
                {
                        name: 'Local model',
                                        desc: 'Used when curating in this plugin. Runs entirely on your device through WebAssembly: no server, no account, nothing sent anywhere. It needs roughly the model size in free memory, so the smallest is the safest on a phone. The runtime is about 9 MB and is downloaded once, then cached.',
                                        control: {
                                                type: 'dropdown',
                                                key: 'llmLocalModel',
                                                options: Object.fromEntries(LOCAL_MODELS.map((model) => [model.id, model.label])),
                                        },
                },
        ],
        'llmBaseUrl': [
                {
                        name: 'Model server URL',
                                        desc: 'OpenAI-compatible base URL. Ollama uses http://localhost:11434/v1, LM Studio http://localhost:1234/v1.',
                                        control: { type: 'text', key: 'llmBaseUrl', placeholder: DEFAULT_SERVER_BASE },
                },
        ],
        'llmModel': [
                {
                        name: 'Model name',
                                        desc: 'The model to ask. Any instruction-tuned model works; Liquid AI LFM2.5 230M, 350M and 1.2B are small enough to run alongside Obsidian. Pull it first, e.g. ollama pull hf.co/LiquidAI/LFM2.5-230M-GGUF.',
                                        control: { type: 'text', key: 'llmModel', placeholder: DEFAULT_SERVER_MODEL },
                },
        ],
        'llmApiKey': [
                {
                        name: 'Model API key',
                                        desc: 'Only for a hosted API. Left empty for a server on your own machine.',
                                        control: { type: 'text', key: 'llmApiKey', placeholder: 'sk-...' },
                },
        ],
        'llmWebSearch': [
                {
                        name: 'Let the model search the web',
                                        desc: 'Gives the model a web search tool for titles the catalogue does not know. Off by default: it is the only part that sends a query to a third party, and the catalogue lookup above is usually enough.',
                                        control: { type: 'toggle', key: 'llmWebSearch' },
                },
        ],
        'llmSearchUrl': [
                {
                        name: 'Search endpoint',
                                        desc: 'Used only when web search is on. Any URL that accepts a q parameter and returns text or JSON.',
                                        control: { type: 'text', key: 'llmSearchUrl', placeholder: 'https://example.com/search?q=' },
                },
        ],
        'glassEffect': [
                {
                        name: 'Glass effect',
                                        desc: "Apply a translucent glass surface to the plugin's panels. Desktop only: it needs the compositor to blur what is behind the panel, which is too costly on a phone. Off by default.",
                                        control: { type: 'toggle', key: 'glassEffect' },
                },
        ],
        'debugMode': [
                {
                        name: 'Debug mode',
                                        desc: 'Write a detailed diagnostic log for downloads, scans, and repairs to the plugin data folder. Turn this off when finished testing.',
                                        control: { type: 'toggle', key: 'debugMode' },
                },
        ],
        'confirmDestructiveActions': [
                {
                        name: 'Confirm destructive actions',
                                        desc: 'Ask before deleting a downloaded file or clearing the download log.',
                                        control: { type: 'toggle', key: 'confirmDestructiveActions' },
                },
        ],
};

export class AnimeSettingTab extends PluginSettingTab {
        plugin: AnimePlugin;

        constructor(app: App, plugin: AnimePlugin) {
                super(app, plugin);
                this.plugin = plugin;
        }


        /**
         * The page as groups. Built by the pure `settingGroups` below so the
         * coverage test can read it without an Obsidian app.
         */
        getSettingDefinitions(): SettingDefinitionItem[] {
                // A predicate, not a snapshot: the advanced groups' `visible` is
                // re-read whenever Obsidian renders or refreshes the page.
                return settingGroups(() => Boolean(this.plugin.settings.settingsAdvanced), {
                        exportDebugLog: () => void this.plugin.exportDebugLog(),
                });
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
                if (key === 'debugMode' && Boolean(value)) {
                        this.plugin.debugMachineInfo();
                        	this.plugin.debug('debug.enabled');
                }
                await this.plugin.saveSettings();
                if (key === 'settingsAdvanced') {
                        // The advanced groups exist either way and hide behind a
                        // `visible` predicate, so flipping the switch only needs
                        // the page re-evaluated — rebuilding it would also throw
                        // away the scroll position.
                        this.refreshDomState?.();
                }
        }

}

/** The side effects a settings row can run; injected so `settingGroups` stays pure. */
export interface SettingActions {
        exportDebugLog(): void;
}

/** Every setting key that has a definition, for the coverage test. */
export function definedSettingKeys(): string[] {
        return Object.keys(DEFS);
}

/**
 * The whole settings page, as groups.
 *
 * The everyday groups are always rendered; the rest appear once *Advanced
 * settings* is on. A group declared here but missing from `DEFS` renders
 * nothing, and a `DEFS` entry no group references is unreachable — both are
 * asserted by `tests/settings.test.ts`, because neither is a type error.
 */
export function settingGroups(
        advanced: boolean | (() => boolean),
        actions: SettingActions,
): SettingDefinitionItem[] {
        return [
                {
                        type: 'group',
                        heading: 'Essentials',
                        items: [
                                ...DEFS['settingsAdvanced'],
                                {
                                        name: 'Export debug log',
                                        desc: 'Move the current diagnostic log into the download folder as a copyable Markdown file, then remove the private plugin log.',
                                        action: () => actions.exportDebugLog(),
                                },
                        ],
                },
                {
                        type: 'group',
                        heading: 'Downloads and library',
                        items: [
                                ...DEFS['downloadFolder'],
                                ...DEFS['downloadQuality'],
                                ...DEFS['downloadFormat'],
                                ...DEFS['downloadSubtitles'],
                                ...DEFS['autoPlayNext'],
                                ...DEFS['confirmDestructiveActions'],
                        ],
                },
                {
                        type: 'group',
                        heading: 'Browser',
                        items: [
                                ...DEFS['browserSearchEngine'],
                                ...DEFS['browserDownloadFolder'],
                                ...DEFS['browserCompatibility'],
                        ],
                },
                {
                        type: 'group',
                        heading: 'Library and catalogue',
                        items: [
                                ...DEFS['showAdultContent'],
                                ...DEFS['animeCacheEnabled'],
                        ],
                },
                {
                        type: 'group',
                        heading: 'Downloading',
                        visible: advanced,
                        items: [
                                ...DEFS['animeApiBase'],
                                ...DEFS['downloadFilenameTemplate'],
                                ...DEFS['preferDub'],
                                ...DEFS['downloadSegmentConcurrency'],
                                ...DEFS['downloadMaxConcurrentJobs'],
                                ...DEFS['autoResumeOnLaunch'],
                                ...DEFS['downloadExternal'],
                        ],
                },
                {
                        type: 'group',
                        heading: 'Browser, technical',
                        visible: advanced,
                        items: [
                                ...DEFS['browserUserAgent'],
                                ...DEFS['browserInline'],
                        ],
                },
                {
                        type: 'group',
                        heading: 'Subtitles and player',
                        visible: advanced,
                        items: [
                                ...DEFS['subtitlesOn'],
                                ...DEFS['subtitleSize'],
                                ...DEFS['subtitleDelayMs'],
                        ],
                },
                {
                        type: 'group',
                        heading: 'Recommendations and models',
                        visible: advanced,
                        items: [
                                ...DEFS['recommendationModel'],
                                ...DEFS['jevApiKey'],
                                ...DEFS['llmProvider'],
                                ...DEFS['llmLocalModel'],
                                ...DEFS['llmBaseUrl'],
                                ...DEFS['llmModel'],
                                ...DEFS['llmApiKey'],
                                ...DEFS['llmWebSearch'],
                                ...DEFS['llmSearchUrl'],
                        ],
                },
                {
                        type: 'group',
                        heading: 'Diagnostics',
                        visible: advanced,
                        items: [
                                ...DEFS['debugMode'],
                                ...DEFS['glassEffect'],
                        ],
                },
        ];
}

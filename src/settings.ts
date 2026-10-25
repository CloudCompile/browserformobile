import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { DEFAULT_API_BASE } from './animeApi';
import type AnimePlugin from './main';

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

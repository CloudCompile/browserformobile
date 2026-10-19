import { requestUrl } from 'obsidian';

/**
 * Client for the anime-api instance at animeapi.cjhauser.me, which fronts the
 * aniwaves.ru catalogue. Only three endpoints exist and there is no schema
 * endpoint; these shapes were derived by probing the live service.
 */
export const DEFAULT_API_BASE = 'https://animeapi.cjhauser.me';

/** The `Referer` the CDN's HLS endpoints expect. Segments 404 without it. */
export const STREAM_REFERER = 'https://play.echovideo.ru/';

export interface SeriesSummary {
        id: string;
        title: string;
        japaneseTitle: string | null;
        poster: string | null;
        showType: string;
        /** Episode counts as reported by the API. */
        sub: number;
        dub: number;
        eps: number;
}

export interface EpisodeSummary {
        /** Full episode id, e.g. `naruto-76396?ep=76396_1`. */
        id: string;
        number: number;
        title: string;
        filler: boolean;
        subbed: boolean;
        dubbed: boolean;
}

export interface SeriesDetail {
        totalEpisodes: number;
        episodes: EpisodeSummary[];
}

/** A quality variant advertised by an HLS master playlist. */
export interface StreamVariant {
        /** Height in pixels, parsed from `RESOLUTION`. 0 when unknown. */
        height: number;
        width: number;
        bandwidth: number;
        url: string;
}

export interface StreamSource {
        /** Master playlist URL, or an embed iframe when the server offers no file. */
        url: string | null;
        iframe: string | null;
        server: string;
        variants: StreamVariant[];
}

/** An error the caller can show verbatim; the message is already user-facing. */
export class AnimeApiError extends Error {}

/** Read a value the API may return as a string, number, or nothing. */
function asString(value: unknown): string {
        if (typeof value === 'string') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        return '';
}

function asNumber(value: unknown): number {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
                const parsed = Number.parseFloat(value);
                return Number.isFinite(parsed) ? parsed : 0;
        }
        return 0;
}

async function getJson(base: string, path: string): Promise<unknown> {
        let response;
        try {
                response = await requestUrl({
                        url: `${base}${path}`,
                        method: 'GET',
                        throw: false,
                });
        } catch (error) {
                throw new AnimeApiError(
                        `Could not reach the anime API: ${error instanceof Error ? error.message : String(error)}`,
                );
        }
        if (response.status >= 400) {
                throw new AnimeApiError(`The anime API returned HTTP ${response.status}.`);
        }
        try {
                return response.json;
        } catch {
                throw new AnimeApiError('The anime API returned a response that was not JSON.');
        }
}

export async function searchSeries(base: string, keyword: string): Promise<SeriesSummary[]> {
        const query = keyword.trim();
        if (!query) return [];
        const payload = (await getJson(base, `/api/search?keyword=${encodeURIComponent(query)}`)) as {
                results?: { data?: unknown };
        };
        const rows = payload?.results?.data;
        if (!Array.isArray(rows)) return [];
        return rows.map((row) => {
                const record = row as Record<string, unknown>;
                const info = (record.tvInfo ?? {}) as Record<string, unknown>;
                const japaneseTitle = asString(record.japanese_title);
                const poster = asString(record.poster);
                return {
                        id: asString(record.id),
                        title: asString(record.title),
                        japaneseTitle: japaneseTitle || null,
                        poster: poster || null,
                        showType: asString(info.showType),
                        sub: asNumber(info.sub),
                        dub: asNumber(info.dub),
                        eps: asNumber(info.eps),
                };
        }).filter((series) => series.id);
}

export async function loadEpisodes(base: string, seriesId: string): Promise<SeriesDetail> {
        const payload = (await getJson(
                base,
                `/api/episodes/${encodeURIComponent(seriesId)}`,
        )) as { results?: { totalEpisodes?: unknown; episodes?: unknown } };
        const rows = payload?.results?.episodes;
        if (!Array.isArray(rows)) {
                throw new AnimeApiError('The anime API returned no episode list for this series.');
        }
        const episodes = rows.map((row) => {
                const record = row as Record<string, unknown>;
                return {
                        id: asString(record.id),
                        number: asNumber(record.episode_no),
                        title: asString(record.title),
                        filler: Boolean(record.filler),
                        subbed: Boolean(record.subbed),
                        dubbed: Boolean(record.dubbed),
                };
        }).filter((episode) => episode.id);
        return {
                totalEpisodes: asNumber(payload?.results?.totalEpisodes) || episodes.length,
                episodes,
        };
}

/** Parse an HLS master playlist into its quality variants. */
export function parseMasterPlaylist(text: string, baseUrl: string): StreamVariant[] {
        const lines = text.split(/\r?\n/);
        const variants: StreamVariant[] = [];
        for (let index = 0; index < lines.length; index++) {
                const line = lines[index];
                if (!line || !line.startsWith('#EXT-X-STREAM-INF')) continue;
                const uri = lines[index + 1];
                if (!uri || uri.startsWith('#')) continue;
                const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0);
                const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(line);
                variants.push({
                        width: resolution ? Number(resolution[1]) : 0,
                        height: resolution ? Number(resolution[2]) : 0,
                        bandwidth,
                        url: resolveUrl(uri, baseUrl),
                });
        }
        return variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

export function resolveUrl(uri: string, baseUrl: string): string {
        try {
                return new URL(uri, baseUrl).toString();
        } catch {
                return uri;
        }
}

export async function loadStream(base: string, episodeId: string): Promise<StreamSource> {
        const payload = (await getJson(
                base,
                `/api/stream?id=${encodeURIComponent(episodeId)}`,
        )) as { results?: { streamingLink?: Record<string, unknown> } };
        const link = payload?.results?.streamingLink;
        if (!link) {
                throw new AnimeApiError('The anime API returned no stream for this episode.');
        }
        const file = (link.link ?? {}) as Record<string, unknown>;
        const url = asString(file.file) || null;
        const iframe = asString(link.iframe) || null;
        const server = asString(link.server);
        // Some servers only expose an embed iframe; there is no file to download.
        if (!url) {
                return { url: null, iframe, server, variants: [] };
        }
        const response = await requestUrl({
                url,
                method: 'GET',
                headers: { Referer: STREAM_REFERER },
                throw: false,
        });
        if (response.status >= 400) {
                throw new AnimeApiError(`The stream CDN returned HTTP ${response.status}.`);
        }
        return { url, iframe, server, variants: parseMasterPlaylist(response.text, url) };
}

/**
 * Pick the variant matching a requested height, falling back to the closest
 * available one. Sources are frequently single-variant (720p), so a request for
 * 1080p must not fail the download.
 */
export function selectVariant(variants: StreamVariant[], preferredHeight: number): StreamVariant | null {
        if (variants.length === 0) return null;
        const exact = variants.find((variant) => variant.height === preferredHeight);
        if (exact) return exact;
        const atOrBelow = variants.filter((variant) => variant.height > 0 && variant.height <= preferredHeight);
        if (atOrBelow.length > 0) return atOrBelow[0] ?? null;
        return variants[0] ?? null;
}

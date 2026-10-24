import { requestUrl } from 'obsidian';
import type { AnimeCache } from './animeCache';

/**
 * Client for the anime-api instance at animeapi.cjhauser.me, which fronts the
 * aniwaves.ru catalogue. Four endpoints exist (no schema endpoint): /api/search,
 * /api/info, /api/episodes/:id, /api/stream; shapes were derived by probing the
 * live service (see review/animeapi-coverage.md).
 */
export const DEFAULT_API_BASE = 'https://animeapi.cjhauser.me';

/**
 * The cache every request goes through, installed once at plugin load. Null in
 * tests and before load, in which case requests go straight to the network.
 */
let activeCache: AnimeCache | null = null;

export function setAnimeCache(cache: AnimeCache | null): void {
        activeCache = cache;
}

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
        /** Present when the API surfaces an adult-content flag (search/filter may). */
        adultContent?: boolean;
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

export interface AnimeSeason {
        id: string;
        title: string | null;
        japaneseTitle: string | null;
        showType: string | null;
        poster: string | null;
        isActive: boolean;
}

export interface AnimeInfo {
        adultContent: boolean;
        id: string;
        dataId: string | null;
        title: string | null;
        japaneseTitle: string | null;
        poster: string | null;
        showType: string;
        duration: string | null;
        status: string | null;
        score: string | null;
        genres: string[];
        studios: string[];
        overview: string | null;
        metadata: Record<string, unknown>;
        seasons: AnimeSeason[];
        recommended: SeriesSummary[];
        related: Record<string, SeriesSummary[]>;
        popular: SeriesSummary[];
}

export interface SearchResult {
        series: SeriesSummary[];
        totalPages: number;
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

/**
 * Unique server names from the API's `servers` list, subbed tracks first so a
 * fallback keeps the same audio track the default response used. The list
 * repeats a server once per track type, so duplicates are dropped.
 */
function serverNames(servers: unknown): string[] {
        if (!Array.isArray(servers)) return [];
        const subbed: string[] = [];
        const rest: string[] = [];
        const seen = new Set<string>();
        for (const entry of servers) {
                const record = (entry ?? {}) as Record<string, unknown>;
                const name = asString(record.serverName);
                if (!name || seen.has(name)) continue;
                seen.add(name);
                if (asString(record.type) === 'sub') subbed.push(name);
                else rest.push(name);
        }
        return [...subbed, ...rest];
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

/**
 * Fetch a path as JSON, through the cache when one is installed.
 *
 * The cache key includes the base so two API endpoints cannot serve each
 * other's payloads, and the path already carries the query string, so every
 * distinct request is its own entry.
 */
async function getJson(base: string, path: string): Promise<unknown> {
        const cache = activeCache;
        if (cache) {
                const key = `${base}${path}`;
                return cache.getOrFetch(key, path, () => fetchJson(base, path));
        }
        return fetchJson(base, path);
}

async function fetchJson(base: string, path: string): Promise<unknown> {
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

export async function searchSeries(
        base: string,
        keyword: string,
        options?: { page?: number; includeAdult?: boolean },
): Promise<{ series: SeriesSummary[]; totalPages: number }> {
        const query = keyword.trim();
        if (!query) return { series: [], totalPages: 1 };
        const requestedPage = options?.page;
        const page: number = requestedPage && requestedPage > 0 && Number.isFinite(requestedPage) ? requestedPage : 1;
        const includeAdult = options?.includeAdult ?? false;

        // Build a search URL for a given page number.
        const buildUrl = (p: number): string => {
                const params: string[] = [];
                params.push(`keyword=${encodeURIComponent(query)}`);
                params.push(`page=${encodeURIComponent(String(p))}`);
                if (includeAdult) params.push('rated=R_PLUS');
                return `/api/search?${params.join('&')}`;
        };

        // Parse a raw search payload into the canonical shape. An \"empty\" over-page
        // response has no `data` array and no totalPage, so we flag it as overPage
        // instead of silently faking \"Page 1 of 1\".
        const parsePayload = (payload: unknown): { series: SeriesSummary[]; totalPages: number; overPage: boolean } => {
                const raw = (payload ?? {}) as { results?: { data?: unknown; totalPage?: unknown; message?: unknown } };
                const rows = raw?.results?.data;
                const series = Array.isArray(rows)
                        ? rows
                                .map((row) => {
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
                                                adultContent:
                                                        typeof record.adultContent === 'boolean'
                                                                ? record.adultContent
                                                                : typeof info.adultContent === 'boolean'
                                                                        ? info.adultContent
                                                                        : undefined,
                                        };
                                })
                                .filter((seriesItem) => seriesItem.id)
                        : [];
                const totalPageNumber = asNumber(raw?.results?.totalPage);
                const overPage = !Array.isArray(rows) && totalPageNumber === 0 && page > 1;
                const totalPages = Math.max(1, totalPageNumber);
                return { series, totalPages, overPage };
        };

        const firstResponse = await getJson(base, buildUrl(page));
        const first = parsePayload(firstResponse);
        if (!first.overPage) return { series: first.series, totalPages: first.totalPages };

        // Page exceeded the available range. Re-fetch page 1 to learn the real
        // total, then fetch the last valid page so the caller lands on real
        // results instead of an empty \"Page 1 of 1\".
        const pageOneResponse = await getJson(base, buildUrl(1));
        const pageOne = parsePayload(pageOneResponse);
        if (!pageOne.series.length) return { series: [], totalPages: Math.max(1, pageOne.totalPages) };
        const target = Math.max(1, Math.min(pageOne.totalPages, pageOne.totalPages));
        const lastResponse = await getJson(base, buildUrl(target));
        const last = parsePayload(lastResponse);
        return { series: last.series, totalPages: last.totalPages };
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
        if (episodes.length === 0) {
                throw new AnimeApiError('The anime API returned no episodes for this series.');
        }
        return {
                totalEpisodes: asNumber(payload?.results?.totalEpisodes) || episodes.length,
                episodes,
        };
}

export async function loadAnimeInfo(base: string, seriesId: string): Promise<AnimeInfo> {
        const payload = (await getJson(
                base,
                `/api/info?id=${encodeURIComponent(seriesId)}`,
        )) as { results?: { data?: unknown; seasons?: unknown } };

        const data = (payload?.results?.data ?? null) as Record<string, unknown> | null;
        if (!data) {
                throw new AnimeApiError('The anime API returned no details for this series.');
        }

        const animeInfo = (data.animeInfo ?? {}) as Record<string, unknown>;
        const tvInfo = (data.tvInfo ?? animeInfo.tvInfo ?? {}) as Record<string, unknown>;
        const metadata = { ...animeInfo };
        // Drop fields we hoist to top-level so they are not duplicated as raw blobs.
        delete metadata.Overview;
        delete metadata.Genre;
        delete metadata.Scores;
        delete metadata.tvInfo;

        const genresRaw = Array.isArray(animeInfo.Genre)
                ? animeInfo.Genre
                : (Array.isArray(data.Genre) ? data.Genre : []);
        const genres = genresRaw.map((g) => String(g)).filter(Boolean);

        const posterRaw = asString(data.poster);
        const japaneseRaw = asString(data.japanese_title);

        const toSummary = (row: unknown): SeriesSummary | null => {
                const record = (row ?? {}) as Record<string, unknown>;
                const id = asString(record.id);
                if (!id) return null;
                const info = (record.tvInfo ?? {}) as Record<string, unknown>;
                return {
                        id,
                        title: asString(record.title),
                        japaneseTitle: asString(record.japanese_title) || null,
                        poster: asString(record.poster) || null,
                        showType: asString(record.showType) || asString(info.showType) || 'Unknown',
                        sub: asNumber(info.sub),
                        dub: asNumber(info.dub),
                        eps: asNumber(info.eps),
                        // Mirror search path so adult-content badges stay consistent in
                        // detail view's recommended/related/popular lists. The backend only
                        // surfaces adultContent on the search payload; related entries fall
                        // back to undefined until we have richer probes (see coverage doc).
                        adultContent:
                                typeof record.adultContent === 'boolean'
                                        ? record.adultContent
                                        : typeof info.adultContent === 'boolean'
                                                ? info.adultContent
                                        : undefined,
                };
        };

        const mapList = (value: unknown): SeriesSummary[] =>
                Array.isArray(value) ? value.map(toSummary).filter((s): s is SeriesSummary => Boolean(s)) : [];

        const relatedRaw = (data.related_data ?? {}) as Record<string, unknown>;
        const related: Record<string, SeriesSummary[]> = {};
        for (const [key, value] of Object.entries(relatedRaw)) {
                related[key] = mapList(value);
        }

        const seasonsRaw = (payload?.results?.seasons ?? data.seasons ?? []) as unknown;
        const seasons: AnimeSeason[] = Array.isArray(seasonsRaw)
                ? seasonsRaw
                        .map((row) => {
                                const record = (row ?? {}) as Record<string, unknown>;
                                const id = asString(record.id);
                                if (!id) return null;
                                return {
                                        id,
                                        title: asString(record.title) || null,
                                        japaneseTitle: asString(record.japanese_title) || null,
                                        showType: asString(record.showType) || null,
                                        poster: asString(record.season_poster) || null,
                                        isActive: Boolean(record.isActive),
                                };
                        })
                        .filter((s): s is AnimeSeason => Boolean(s))
                : [];

        const overviewRaw = asString(animeInfo.Overview);
        const scoreRaw = asString(animeInfo.Scores);
        const durationRaw = asString(tvInfo.duration);
        const statusRaw = asString(animeInfo.Status) || asString(metadata.Status);
        const showType = asString(data.showType) || asString(tvInfo.showType) || 'Unknown';
        const studiosRaw = animeInfo.Studios;
        const studios = Array.isArray(studiosRaw)
                ? studiosRaw.map((s) => String(s)).filter(Boolean)
                : typeof studiosRaw === 'string' && studiosRaw.trim()
                        ? [studiosRaw.trim()]
                        : [];

        return {
                adultContent: Boolean(data.adultContent),
                id: asString(data.id) || seriesId,
                dataId: asString(data.data_id) || null,
                title: asString(data.title) || null,
                japaneseTitle: japaneseRaw || null,
                poster: posterRaw || null,
                showType,
                duration: durationRaw || null,
                status: statusRaw || null,
                score: scoreRaw || null,
                genres,
                studios,
                overview: overviewRaw || null,
                metadata,
                seasons,
                recommended: mapList(data.recommended_data),
                related,
                popular: mapList(data.popular_data),
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
        )) as { results?: { streamingLink?: Record<string, unknown>; servers?: unknown } };
        const link = payload?.results?.streamingLink;
        if (!link) {
                throw new AnimeApiError('The anime API returned no stream for this episode.');
        }

        // The API's default server does not always serve a file: for some series it
        // answers with an embed-only one while the same response's `servers` list
        // also names download-capable servers. The default is accepted as-is only
        // when it yields a file; otherwise the alternates are tried by name — the
        // API matches on `serverName` and ignores numeric ids — and the first that
        // returns a file wins. The API itself no longer returns DatSaV, but an
        // embed-only default still occurs, so this fallback stays.
        let chosen = link;
        let url = asString(((chosen.link ?? {}) as Record<string, unknown>).file) || null;
        if (!url) {
                const tried = new Set([asString(chosen.server)]);
                for (const name of serverNames(payload?.results?.servers)) {
                        if (tried.has(name)) continue;
                        tried.add(name);
                        // A single alternate can fail on its own (500, timeout); that
                        // must not abort the search, so each attempt is isolated and
                        // the next name is tried.
                        try {
                                const attempt = (await getJson(
                                        base,
                                        `/api/stream?id=${encodeURIComponent(episodeId)}&server=${encodeURIComponent(name)}`,
                                )) as { results?: { streamingLink?: Record<string, unknown> } };
                                const candidate = attempt?.results?.streamingLink;
                                const candidateUrl =
                                        asString(((candidate?.link ?? {}) as Record<string, unknown>).file) || null;
                                if (candidate && candidateUrl) {
                                        chosen = candidate;
                                        url = candidateUrl;
                                        break;
                                }
                        } catch {
                                // Try the next server.
                        }
                }
        }

        const iframe = asString(chosen.iframe) || null;
        const server = asString(chosen.server);
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

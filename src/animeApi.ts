import { loadProviderSynopsis } from './providerPage';
import {
 requestUrl } from 'obsidian';
import type { AnimeCache } from './animeCache';

/**
 * Client for the anime-api instance at animeapi.cjhauser.me. The catalogue is
 * MyAnimeList data behind /api/search, /api/info, /api/episodes/:id,
 * /api/preview/:id and /api/stream; streaming still resolves on the scraped
 * mirrors the API fronts. Rows are read tolerantly because the service has
 * changed shape once already (flat `showType`/`eps` now, `tvInfo` before, and
 * `number` now where episode rows used to carry `episode_no`).
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

/**
 * Where every successful details answer is handed, installed once at plugin
 * load and null in tests. The persistent metadata store feeds itself this way —
 * mirroring `setAnimeCache` — so anything the viewer browses once is kept for
 * offline rendering, with no extra request anywhere.
 */
let metadataSink: ((seriesId: string, payload: AnimePreview) => void) | null = null;
/** Where diagnostics go, so a page the plugin cannot read is explainable. */
let debugHook: ((message: string, details?: unknown) => void) | null = null;

/** Route this module's diagnostics to the plugin's debug log. */
export function setAnimeDebugHook(hook: ((message: string, details?: unknown) => void) | null): void {
        debugHook = hook;
}

export function setMetadataSink(sink: ((seriesId: string, payload: AnimePreview) => void) | null): void {
        metadataSink = sink;
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
        /** Catalogue score out of 10, when the row carries a numeric one. */
        rating?: number | null;
        /**
         * Newest episode number, for a source whose listing is an episode feed
         * rather than a series list. The 18+ browse feed reports one per row.
         */
        episodeNumber?: number | null;
        /** Present when the API surfaces an adult-content flag (search/filter may). */
        adultContent?: boolean;
        /**
         * Streaming source this entry came from. Undefined is the native
         * (aniwaves) catalogue; `hentaimama` is the opt-in 18+ source whose ids
         * are slugs and which is reached through `/api/providers/...`.
         */
        provider?: string;
}

export interface EpisodeSummary {
        /** Full episode id, e.g. `naruto-76396?ep=76396_1`. */
        id: string;
        number: number;
        title: string;
        filler: boolean;
        subbed: boolean;
        dubbed: boolean;
        /** Streaming source, so a download routes back to the right provider. */
        provider?: string;
        /**
         * Episode still, when the source publishes one. Only the 18+ provider
         * does; the native catalogue's episode rows carry no art.
         */
        poster?: string | null;
}

export interface SeriesDetail {
        totalEpisodes: number;
        episodes: EpisodeSummary[];
}

/**
 * Episode rows per picker group. A series at or below this many episodes
 * renders as one flat list exactly as it always did; only a genuinely long
 * series pays for the grouping chrome.
 */
export const EPISODE_GROUP_SIZE = 50;

/** One numeric chunk of a long episode list. */
export interface EpisodeGroup {
        /** Honest range, e.g. `Episodes 101–150` — never an invented season. */
        label: string;
        episodes: EpisodeSummary[];
}

/**
 * Plan the episode picker's groups.
 *
 * The API's episode list is flat: it carries no season boundaries, so any
 * "Season 2" heading would be an invention. Long lists are chunked by position
 * instead and labelled with the episode numbers actually inside the chunk —
 * including any gaps the catalogue leaves in its numbering. Returns null when
 * the list is short enough to render flat.
 */
export function planEpisodeGroups(episodes: EpisodeSummary[], size = EPISODE_GROUP_SIZE): EpisodeGroup[] | null {
        if (episodes.length <= size) return null;
        const groups: EpisodeGroup[] = [];
        for (let start = 0; start < episodes.length; start += size) {
                const chunk = episodes.slice(start, start + size);
                const first = chunk[0]?.number ?? 0;
                const last = chunk[chunk.length - 1]?.number ?? first;
                groups.push({
                        label: first === last ? `Episode ${first}` : `Episodes ${first}\u2013${last}`,
                        episodes: chunk,
                });
        }
        return groups;
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
        /** Streaming source this detail belongs to; undefined is the native one. */
        provider?: string;
        /** Episode count for sources whose detail page reports it directly. */
        episodeCount?: number | null;
        /** First broadcast year when the source reports one. */
        year?: number | null;
        /** View count, when the source reports one. */
        views?: number | null;
        /** Air date as the source prints it, e.g. `Aug 2023`. */
        aired?: string | null;
        /** Age rating, when the source reports one. */
        rating?: string | null;
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
        /**
         * Request headers the CDN requires for the manifest and its segments.
         * The API publishes the player origin its current CDN expects, and that
         * origin moves with the CDN, so a hardcoded referer 403s once it does.
         */
        headers: Record<string, string>;
        variants: StreamVariant[];
        /**
         * Subtitle renditions advertised by the master playlist, in playlist
         * order. Empty for a stream that carries none, so the downloader makes
         * no extra requests.
         */
        subtitles: SubtitleRendition[];
}

/** A subtitle rendition from an HLS master playlist's `#EXT-X-MEDIA` lines. */
export interface SubtitleRendition {
        /** Human label, e.g. `English`. */
        name: string;
        /** BCP-47-ish language tag from `LANGUAGE=`, or null when unlabelled. */
        language: string | null;
        /** Media playlist URL of the WebVTT segments. */
        url: string;
}

/**
 * Unique server names from the API's `servers` list, ordered by track type so a
 * fallback keeps the same audio track the default response used. The list
 * repeats a server once per track type, so duplicates are dropped.
 *
 * `preferDub` hoists the dubbed servers to the front — a dub preference, not a
 * guarantee: many series list no dubbed server at all, and those are unaffected.
 */
export function serverNames(servers: unknown, preferDub = false): string[] {
        if (!Array.isArray(servers)) return [];
        const subbed: string[] = [];
        const dubbed: string[] = [];
        const rest: string[] = [];
        const seen = new Set<string>();
        for (const entry of servers) {
                const record = (entry ?? {}) as Record<string, unknown>;
                const name = asString(record.serverName);
                if (!name || seen.has(name)) continue;
                seen.add(name);
                const type = asString(record.type);
                if (type === 'sub') subbed.push(name);
                else if (type === 'dub' && preferDub) dubbed.push(name);
                else rest.push(name);
        }
        return preferDub ? [...dubbed, ...subbed, ...rest] : [...subbed, ...rest];
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
 * A count published either as a number or as a formatted string.
 *
 * The scraper hands view counts through as it reads them, so `1079075` and
 * `1,079,075` both arrive; `parseFloat` would read the second one as 1.
 */
function asCount(value: unknown): number {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
        const digits = asString(value).replace(/[^\d]/g, '');
        return digits ? Number.parseInt(digits, 10) : 0;
}

/** A count, or null when it is absent or zero. */
function asNullableCount(value: unknown): number | null {
        if (value === null || value === undefined || value === '') return null;
        const count = asCount(value);
        return count > 0 ? count : null;
}

/**
 * A score out of ten, or null when the field is absent or not numeric.
 *
 * Catalogue rows publish `rating: "8.4"`; the 18+ detail record reuses the
 * same key for an age rating (`"Rx - Hentai"`), so a non-numeric value is
 * simply not a score and must not become one.
 */
function asRating(value: unknown): number | null {
        if (value === null || value === undefined || value === '') return null;
        const score = asNumber(value);
        return score > 0 ? score : null;
}

/**
 * The episode a feed row points at, across the shapes the source has served.
 *
 * The current 18+ feed publishes `episodeNumber`; older cached rows carry only
 * the label (`japanese_title: "Episode 4"`) or the episode slug
 * (`…-episode-4`), so both are read as fallbacks.
 */
function episodeNumberFrom(record: Record<string, unknown>): number | null {
        const explicit = asNumber(record.episodeNumber) || asNumber(record.episode_number);
        if (explicit > 0) return explicit;
        const label = asString(record.japanese_title) || asString(record.japaneseTitle);
        const labelled = /episode\s*(\d+)/i.exec(label);
        if (labelled) return Number.parseInt(labelled[1] ?? '', 10);
        const slug = asString(record.episode);
        const trailing = /-episode-(\d+)$/i.exec(slug);
        return trailing ? Number.parseInt(trailing[1] ?? '', 10) : null;
}

/**
 * The display fields of a catalogue row, across both shapes the API has served.
 *
 * List and search rows are flat now (`showType`, `eps`, no sub/dub counts),
 * while `/api/info` still nests a small `tvInfo` under `animeInfo` and cached
 * payloads from before the change used `tvInfo` everywhere. Reading every form
 * keeps old cache entries and the current service on one parser.
 */
function summaryFields(record: Record<string, unknown>): {
        showType: string;
        sub: number;
        dub: number;
        eps: number;
} {
        const info = (record.tvInfo ?? {}) as Record<string, unknown>;
        const animeInfo = (record.animeInfo ?? {}) as Record<string, unknown>;
        const nested = (animeInfo.tvInfo ?? {}) as Record<string, unknown>;
        return {
                showType: asString(record.showType) || asString(info.showType) || asString(nested.showType),
                sub: asNumber(info.sub) || asNumber(nested.sub),
                dub: asNumber(info.dub) || asNumber(nested.dub),
                eps: asNumber(record.eps) || asNumber(info.eps) || asNumber(nested.eps),
        };
}

/**
 * The request headers a stream's CDN needs, defaulting the old player origin.
 * The API's `Referer` is authoritative; anything else it publishes is kept, so
 * a CDN that starts demanding another header needs no client change.
 */
function requestHeaders(value: unknown): Record<string, string> {
        const headers: Record<string, string> = {};
        if (value && typeof value === 'object') {
                for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
                        const text = asString(raw);
                        if (key && text) headers[key] = text;
                }
        }
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'referer')) {
                headers.Referer = STREAM_REFERER;
        }
        return headers;
}

/**
 * Caption tracks published beside the stream rather than inside the HLS
 * playlist. The current CDN serves one whole WebVTT file per track (and a
 * `thumbnails` track that is not a subtitle), so they map into the same
 * rendition shape the playlist parser produces. The downloader detects a
 * document instead of a segment playlist.
 */
/**
 * A stream's subtitles: its playlist's own renditions when it has any, and the
 * separate caption tracks only when it does not. Preferring one source keeps a
 * stream that publishes both from downloading the same captions twice.
 */
function playlistSubtitles(playlist: string, url: string, tracks: unknown): SubtitleRendition[] {
        const renditions = parseSubtitleRenditions(playlist, url);
        return renditions.length > 0 ? renditions : tracksAsSubtitles(tracks);
}

function tracksAsSubtitles(value: unknown): SubtitleRendition[] {
        if (!Array.isArray(value)) return [];
        const renditions: SubtitleRendition[] = [];
        for (const row of value) {
                const track = (row ?? {}) as Record<string, unknown>;
                const kind = asString(track.kind).toLowerCase();
                if (kind && kind !== 'captions' && kind !== 'subtitles') continue;
                const url = asString(track.file) || asString(track.url);
                if (!url) continue;
                renditions.push({
                        name: asString(track.label) || 'Subtitles',
                        language: asString(track.language) || null,
                        url,
                });
        }
        return renditions;
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

/**
 * The opt-in 18+ streaming source. Its own catalogue ids use the `hm:`
 * namespace and answer the native routes; only the legacy provider routes need
 * this name. `ADULT_PROVIDER` is still what a series opened from an older
 * search carries, so those entries keep resolving through their provider.
 */
export const ADULT_PROVIDER = 'hentaimama';

/** The `hm:` namespace of the 18+ source's own catalogue. */
const ADULT_REFERENCE_PREFIX = 'hm:';

/** True for an `hm:<slug>` series id or an `hm:<slug>:<n>` episode id. */
export function isAdultReference(id: string): boolean {
        return (id ?? '').trim().toLowerCase().startsWith(ADULT_REFERENCE_PREFIX);
}

/**
 * Pull the adult source's hits out of an aggregate search's `sources` array and
 * flatten them into the native `SeriesSummary` shape, tagging each with its
 * provider so later requests route to the right endpoint.
 */
function collectAdultSources(sources: unknown): SeriesSummary[] {
        if (!Array.isArray(sources)) return [];
        const out: SeriesSummary[] = [];
        for (const source of sources) {
                const record = (source ?? {}) as Record<string, unknown>;
                if (record.provider !== ADULT_PROVIDER) continue;
                if (record.ok !== true || !Array.isArray(record.results)) continue;
                for (const row of record.results as unknown[]) {
                        const entry = (row ?? {}) as Record<string, unknown>;
                        const id = asString(entry.slug) || asString(entry.id);
                        if (!id) continue;
                        out.push({
                                id,
                                title: asString(entry.title),
                                japaneseTitle: asString(entry.japaneseTitle) || null,
                                poster: asString(entry.poster) || null,
                                showType: asString(entry.type) || 'TV',
                                sub: 0,
                                dub: 0,
                                eps: asNumber(entry.episodes),
                                rating: asRating(entry.rating),
                                adultContent: true,
                                provider: ADULT_PROVIDER,
                        });
                }
        }
        return out;
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
                // The catalogue's own opt-in flag. It also folds in the titles
                // only the 18+ source carries, as `hm:` rows in `data`.
                if (includeAdult) params.push('includeAdult=1');
                return `/api/search?${params.join('&')}`;
        };

        // Parse a raw search payload into the canonical shape. An \"empty\" over-page
        // response has no `data` array and no totalPage, so we flag it as overPage
        // instead of silently faking \"Page 1 of 1\".
        const parsePayload = (payload: unknown): { series: SeriesSummary[]; totalPages: number; overPage: boolean } => {
                const raw = (payload ?? {}) as { results?: { data?: unknown; totalPage?: unknown; message?: unknown; sources?: unknown } };
                const rows = raw?.results?.data;
                const series = Array.isArray(rows)
                        ? rows
                                .map((row) => {
                                        const record = row as Record<string, unknown>;
                                        const info = (record.tvInfo ?? {}) as Record<string, unknown>;
                                        const fields = summaryFields(record);
                                        const id = asString(record.id);
                                        const japaneseTitle =
                                                asString(record.japanese_title) || asString(record.japaneseTitle);
                                        const poster = asString(record.poster) || asString(record.image);
                                        return {
                                                id,
                                                title: asString(record.title),
                                                japaneseTitle: japaneseTitle || null,
                                                poster: poster || null,
                                                showType: fields.showType,
                                                sub: fields.sub,
                                                dub: fields.dub,
                                                eps: fields.eps,
                                                rating: asRating(record.rating),
                                                // `hm:` rows are adult-only titles the MAL
                                                // mirror does not carry, so the id itself is
                                                // the flag. MAL rows keep their explicit one.
                                                adultContent:
                                                        isAdultReference(id) ||
                                                        record.adultContent === true ||
                                                        info.adultContent === true
                                                                ? true
                                                                : undefined,
                                        };
                                })
                                .filter((seriesItem) => seriesItem.id)
                        : [];
                // Older builds fanned the opt-in search out to the 18+ provider and
                // returned its hits under `sources`. Current builds append them to
                // `data` as `hm:` rows. Read both so a cached answer still works.
                const extra = includeAdult ? collectAdultSources(raw?.results?.sources) : [];
                const totalPageNumber = asNumber(raw?.results?.totalPage);
                const overPage = !Array.isArray(rows) && totalPageNumber === 0 && page > 1;
                const totalPages = Math.max(1, totalPageNumber);
                return { series: [...series, ...extra], totalPages, overPage };
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
        const target = Math.max(1, pageOne.totalPages);
        const lastResponse = await getJson(base, buildUrl(target));
        const last = parsePayload(lastResponse);
        return { series: last.series, totalPages: last.totalPages };
}

/** One page of a browse listing (a section or a genre), from either source. */
export interface BrowsePage {
        series: SeriesSummary[];
        /**
         * Exact page count when the source reports one, or null when its count
         * cannot be trusted. The native routes answer `totalPages: page + 1`
         * with `hasNextPage: true` on every page, so their number is discarded
         * rather than shown or used to stop paging.
         */
        totalPages: number | null;
        page: number;
        /** Whether another page may hold titles. */
        hasNextPage: boolean;
}

/** A genre the current source can be filtered by. */
export interface GenreRef {
        slug: string;
        name: string;
}

/** Browse a listing section, e.g. `most-popular`, `movie`, `top-airing`. */
export async function browseSection(
        base: string,
        section: string,
        page: number,
        source?: string,
): Promise<BrowsePage> {
        if (source === ADULT_PROVIDER) {
                const payload = (await getJson(
                        base,
                        `/api/adult/browse?section=${encodeURIComponent(section)}&page=${page}`,
                )) as { results?: { data?: unknown; totalPages?: unknown; page?: unknown } };
                return adultPage(payload?.results);
        }
        const payload = (await getJson(
                base,
                `/api/${encodeURIComponent(section)}?page=${page}`,
        )) as { results?: { data?: unknown; totalPages?: unknown; page?: unknown } };
        return nativePage(payload?.results, page);
}

/** Browse one genre's titles, paginated. */
export async function browseGenre(
        base: string,
        slug: string,
        page: number,
        source?: string,
): Promise<BrowsePage> {
        if (source === ADULT_PROVIDER) {
                const payload = (await getJson(
                        base,
                        `/api/adult/browse?genre=${encodeURIComponent(slug)}&page=${page}`,
                )) as { results?: { data?: unknown; totalPages?: unknown; page?: unknown } };
                return adultPage(payload?.results);
        }
        // The catalogue's `/api/genre/<slug>` routes are a fixed legacy list, so
        // any genre added since answers 404. The filter controller resolves the
        // same slug against the live genre index, so it covers every genre the
        // catalogue advertises, with the same list shape and paging.
        const payload = (await getJson(
                base,
                `/api/filter?genre=${encodeURIComponent(slug)}&page=${page}`,
        )) as { results?: { data?: unknown; totalPages?: unknown; page?: unknown } };
        return nativePage(payload?.results, page);
}

/**
 * Genre slugs the catalogue indexes by name. Its `genre.idFor` tries the
 * original name first and this slug second, so slugifying the published names
 * is enough to address `/api/genre/<slug>` without hardcoding an id table.
 */
function genreSlug(name: string): string {
        return name
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/['’`]/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 80);
}

/**
 * Genre names the native (non-opted-in) tab must not advertise. The catalogue's
 * own index includes them, but the plugin only opens that door through the 18+
 * checkbox, and a public genre page would bypass it. Ecchi stays, matching the
 * list this plugin has always shown.
 */
const GATED_GENRE_SLUGS = new Set(['hentai', 'erotica']);

/**
 * The genre list for the source.
 *
 * The 18+ source is scraped; the native one is the catalogue's own index from
 * the home payload. That list is authoritative — the old hardcoded names went
 * stale when the catalogue moved and some (`cars`, `dementia`, …) now match
 * nothing — so it is read per source and sorted for a stable grid. The bundled
 * list remains as the offline fallback when the home call fails.
 */
export async function loadGenres(base: string, source?: string): Promise<GenreRef[]> {
        if (source === ADULT_PROVIDER) {
                const payload = (await getJson(base, '/api/adult/genres')) as {
                        results?: { data?: unknown };
                };
                const rows = payload?.results?.data;
                return Array.isArray(rows)
                        ? rows
                                .map((row) => {
                                        const record = (row ?? {}) as Record<string, unknown>;
                                        return { slug: asString(record.slug), name: asString(record.name) };
                                })
                                .filter((genre) => genre.slug && genre.name)
                        : [];
        }

        try {
                const payload = (await getJson(base, '/api')) as { results?: { genres?: unknown } };
                const names = payload?.results?.genres;
                if (Array.isArray(names)) {
                        const genres = names
                                .map((name) => asString(name))
                                .filter(Boolean)
                                .map((name) => ({ slug: genreSlug(name), name }))
                                .filter((genre) => genre.slug && !GATED_GENRE_SLUGS.has(genre.slug))
                                .sort((left, right) => left.name.localeCompare(right.name));
                        if (genres.length > 0) return genres;
                }
        } catch {
                // Fall back to the bundled list: browsing still works offline.
        }
        return NATIVE_GENRES.map((genre) => ({ ...genre }));
}

/** The native catalogue's genre pages, matching `/api/genre/<slug>`. */
export const NATIVE_GENRES: GenreRef[] = [
        { slug: 'action', name: 'Action' },
        { slug: 'adventure', name: 'Adventure' },
        { slug: 'cars', name: 'Cars' },
        { slug: 'comedy', name: 'Comedy' },
        { slug: 'dementia', name: 'Dementia' },
        { slug: 'demons', name: 'Demons' },
        { slug: 'drama', name: 'Drama' },
        { slug: 'ecchi', name: 'Ecchi' },
        { slug: 'fantasy', name: 'Fantasy' },
        { slug: 'game', name: 'Game' },
        { slug: 'harem', name: 'Harem' },
        { slug: 'historical', name: 'Historical' },
        { slug: 'horror', name: 'Horror' },
        { slug: 'isekai', name: 'Isekai' },
        { slug: 'josei', name: 'Josei' },
        { slug: 'kids', name: 'Kids' },
        { slug: 'magic', name: 'Magic' },
        { slug: 'martial-arts', name: 'Martial Arts' },
        { slug: 'mecha', name: 'Mecha' },
        { slug: 'military', name: 'Military' },
        { slug: 'music', name: 'Music' },
        { slug: 'mystery', name: 'Mystery' },
        { slug: 'parody', name: 'Parody' },
        { slug: 'police', name: 'Police' },
        { slug: 'psychological', name: 'Psychological' },
        { slug: 'romance', name: 'Romance' },
        { slug: 'samurai', name: 'Samurai' },
        { slug: 'school', name: 'School' },
        { slug: 'sci-fi', name: 'Sci-Fi' },
        { slug: 'seinen', name: 'Seinen' },
        { slug: 'shoujo', name: 'Shoujo' },
        { slug: 'shoujo-ai', name: 'Shoujo Ai' },
        { slug: 'shounen', name: 'Shounen' },
        { slug: 'shounen-ai', name: 'Shounen Ai' },
        { slug: 'slice-of-life', name: 'Slice of Life' },
        { slug: 'space', name: 'Space' },
        { slug: 'sports', name: 'Sports' },
        { slug: 'super-power', name: 'Super Power' },
        { slug: 'supernatural', name: 'Supernatural' },
        { slug: 'thriller', name: 'Thriller' },
        { slug: 'vampire', name: 'Vampire' },
];

function toNativeSummary(record: Record<string, unknown>): SeriesSummary {
        const fields = summaryFields(record);
        return {
                id: asString(record.id),
                title: asString(record.title),
                japaneseTitle: asString(record.japanese_title) || asString(record.japaneseTitle) || null,
                poster: asString(record.poster) || asString(record.image) || null,
                showType: fields.showType || 'Unknown',
                sub: fields.sub,
                dub: fields.dub,
                eps: fields.eps,
                rating: asRating(record.rating),
        };
}

function nativePage(results: unknown, requestedPage: number): BrowsePage {
        const record = (results ?? {}) as Record<string, unknown>;
        const rows = Array.isArray(record.data) ? record.data : [];
        return {
                series: rows.map((row) => toNativeSummary(row as Record<string, unknown>)).filter((series) => series.id),
                // The native routes always report `currentPage + 1` pages and
                // `hasNextPage: true`, so their count is not a fact. A page with
                // no rows is the only honest end.
                totalPages: null,
                page: asNumber(record.page) || asNumber(record.currentPage) || requestedPage,
                hasNextPage: rows.length > 0 && record.hasNextPage !== false,
        };
}

function adultPage(results: unknown): BrowsePage {
        const record = (results ?? {}) as Record<string, unknown>;
        const rows = Array.isArray(record.data) ? record.data : [];
        const series = rows
                .map((row): SeriesSummary | null => {
                        const entry = (row ?? {}) as Record<string, unknown>;
                        // Current rows are already `hm:` references in the contract
                        // shape (`showType`, `eps`, `japanese_title`). An older cached
                        // response still carries the provider's `slug`/`type` fields.
                        const id = asString(entry.id) || asString(entry.slug);
                        if (!id) return null;
                        const fields = summaryFields(entry);
                        const native = isAdultReference(id);
                        return {
                                id,
                                title: asString(entry.title),
                                japaneseTitle:
                                        asString(entry.japanese_title) ||
                                        asString(entry.japaneseTitle) ||
                                        null,
                                poster: asString(entry.poster) || asString(entry.image) || null,
                                showType: fields.showType || 'TV',
                                sub: fields.sub,
                                dub: fields.dub,
                                eps: fields.eps || asNumber(entry.episodes),
                                rating: asRating(entry.rating),
                                episodeNumber: episodeNumberFrom(entry),
                                adultContent: true,
                                provider: native ? undefined : ADULT_PROVIDER,
                        };
                })
                .filter((series): series is SeriesSummary => series !== null);
        const totalPages = asNumber(record.totalPages) || asNumber(record.totalPage);
        const page = asNumber(record.page) || asNumber(record.currentPage) || 1;
        return {
                series,
                totalPages: totalPages > 0 ? totalPages : null,
                page,
                hasNextPage:
                        typeof record.hasNextPage === 'boolean'
                                ? record.hasNextPage
                                : totalPages > 0 && page < totalPages,
        };
}

/**
 * Poster URLs mined from cached API responses, keyed by lowercased title.
 *
 * The library's grid mode needs a cover per series. The catalogue already
 * served one in every search, info, and preview response the user has browsed,
 * and those answers sit in the persisted cache — so the grid is filled from
 * what is already on disk rather than issuing a round of poster requests the
 * API (which runs serverless, with no cache of its own) would answer cold.
 *
 * Pure and tolerant: it walks the cached envelopes for `title` plus `poster`/
 * `image` pairs at a bounded depth, keeps the first URL per title, and skips
 * anything that is not an http(s) URL. Titles without a poster simply have no
 * entry, and the UI shows a fallback card for those.
 */
export function collectPosters(records: unknown): Map<string, string> {
        const posters = new Map<string, string>();
        const visit = (value: unknown, depth: number): void => {
                if (!value || typeof value !== 'object' || depth > 6) return;
                if (Array.isArray(value)) {
                        for (const item of value) visit(item, depth + 1);
                        return;
                }
                const record = value as Record<string, unknown>;
                const title = typeof record.title === 'string' ? record.title.trim() : '';
                const image =
                        typeof record.poster === 'string' && record.poster
                                ? record.poster
                                : typeof record.image === 'string'
                                  ? record.image
                                  : '';
                if (title && /^https?:\/\//i.test(image)) {
                        const key = title.toLowerCase();
                        if (!posters.has(key)) posters.set(key, image);
                }
                for (const item of Object.values(record)) visit(item, depth + 1);
        };
        if (!records || typeof records !== 'object') return posters;
        for (const entry of Object.values(records as Record<string, unknown>)) {
                const value = entry && typeof entry === 'object' ? (entry as { value?: unknown }).value : null;
                visit(value, 0);
        }
        return posters;
}

export async function loadEpisodes(base: string, seriesId: string, provider?: string): Promise<SeriesDetail> {
        // The 18+ source is addressed by slug through its own provider route and
        // returns a flat episode list rather than the native nested shape.
        if (provider === ADULT_PROVIDER) {
                const payload = (await getJson(
                        base,
                        `/api/providers/${ADULT_PROVIDER}/episodes?id=${encodeURIComponent(seriesId)}`,
                )) as { results?: { data?: unknown } };
                const rows = payload?.results?.data;
                if (!Array.isArray(rows)) {
                        throw new AnimeApiError('The anime API returned no episode list for this series.');
                }
                const episodes = rows
                        .map((row) => {
                                const record = row as Record<string, unknown>;
                                const id = asString(record.slug) || asString(record.id);
                                return {
                                        id,
                                        number: asNumber(record.number),
                                        title: asString(record.title),
                                        filler: false,
                                        subbed: true,
                                        dubbed: false,
                                        provider: ADULT_PROVIDER,
                                        poster: asString(record.poster) || null,
                                };
                        })
                        .filter((episode) => episode.id);
                if (episodes.length === 0) {
                        throw new AnimeApiError('The anime API returned no episodes for this series.');
                }
                return { totalEpisodes: episodes.length, episodes };
        }

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
                // `number` is the current field; `episode_no` is what the
                // previous catalogue served and what older cache entries hold.
                const number = asNumber(record.number) || asNumber(record.episode_no);
                return {
                        id: asString(record.id),
                        number,
                        title: asString(record.title) || `Episode ${number}`,
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

export async function loadAnimeInfo(base: string, seriesId: string, provider?: string): Promise<AnimeInfo> {
        // The 18+ source has no native info/preview endpoint; its provider detail
        // is mapped into the same shape with no related/season blocks.
        if (provider === ADULT_PROVIDER) {
                const payload = (await getJson(
                        base,
                        `/api/providers/${ADULT_PROVIDER}/anime?id=${encodeURIComponent(seriesId)}`,
                )) as { results?: { data?: unknown } };
                const data = (payload?.results?.data ?? null) as Record<string, unknown> | null;
                if (!data) {
                        throw new AnimeApiError('The anime API returned no details for this series.');
                }
                const episodes = asNumber(data.episodes);
                const year = asNumber(data.year);
                const description = asString(data.description) || null;
                return {
                        adultContent: true,
                        id: asString(data.slug) || seriesId,
                        dataId: asString(data.id) || null,
                        title: asString(data.title) || null,
                        japaneseTitle: asString(data.japaneseTitle) || null,
                        poster: asString(data.poster) || null,
                        showType: asString(data.type) || 'TV',
                        duration: null,
                        status: asString(data.status) || providerStatus(asString(data.description)),
                        score: asString(data.score) || null,
                        views: asNullableCount(data.views),
                        aired: asString(data.aired) || null,
                        genres: Array.isArray(data.genres) ? data.genres.map((g) => String(g)).filter(Boolean) : [],
                        studios: Array.isArray(data.studios) ? data.studios.map((s) => String(s)).filter(Boolean) : [],
                        overview: readableSynopsis(description),
                        // The page URL and raw description, so the details loader can
                        // read the source's real synopsis when it wants one.
                        metadata: {
                                ...(asString(data.url) ? { pageUrl: asString(data.url) } : {}),
                                ...(description && isProviderTemplate(description) ? { description } : {}),
                        },
                        seasons: [],
                        recommended: [],
                        related: {},
                        popular: [],
                        provider: ADULT_PROVIDER,
                        episodeCount: episodes > 0 ? episodes : null,
                        year: year > 0 ? year : null,
                        rating: asString(data.rating) || null,
                };
        }

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
                const fields = summaryFields(record);
                return {
                        id,
                        title: asString(record.title),
                        japaneseTitle: asString(record.japanese_title) || asString(record.japaneseTitle) || null,
                        poster: asString(record.poster) || asString(record.image) || null,
                        showType: fields.showType || 'Unknown',
                        sub: fields.sub,
                        dub: fields.dub,
                        eps: fields.eps,
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
        // The scraper publishes these on the page but the catalogue's own shape
        // spelled them per-field; both arrive as displayed text.
        const viewsRaw = asNullableCount(animeInfo.Views ?? animeInfo.views);
        const airedRaw = asString(animeInfo['Date aired']) || asString(animeInfo.aired);
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
                // The catalogue nests the authoritative flag under `animeInfo`;
                // older payloads carried it at the top level. Either is valid.
                adultContent: Boolean(data.adultContent ?? animeInfo.adultContent),
                id: asString(data.id) || seriesId,
                dataId: asString(data.data_id) || null,
                title: asString(data.title) || null,
                japaneseTitle: japaneseRaw || null,
                poster: posterRaw || null,
                showType,
                duration: durationRaw || null,
                status: statusRaw || null,
                score: scoreRaw || null,
                views: viewsRaw,
                aired: airedRaw || null,
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

/**
 * Parse the subtitle renditions of an HLS master playlist.
 *
 * Subtitles ride the same `#EXT-X-MEDIA` tag as audio tracks, so only
 * `TYPE=SUBTITLES` entries are read. Attribute values are quoted and may
 * contain commas (a name like `English, CC`), so the list is split on commas
 * outside quotes. A rendition without a URI is skipped: there is nothing to
 * fetch. Returns them in playlist order — most sources list their default
 * language first.
 */
export function parseSubtitleRenditions(text: string, baseUrl: string): SubtitleRendition[] {
        const renditions: SubtitleRendition[] = [];
        for (const line of text.split(/\r?\n/)) {
                if (!line.startsWith('#EXT-X-MEDIA:')) continue;
                if (!/(^|[,:])TYPE=SUBTITLES([,\s]|$)/i.test(line)) continue;
                const attributes = splitAttributes(line.slice('#EXT-X-MEDIA:'.length));
                const uri = attributes.get('URI');
                if (!uri) continue;
                renditions.push({
                        name: attributes.get('NAME') ?? '',
                        language: attributes.get('LANGUAGE') || null,
                        url: resolveUrl(uri, baseUrl),
                });
        }
        return renditions;
}

/**
 * Split an attribute list on commas that are not inside quotes, and return the
 * `KEY=value` pairs as a map. Values keep their quotes stripped; a malformed
 * pair is skipped rather than shifting the rest.
 */
function splitAttributes(text: string): Map<string, string> {
        const parts: string[] = [];
        let current = '';
        let quoted = false;
        for (const character of text) {
                if (character === '"') quoted = !quoted;
                if (character === ',' && !quoted) {
                        parts.push(current);
                        current = '';
                        continue;
                }
                current += character;
        }
        if (current) parts.push(current);
        const attributes = new Map<string, string>();
        for (const part of parts) {
                const equals = part.indexOf('=');
                if (equals <= 0) continue;
                const key = part.slice(0, equals).trim().toUpperCase();
                const value = part.slice(equals + 1).trim().replace(/^"|"$/g, '');
                if (key) attributes.set(key, value);
        }
        return attributes;
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

export async function loadStream(
        base: string,
        episodeId: string,
        provider?: string,
        preferDub = false,
        /** Opt the request into the 18+ playback chain (a MAL-indexed title). */
        includeAdult = false,
): Promise<StreamSource> {
        // The 18+ source resolves a single direct file through its own route: the
        // provider picks the first playable mirror (HLS preferred) itself, so
        // there is no native server-fallback dance to run here.
        if (provider === ADULT_PROVIDER) {
                const payload = (await getJson(
                        base,
                        `/api/providers/${ADULT_PROVIDER}/stream?id=${encodeURIComponent(episodeId)}`,
                )) as { results?: { data?: Record<string, unknown> } };
                const data = payload?.results?.data;
                const link = (data?.link ?? {}) as Record<string, unknown>;
                const url = asString(link.file) || null;
                const headers = requestHeaders(data?.headers);
                if (!data || !url) {
                        return { url: null, iframe: asString(data?.embed) || null, server: asString(data?.server), variants: [], subtitles: [], headers };
                }
                // HLS resolves to quality variants; a single-file MP4 mirror is
                // one variant whose height is unknown until it is probed. The API
                // declares the container in `link.type`, and its `hls-mp4` and
                // `r2-mp4` mirrors are single MP4 files despite the name, so the
                // declared type decides and the URL is only the fallback.
                const declared = asString(link.type) || asString(data.type);
                const isHls = declared ? declared.toLowerCase() === 'hls' : /\.m3u8($|\?)/i.test(url);
                if (!isHls) {
                        return { url, iframe: null, server: asString(data?.server), variants: [{ height: 0, width: 0, bandwidth: 0, url }], subtitles: [], headers };
                }
                const response = await requestUrl({ url, method: 'GET', headers, throw: false });
                if (response.status >= 400) {
                        throw new AnimeApiError(`The stream CDN returned HTTP ${response.status}.`);
                }
                return {
                        url,
                        iframe: null,
                        server: asString(data?.server),
                        variants: parseMasterPlaylist(response.text, url),
                        subtitles: playlistSubtitles(response.text, url, data?.tracks),
                        headers,
                };
        }

        // Adult titles the MAL mirror indexes stream only when the caller opts
        // in; without this the API answers 502 and the job fails for nothing.
        // `hm:` episode ids are an opt-in on their own and ignore the flag.
        const adultQuery = includeAdult ? '&includeAdult=1' : '';
        const payload = (await getJson(
                base,
                `/api/stream?id=${encodeURIComponent(episodeId)}${adultQuery}`,
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
                for (const name of serverNames(payload?.results?.servers, preferDub)) {
                        if (tried.has(name)) continue;
                        tried.add(name);
                        // A single alternate can fail on its own (500, timeout); that
                        // must not abort the search, so each attempt is isolated and
                        // the next name is tried.
                        try {
                                const attempt = (await getJson(
                                        base,
                                        `/api/stream?id=${encodeURIComponent(episodeId)}${adultQuery}&server=${encodeURIComponent(name)}`,
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
        // The API publishes the headers its CDN demands and the player origin
        // moves with the CDN, so forward its answer verbatim. The old hardcoded
        // referer now earns a 403 on both the manifest and every segment.
        const headers = requestHeaders(chosen.headers);
        // Some servers only expose an embed iframe; there is no file to download.
        if (!url) {
                return { url: null, iframe, server, variants: [], subtitles: [], headers };
        }
        const response = await requestUrl({
                url,
                method: 'GET',
                headers,
                throw: false,
        });
        if (response.status >= 400) {
                throw new AnimeApiError(`The stream CDN returned HTTP ${response.status}.`);
        }
        return {
                url,
                iframe,
                server,
                variants: parseMasterPlaylist(response.text, url),
                subtitles: playlistSubtitles(response.text, url, chosen.tracks),
                headers,
        };
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

// ---------------------------------------------------------------------------
// Rich details (/api/preview/:id)
//
// The API rebuilds this payload from the MyAnimeList mirror rather than from the
// upstream page, because the upstream detail page is dead. Every block is
// optional: a title with no recommendations, themes or trailer is normal, and a
// missing block must not blank the whole page.
// ---------------------------------------------------------------------------

export interface PreviewImage {
        small: string | null;
        medium: string | null;
        large: string | null;
}

/** A company entry. `id` links to the producer page upstream. */
export interface PreviewCompany {
        id: number;
        name: string;
        url: string | null;
}

export interface PreviewTrailer {
        youtubeId: string | null;
        url: string | null;
        embedUrl: string | null;
}

export interface PreviewRelation {
        relation: string | null;
        malId: number | null;
        type: string | null;
        title: string | null;
}

export interface PreviewLink {
        name: string | null;
        url: string | null;
}

export interface PreviewDetail {
        id: number | null;
        url: string | null;
        title: string | null;
        titleEnglish: string | null;
        titleJapanese: string | null;
        image: string | null;
        images: PreviewImage | null;
        synopsis: string | null;
        type: string | null;
        episodes: number | null;
        status: string | null;
        score: number | null;
        scoredBy: number | null;
        members: number | null;
        favorites: number | null;
        /** View count for sources that publish one instead of a member list. */
        views?: number | null;
        rank: number | null;
        popularity: number | null;
        duration: string | null;
        rating: string | null;
        source: string | null;
        season: string | null;
        year: number | null;
        aired: { from: string | null; to: string | null; string: string | null };
        broadcast: { day: string | null; time: string | null; timezone: string | null; string: string | null };
        trailer: PreviewTrailer;
        genres: string[];
        themes: string[];
        demographics: string[];
        studios: PreviewCompany[];
        producers: PreviewCompany[];
        licensors: PreviewCompany[];
        relations: PreviewRelation[];
        streaming: PreviewLink[];
        externalLinks: PreviewLink[];
}

export interface PreviewVoiceActor {
        id: number | null;
        name: string | null;
        language: string | null;
        image: string | null;
}

export interface PreviewCharacter {
        id: number | null;
        name: string | null;
        image: string | null;
        role: string | null;
        favorites: number | null;
        voiceActors: PreviewVoiceActor[];
}

export interface PreviewStaffMember {
        id: number | null;
        name: string | null;
        image: string | null;
        role: string | null;
}

export interface PreviewRecommendation {
        id: number | null;
        title: string | null;
        image: string | null;
        votes: number | null;
}

export interface PreviewTheme {
        kind: string | null;
        title: string | null;
        artist: string | null;
        episodes: string | null;
}

export interface AnimePreview {
        source: string;
        malId: number | null;
        detail: PreviewDetail;
        characters: PreviewCharacter[];
        staff: PreviewStaffMember[];
        recommendations: PreviewRecommendation[];
        themes: PreviewTheme[];
}

function asStringList(value: unknown): string[] {
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asCompanies(value: unknown): PreviewCompany[] {
        if (!Array.isArray(value)) return [];
        return value
                .map((row) => {
                        const record = (row ?? {}) as Record<string, unknown>;
                        return {
                                id: asNumber(record.id),
                                name: asString(record.name),
                                url: asString(record.url) || null,
                        };
                })
                .filter((company) => company.name);
}

function asNullableString(value: unknown): string | null {
        const text = asString(value);
        return text || null;
}

function asNullableNumber(value: unknown): number | null {
        if (value === null || value === undefined || value === '') return null;
        const parsed = asNumber(value);
        return Number.isFinite(parsed) ? parsed : null;
}

function normalizePreviewDetail(raw: unknown): PreviewDetail {
        const record = (raw ?? {}) as Record<string, unknown>;
        const images = (record.images ?? null) as Record<string, unknown> | null;
        const trailer = (record.trailer ?? {}) as Record<string, unknown>;
        const aired = (record.aired ?? {}) as Record<string, unknown>;
        const broadcast = (record.broadcast ?? {}) as Record<string, unknown>;
        const links = (value: unknown): PreviewLink[] =>
                Array.isArray(value)
                        ? value.map((row) => {
                                  const link = (row ?? {}) as Record<string, unknown>;
                                  return { name: asNullableString(link.name), url: asNullableString(link.url) };
                          })
                        : [];
        return {
                id: asNullableNumber(record.id),
                url: asNullableString(record.url),
                title: asNullableString(record.title),
                titleEnglish: asNullableString(record.titleEnglish),
                titleJapanese: asNullableString(record.titleJapanese),
                image: asNullableString(record.image),
                images: images
                        ? {
                                  small: asNullableString(images.small),
                                  medium: asNullableString(images.medium),
                                  large: asNullableString(images.large),
                          }
                        : null,
                synopsis: asNullableString(record.synopsis),
                type: asNullableString(record.type),
                episodes: asNullableNumber(record.episodes),
                status: asNullableString(record.status),
                score: asNullableNumber(record.score),
                scoredBy: asNullableNumber(record.scoredBy),
                members: asNullableNumber(record.members),
                favorites: asNullableNumber(record.favorites),
                views: asNullableCount(record.views),
                rank: asNullableNumber(record.rank),
                popularity: asNullableNumber(record.popularity),
                duration: asNullableString(record.duration),
                rating: asNullableString(record.rating),
                source: asNullableString(record.source),
                season: asNullableString(record.season),
                year: asNullableNumber(record.year),
                aired: {
                        from: asNullableString(aired.from),
                        to: asNullableString(aired.to),
                        string: asNullableString(aired.string),
                },
                broadcast: {
                        day: asNullableString(broadcast.day),
                        time: asNullableString(broadcast.time),
                        timezone: asNullableString(broadcast.timezone),
                        string: asNullableString(broadcast.string),
                },
                trailer: {
                        youtubeId: asNullableString(trailer.youtubeId),
                        url: asNullableString(trailer.url),
                        embedUrl: asNullableString(trailer.embedUrl),
                },
                genres: asStringList(record.genres),
                themes: asStringList(record.themes),
                demographics: asStringList(record.demographics),
                studios: asCompanies(record.studios),
                producers: asCompanies(record.producers),
                licensors: asCompanies(record.licensors),
                relations: Array.isArray(record.relations)
                        ? record.relations.map((row) => {
                                  const relation = (row ?? {}) as Record<string, unknown>;
                                  return {
                                          relation: asNullableString(relation.relation),
                                          malId: asNullableNumber(relation.malId),
                                          type: asNullableString(relation.type),
                                          title: asNullableString(relation.title),
                                  };
                          })
                        : [],
                streaming: links(record.streaming),
                externalLinks: links(record.externalLinks),
        };
}

/**
 * Load the full details payload for a series.
 *
 * Returns null when the API has no record for the title (a valid answer for a
 * series that is not on the mirror) so the caller can show a "no details" state
 * rather than an error.
 */
export async function loadPreview(base: string, seriesId: string): Promise<AnimePreview | null> {
        const payload = (await getJson(
                base,
                `/api/preview/${encodeURIComponent(seriesId)}`,
        )) as { results?: { detail?: unknown } | null };
        const results = payload?.results ?? null;
        if (!results || !results.detail) return null;

        const record = results as Record<string, unknown>;
        const preview: AnimePreview = {
                source: asString(record.source) || 'jikan',
                malId: asNullableNumber(record.malId),
                detail: normalizePreviewDetail(record.detail),
                characters: Array.isArray(record.characters)
                        ? record.characters.map((row) => {
                                  const character = (row ?? {}) as Record<string, unknown>;
                                  return {
                                          id: asNullableNumber(character.id),
                                          name: asNullableString(character.name),
                                          image: asNullableString(character.image),
                                          role: asNullableString(character.role),
                                          favorites: asNullableNumber(character.favorites),
                                          voiceActors: Array.isArray(character.voiceActors)
                                                  ? character.voiceActors.map((actor) => {
                                                            const voice = (actor ?? {}) as Record<string, unknown>;
                                                            return {
                                                                    id: asNullableNumber(voice.id),
                                                                    name: asNullableString(voice.name),
                                                                    language: asNullableString(voice.language),
                                                                    image: asNullableString(voice.image),
                                                            };
                                                    })
                                                  : [],
                                  };
                          })
                        : [],
                staff: Array.isArray(record.staff)
                        ? record.staff.map((row) => {
                                  const member = (row ?? {}) as Record<string, unknown>;
                                  return {
                                          id: asNullableNumber(member.id),
                                          name: asNullableString(member.name),
                                          image: asNullableString(member.image),
                                          role: asNullableString(member.role),
                                  };
                          })
                        : [],
                recommendations: Array.isArray(record.recommendations)
                        ? record.recommendations.map((row) => {
                                  const rec = (row ?? {}) as Record<string, unknown>;
                                  return {
                                          id: asNullableNumber(rec.id),
                                          title: asNullableString(rec.title),
                                          image: asNullableString(rec.image),
                                          votes: asNullableNumber(rec.votes),
                                  };
                          })
                        : [],
                themes: Array.isArray(record.themes)
                        ? record.themes.map((row) => {
                                  const theme = (row ?? {}) as Record<string, unknown>;
                                  return {
                                          kind: asNullableString(theme.kind),
                                          title: asNullableString(theme.title),
                                          artist: asNullableString(theme.artist),
                                          episodes: asNullableString(theme.episodes),
                                  };
                          })
                        : [],
        };
        // Feed the persistent store here, so a details page browsed once
        // renders offline forever after. The sink is fire-and-forget: a slow
        // or failing store must never delay the answer just fetched. The key is
        // the display title rather than the route id, because that is what the
        // library and the details page look up (provider ids are slugs, and the
        // catalogue's own ids are numeric).
        metadataSink?.(preview.detail.title?.trim() || seriesId, preview);
        return preview;
}

// ---------------------------------------------------------------------------
// Full series details across sources
//
// The `/api/preview/:id` route is a MyAnimeList mirror. The 18+ source has no
// such record, so its details come from `/api/providers/hentaimama/anime` and
// are mapped into the same shape. That keeps one details page for every source
// instead of a second renderer.
// ---------------------------------------------------------------------------

/**
 * True for the 18+ provider's generated blurb.
 *
 * Every series gets the same sentence — "Watch <title> hentai online free in HD
 * with English subtitles. N episodes, Ongoing. Genres: …" — so it is noise on a
 * details page, not a synopsis. It is also frequently stale (the episode count
 * in it disagrees with the source's own episode list), which is exactly what a
 * details page must not do.
 */
export function isProviderTemplate(text: string | null | undefined): boolean {
        return (
                typeof text === 'string' &&
                /^\s*Watch\s+.+?\s+hentai\s+online\s+free\s+in\s+HD\s+with\s+English\s+subtitles\./i.test(text)
        );
}

/** The text shown as a synopsis, or null when there is nothing worth showing. */
export function readableSynopsis(text: string | null | undefined): string | null {
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (!trimmed || isProviderTemplate(trimmed)) return null;
        return trimmed;
}

/**
 * Recover the airing status the 18+ provider buries in its generated blurb.
 * The provider's structured `status` field is always null, so this is the only
 * signal it publishes; the blurb itself is then discarded.
 */
export function providerStatus(text: string | null | undefined): string | null {
        if (!isProviderTemplate(text)) return null;
        const match = (text as string).match(/English subtitles\.\s*\d+\s+episodes?,\s*([^.]+)\./i);
        const status = match?.[1]?.trim();
        return status || null;
}

/** Parse a score string, or null when it is absent or not a number. */
function scoreValue(value: string | null | undefined): number | null {
        if (!value) return null;
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build the `AnimePreview` shape from source-level details.
 *
 * Used for the 18+ source, whose detail route has structured fields but no MAL
 * record, and as the fallback when the preview route answers nothing for a
 * native title. Every optional block is empty rather than invented.
 */
export function previewFromInfo(info: AnimeInfo): AnimePreview {
        const malId = Number.parseInt(info.dataId ?? '', 10);
        return {
                source: info.provider ?? 'native',
                malId: Number.isFinite(malId) ? malId : null,
                detail: {
                        id: Number.isFinite(malId) ? malId : null,
                        url: null,
                        title: info.title,
                        titleEnglish: null,
                        titleJapanese: info.japaneseTitle,
                        image: info.poster,
                        images: null,
                        synopsis: readableSynopsis(info.overview),
                        type: info.showType || null,
                        episodes: info.episodeCount ?? null,
                        status: info.status,
                        score: scoreValue(info.score),
                        scoredBy: null,
                        members: null,
                        favorites: null,
                        views: info.views ?? null,
                        rank: null,
                        popularity: null,
                        duration: info.duration,
                        rating: info.rating ?? null,
                        source: null,
                        season: null,
                        year: info.year ?? null,
                        aired: { from: null, to: null, string: info.aired ?? null },
                        broadcast: { day: null, time: null, timezone: null, string: null },
                        trailer: { youtubeId: null, url: null, embedUrl: null },
                        genres: info.genres,
                        themes: [],
                        demographics: [],
                        studios: info.studios.map((name) => ({ id: 0, name, url: null })),
                        producers: [],
                        licensors: [],
                        relations: [],
                        streaming: [],
                        externalLinks: [],
                },
                characters: [],
                staff: [],
                recommendations: [],
                themes: [],
        };
}

/** Build source-level details from a preview, for when the info route failed. */
export function infoFromPreview(preview: AnimePreview, id: string): AnimeInfo {
        const detail = preview.detail;
        return {
                adultContent: preview.source === ADULT_PROVIDER,
                id,
                dataId: detail.id !== null ? String(detail.id) : null,
                title: detail.title,
                japaneseTitle: detail.titleJapanese,
                poster: detail.image,
                showType: detail.type ?? 'Unknown',
                duration: detail.duration,
                status: detail.status,
                score: detail.score !== null ? detail.score.toFixed(2) : null,
                views: detail.views ?? null,
                aired: detail.aired.string,
                genres: detail.genres,
                studios: detail.studios.map((studio) => studio.name),
                overview: detail.synopsis,
                metadata: {},
                seasons: [],
                recommended: [],
                related: {},
                popular: [],
                provider: preview.source === ADULT_PROVIDER ? ADULT_PROVIDER : undefined,
                episodeCount: detail.episodes,
                year: detail.year,
                rating: detail.rating,
        };
}

/** Normalize a title for the fallback match against a search result. */
function normalizedTitle(text: string): string {
        return (text ?? '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, ' ')
                .trim();
}

/** Find an exact title in the aggregate search, preferring the 18+ source. */
async function findSeriesByTitle(
        base: string,
        title: string,
        provider?: string,
): Promise<SeriesSummary | null> {
        const wanted = normalizedTitle(title);
        if (!wanted) return null;
        try {
                const found = await searchSeries(base, title, { includeAdult: true });
                const pool = provider ? found.series.filter((entry) => entry.provider === provider) : found.series;
                const exact = pool.find((entry) => normalizedTitle(entry.title) === wanted);
                if (exact) return exact;
                // A library title can carry a suffix the provider drops (or vice
                // versa). A starts-with match is still specific enough to be safe,
                // and only the 18+ source is matched this loosely.
                if (provider === ADULT_PROVIDER) {
                        return pool.find((entry) => normalizedTitle(entry.title).startsWith(wanted)) ?? null;
                }
                return null;
        } catch {
                return null;
        }
}

export interface LoadSeriesDetailsOptions {
        /** Force a source, e.g. when the series was opened from the finder. */
        provider?: string;
        /**
         * Fetch the episode list too. The downloader's details page uses it to
         * show real episode art; the library's details page does not need it.
         */
        episodes?: boolean;
}

/** Everything a details page renders, from whichever source answered. */
export interface SeriesDetails {
        preview: AnimePreview;
        info: AnimeInfo;
        /** The episode list when it was requested and could be fetched. */
        episodes: EpisodeSummary[] | null;
        /**
         * True when `info` was rebuilt from the preview because the catalogue's
         * own detail route failed. A caller that needs a real catalogue id (the
         * downloader) must search by title instead of trusting `info.id`.
         */
        synthesized: boolean;
}

/** The 18+ source's details, with its episode list when requested. */
async function loadAdultDetails(base: string, series: string, withEpisodes: boolean): Promise<SeriesDetails> {
        let info = await loadAnimeInfo(base, series, ADULT_PROVIDER).catch(() => null);
        if (!info) {
                const match = await findSeriesByTitle(base, series, ADULT_PROVIDER);
                if (match) info = await loadAnimeInfo(base, match.id, ADULT_PROVIDER).catch(() => null);
        }
        if (!info) throw new AnimeApiError('The anime API returned no details for this series.');

        // The provider record carries the real synopsis now, so the page is only
        // read when this answer has none — an older cached payload, or a source
        // that stops publishing it. Reading a page costs a round trip and can hit
        // a challenge page, so it is not spent when the text is already here.
        const needsPageSynopsis = !info.overview;
        const [episodes, pageSynopsis] = await Promise.all([
                withEpisodes
                        ? loadEpisodes(base, info.id, ADULT_PROVIDER)
                                        .then((list) => list.episodes)
                                        .catch(() => null)
                        : Promise.resolve(null),
                needsPageSynopsis
                        ? loadProviderSynopsis(
                                  typeof info.metadata.pageUrl === 'string' ? info.metadata.pageUrl : null,
                                  (message, details) => debugHook?.(message, details),
                          )
                        : Promise.resolve(null),
        ]);
        // The provider's own episode count can lag its list (it reported 3 for a
        // four-episode series); the list is authoritative when it is present.
        if (episodes && episodes.length > 0) info = { ...info, episodeCount: episodes.length };
        if (pageSynopsis) info = { ...info, overview: pageSynopsis };

        const preview = previewFromInfo(info);
        metadataSink?.(preview.detail.title?.trim() || series, preview);
        return { preview, info, episodes, synthesized: false };
}

/** The native route, falling back to whichever half answered. */
async function loadNativeDetails(base: string, series: string, withEpisodes: boolean): Promise<SeriesDetails> {
        // `hm:` ids are the 18+ source's own catalogue. The preview route is a
        // MAL mirror and resolves those slugs to an unrelated title, so the info
        // route alone supplies the page.
        const adultReference = isAdultReference(series);
        const [previewOutcome, infoOutcome] = await Promise.allSettled([
                adultReference ? Promise.resolve(null) : loadPreview(base, series),
                loadAnimeInfo(base, series),
        ]);
        let preview = previewOutcome.status === 'fulfilled' ? previewOutcome.value : null;
        let info = infoOutcome.status === 'fulfilled' ? infoOutcome.value : null;
        const infoFromApi = info !== null;
        const previewFromApi = preview !== null;

        // The preview is the MAL mirror and sometimes needs a title rather than
        // the catalogue's numeric id. Retry by title before synthesizing.
        if (!preview && !adultReference && info?.title && info.title !== series) {
                preview = await loadPreview(base, info.title).catch(() => null);
        }
        if (!preview && info) preview = previewFromInfo(info);
        if (!info && preview) info = infoFromPreview(preview, series);
        if (!preview || !info) {
                // A title from the library can belong to another provider. One
                // search is enough to find it; a miss is reported as no details.
                const match = await findSeriesByTitle(base, series);
                if (match && (match.provider === ADULT_PROVIDER || match.id !== series)) {
                        return loadSeriesDetails(base, match.id, { provider: match.provider, episodes: withEpisodes });
                }
                throw new AnimeApiError('The anime API returned no details for this series.');
        }

        const episodes = withEpisodes
                ? await loadEpisodes(base, info.id || series, info.provider)
                                .then((list) => list.episodes)
                                .catch(() => null)
                : null;
        if (episodes && episodes.length > 0) {
                info = { ...info, episodeCount: episodes.length };
                preview = { ...preview, detail: { ...preview.detail, episodes: episodes.length } };
        } else if (info.episodeCount && preview.detail.episodes === null) {
                preview = { ...preview, detail: { ...preview.detail, episodes: info.episodeCount } };
        }
        if (!previewFromApi) metadataSink?.(preview.detail.title?.trim() || series, preview);
        return { preview, info, episodes, synthesized: !infoFromApi };
}

/**
 * Load everything a full details page needs, across both sources.
 *
 * One call for the page: the native route, or the 18+ provider mapped into the
 * same shape, and a fallback that resolves a library title the catalogue lists
 * under another provider. The two halves are fetched together, so a page still
 * renders when only one of the preview/info routes answers.
 */
export async function loadSeriesDetails(
        base: string,
        series: string,
        options: LoadSeriesDetailsOptions = {},
): Promise<SeriesDetails> {
        if (options.provider === ADULT_PROVIDER) {
                return loadAdultDetails(base, series, options.episodes === true);
        }
        return loadNativeDetails(base, series, options.episodes === true);
}

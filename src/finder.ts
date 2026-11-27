import type { BrowsePage, GenreRef, SeriesSummary } from './animeApi';

/**
 * The finder's pure model: what a listing row becomes on screen, and what the
 * pager may honestly say about it.
 *
 * It lives outside the modal because both answers depend on quirks of the API
 * that are worth testing without a DOM: the native routes invent a page count,
 * and the 18+ "new episodes" feed is a list of episodes rather than of series,
 * so one title can arrive several times.
 */

/** A poster card: one series, plus the newest episode a feed listed for it. */
export interface FinderCard {
        series: SeriesSummary;
        /** Newest episode number the listing showed, or null for a series list. */
        episodeNumber: number | null;
        /** How many feed rows were folded into this card. */
        episodes: number;
}

/**
 * The episode number a row points at.
 *
 * The 18+ feed usually publishes `episodeNumber`; older cached rows only carry
 * the human label (`japanese_title: "Episode 4"`) or the episode slug
 * (`…-episode-4`), so both are read as fallbacks.
 */
export function episodeNumberOf(series: SeriesSummary): number | null {
        if (typeof series.episodeNumber === 'number' && series.episodeNumber > 0) {
                return series.episodeNumber;
        }
        const label = series.japaneseTitle ?? '';
        const labelled = /episode\s*(\d+)/i.exec(label);
        if (labelled) return Number.parseInt(labelled[1] ?? '', 10);
        const trailing = /-episode-(\d+)$/i.exec(series.id ?? '');
        return trailing ? Number.parseInt(trailing[1] ?? '', 10) : null;
}

/**
 * Fold listing rows into cards.
 *
 * Rows sharing an id are one title: the 18+ episode feed lists every episode it
 * has just added, so a single series can occupy most of a page. The first row
 * wins (the feed is newest first) and the highest episode number found is kept,
 * because a cached feed can arrive in another order.
 */
export function buildCards(series: SeriesSummary[]): FinderCard[] {
        const cards: FinderCard[] = [];
        const byKey = new Map<string, FinderCard>();
        for (const row of series) {
                const key = (row.id || row.title || '').trim().toLowerCase();
                if (!key) continue;
                const episodeNumber = episodeNumberOf(row);
                const existing = byKey.get(key);
                if (!existing) {
                        const card: FinderCard = { series: row, episodeNumber, episodes: 1 };
                        byKey.set(key, card);
                        cards.push(card);
                        continue;
                }
                existing.episodes += 1;
                if (
                        episodeNumber !== null &&
                        (existing.episodeNumber === null || episodeNumber > existing.episodeNumber)
                ) {
                        existing.episodeNumber = episodeNumber;
                }
        }
        return cards;
}

/** What the pager can say and offer for the page on screen. */
export interface PagerModel {
        page: number;
        /** Exact page count, or null when the source does not report one. */
        totalPages: number | null;
        hasPrevious: boolean;
        hasNext: boolean;
        /** False when there is nowhere to go, so the pager is not drawn at all. */
        visible: boolean;
}

/**
 * Build the pager from a page answer.
 *
 * `totalPages` is null whenever the source's count is not trustworthy. The
 * native routes report `currentPage + 1` on every page and `hasNextPage: true`
 * even hundreds of pages in, so showing that number (or stopping at it) is a
 * lie; there, only `hasNextPage` — really "this page had rows" — decides.
 */
export function pagerFor(
        page: number,
        totalPages: number | null,
        hasNextPage: boolean,
): PagerModel {
        const current = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
        const total =
                totalPages !== null && Number.isFinite(totalPages) && totalPages > 0
                        ? Math.max(1, Math.floor(totalPages))
                        : null;
        return {
                page: current,
                totalPages: total,
                hasPrevious: current > 1,
                hasNext: total !== null ? current < total : hasNextPage,
                visible: current > 1 || hasNextPage || (total !== null && total > 1),
        };
}

/** "Page 3" when the end is unknown, "Page 3 of 12" when it is not. */
export function pagerLabel(pager: PagerModel): string {
        return pager.totalPages !== null
                ? `Page ${pager.page} of ${pager.totalPages}`
                : `Page ${pager.page}`;
}

/** A pager for a browse answer. */
export function pagerForBrowse(answer: BrowsePage): PagerModel {
        return pagerFor(answer.page, answer.totalPages, answer.hasNextPage);
}

/** Narrow a genre list by name; an empty query keeps everything. */
export function filterGenres(genres: GenreRef[], query: string): GenreRef[] {
        const needle = query.trim().toLowerCase();
        if (!needle) return genres;
        return genres.filter((genre) => genre.name.toLowerCase().includes(needle));
}

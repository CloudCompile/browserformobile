import { describe, expect, it } from 'vitest';

import type { GenreRef, SeriesSummary } from '../src/animeApi';
import {
        buildCards,
        episodeNumberOf,
        filterGenres,
        pagerFor,
        pagerForBrowse,
        pagerLabel,
} from '../src/finder';

function row(overrides: Partial<SeriesSummary> = {}): SeriesSummary {
        return {
                id: 'series',
                title: 'Series',
                japaneseTitle: null,
                poster: null,
                showType: 'TV',
                sub: 0,
                dub: 0,
                eps: 12,
                ...overrides,
        };
}

describe('episodeNumberOf', () => {
        it('prefers the explicit episode number', () => {
                expect(episodeNumberOf(row({ episodeNumber: 7 }))).toBe(7);
        });

        it('falls back to the episode label cached rows carry', () => {
                expect(episodeNumberOf(row({ japaneseTitle: 'Episode 4' }))).toBe(4);
        });

        it('falls back to the episode slug', () => {
                expect(episodeNumberOf(row({ id: 'hm:so_low', japaneseTitle: null }))).toBeNull();
                expect(episodeNumberOf(row({ id: 'so_low-episode-9' }))).toBe(9);
        });

        it('is null for a series row', () => {
                expect(episodeNumberOf(row())).toBeNull();
        });
});

describe('buildCards', () => {
        it('folds an episode feed into one card per series, newest episode kept', () => {
                const cards = buildCards([
                        row({ id: 'hm:yoasobi', title: 'Yoasobi Gurashi!', episodeNumber: 8, rating: 8.9 }),
                        row({ id: 'hm:yoasobi', title: 'Yoasobi Gurashi!', episodeNumber: 7, rating: 7.9 }),
                        row({ id: 'hm:yoasobi', title: 'Yoasobi Gurashi!', episodeNumber: 6, rating: 8.3 }),
                        row({ id: 'hm:other', title: 'Other', episodeNumber: 2 }),
                ]);

                expect(cards).toHaveLength(2);
                expect(cards[0]).toMatchObject({
                        episodeNumber: 8,
                        episodes: 3,
                });
                // The first row wins, so the newest poster and score stay.
                expect(cards[0].series.rating).toBe(8.9);
                expect(cards[1]).toMatchObject({ episodeNumber: 2, episodes: 1 });
        });

        it('keeps the highest episode when a cached feed arrives out of order', () => {
                const cards = buildCards([
                        row({ id: 'hm:show', episodeNumber: 3 }),
                        row({ id: 'hm:show', episodeNumber: 9 }),
                ]);
                expect(cards[0].episodeNumber).toBe(9);
                expect(cards[0].episodes).toBe(2);
        });

        it('leaves a series listing untouched', () => {
                const cards = buildCards([row({ id: 'a', eps: 12 }), row({ id: 'b', eps: 24 })]);
                expect(cards).toHaveLength(2);
                expect(cards.every((card) => card.episodeNumber === null && card.episodes === 1)).toBe(true);
        });

        it('skips a row with no id or title', () => {
                expect(buildCards([row({ id: '', title: '' })])).toEqual([]);
        });
});

describe('pagerFor', () => {
        it('cannot show a count the source does not report', () => {
                const pager = pagerFor(3, null, true);
                expect(pager.totalPages).toBeNull();
                expect(pager.hasNext).toBe(true);
                expect(pager.hasPrevious).toBe(true);
                expect(pager.visible).toBe(true);
                expect(pagerLabel(pager)).toBe('Page 3');
        });

        it('stops at a count the source really reports', () => {
                const pager = pagerFor(3, 3, true);
                expect(pager.hasNext).toBe(false);
                expect(pagerLabel(pager)).toBe('Page 3 of 3');
        });

        it('hides on a single page with nowhere to go', () => {
                const pager = pagerFor(1, null, false);
                expect(pager.visible).toBe(false);
                expect(pager.hasNext).toBe(false);
                expect(pager.hasPrevious).toBe(false);
        });

        it('stays visible on the last page of a long list, for Prev', () => {
                const pager = pagerFor(4, 4, false);
                expect(pager.visible).toBe(true);
                expect(pager.hasNext).toBe(false);
                expect(pager.hasPrevious).toBe(true);
        });

        it('treats a missing next flag as the end when the count is unknown', () => {
                expect(pagerFor(2, null, false).hasNext).toBe(false);
        });
});

describe('pagerForBrowse', () => {
        it('uses the browse answer as given', () => {
                const pager = pagerForBrowse({
                        series: [],
                        totalPages: null,
                        page: 2,
                        hasNextPage: true,
                });
                expect(pager.page).toBe(2);
                expect(pager.hasNext).toBe(true);
                expect(pager.totalPages).toBeNull();
        });
});

describe('filterGenres', () => {
        const genres: GenreRef[] = [
                { slug: 'sci-fi', name: 'Sci-Fi' },
                { slug: 'slice-of-life', name: 'Slice of Life' },
                { slug: 'action', name: 'Action' },
        ];

        it('matches names case-insensitively', () => {
                expect(filterGenres(genres, 'SLICE').map((genre) => genre.slug)).toEqual(['slice-of-life']);
                expect(filterGenres(genres, 'fi').map((genre) => genre.slug)).toEqual(['sci-fi']);
        });

        it('returns every genre for an empty or whitespace query', () => {
                expect(filterGenres(genres, '')).toBe(genres);
                expect(filterGenres(genres, '   ')).toBe(genres);
        });

        it('returns nothing when no name matches', () => {
                expect(filterGenres(genres, 'mecha')).toEqual([]);
        });
});

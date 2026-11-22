import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A URL-addressed fake for Obsidian's native request client. Each test stages
 * the answers it wants; anything else is a 404, which is what the API turns
 * into a null/failed route.
 */
const { routes } = vi.hoisted(() => ({ routes: new Map<string, unknown>() }));

vi.mock('obsidian', () => ({
        requestUrl: async ({ url }: { url: string }) => {
                if (!routes.has(url)) return { status: 404, json: {} };
                return { status: 200, json: routes.get(url) };
        },
}));

import { loadSeriesDetails } from '../src/animeApi';

const BASE = 'https://api.test';

function stage(path: string, body: unknown): void {
        routes.set(`${BASE}${path}`, body);
}

function adultDetail(overrides: Record<string, unknown> = {}): unknown {
        return {
                success: true,
                results: {
                        provider: 'hentaimama',
                        action: 'anime',
                        data: {
                                id: '12402',
                                slug: 'so_low',
                                title: 'So_low',
                                japaneseTitle: null,
                                poster: 'https://img/so_low.webp',
                                description:
                                        'Watch So_low hentai online free in HD with English subtitles. 3 episodes, Ongoing. Genres: Anal…',
                                type: 'TV',
                                year: 2023,
                                episodes: 3,
                                rating: null,
                                genres: ['Uncensored', '3D'],
                                studios: [],
                                status: null,
                                ...overrides,
                        },
                        total: 1,
                },
        };
}

function adultEpisodes(): unknown {
        return {
                success: true,
                results: {
                        provider: 'hentaimama',
                        action: 'episodes',
                        data: [1, 2, 3, 4].map((number) => ({
                                id: `so_low-episode-${number}`,
                                slug: `so_low-episode-${number}`,
                                number,
                                title: `Episode ${number}`,
                                poster: `https://img/ep${number}.webp`,
                        })),
                        total: 4,
                },
        };
}

function nativePreview(): unknown {
        return {
                success: true,
                results: {
                        source: 'jikan',
                        malId: 21,
                        detail: {
                                id: 21,
                                title: 'One Piece',
                                image: 'https://img/op.jpg',
                                synopsis: 'A real synopsis.',
                                type: 'TV',
                                episodes: 1000,
                                status: 'Currently Airing',
                                score: 8.7,
                                genres: ['Action'],
                                studios: [{ id: 1, name: 'Toei', url: null }],
                        },
                        characters: [],
                        staff: [],
                        recommendations: [],
                        themes: [],
                },
        };
}

function nativeInfo(): unknown {
        return {
                success: true,
                results: {
                        data: {
                                id: 'one-piece',
                                animeInfo: {
                                        Overview: 'Info synopsis.',
                                        Genre: ['Action', 'Adventure'],
                                        Studios: 'Toei Animation',
                                },
                                tvInfo: { showType: 'TV', duration: '24 min' },
                        },
                        seasons: [],
                },
        };
}

beforeEach(() => {
        routes.clear();
});

describe('loadSeriesDetails', () => {
        it('maps the 18+ source, drops its generated blurb, and uses the real episode list', async () => {
                stage('/api/providers/hentaimama/anime?id=so_low', adultDetail());
                stage('/api/providers/hentaimama/episodes?id=so_low', adultEpisodes());

                const details = await loadSeriesDetails(BASE, 'so_low', {
                        provider: 'hentaimama',
                        episodes: true,
                });

                expect(details.info.adultContent).toBe(true);
                expect(details.info.status).toBe('Ongoing');
                expect(details.info.year).toBe(2023);
                expect(details.info.episodeCount).toBe(4);
                expect(details.preview.detail.synopsis).toBeNull();
                expect(details.preview.detail.title).toBe('So_low');
                expect(details.preview.detail.image).toBe('https://img/so_low.webp');
                expect(details.preview.detail.episodes).toBe(4);
                expect(details.episodes).toHaveLength(4);
                expect(details.episodes?.[0]?.poster).toBe('https://img/ep1.webp');
                expect(details.synthesized).toBe(false);
        });

        it('resolves an 18+ title from a stale id through the search route', async () => {
                stage(
                        '/api/search?keyword=So_low&page=1&includeAdult=1',
                        {
                                success: true,
                                results: {
                                        data: [],
                                        sources: [
                                                {
                                                        provider: 'hentaimama',
                                                        ok: true,
                                                        results: [
                                                                { slug: 'so_low', title: 'So_low', type: 'TV', episodes: 4 },
                                                        ],
                                                },
                                        ],
                                },
                        },
                );
                stage('/api/providers/hentaimama/anime?id=so_low', adultDetail());

                const details = await loadSeriesDetails(BASE, 'So_low', { provider: 'hentaimama' });
                expect(details.info.id).toBe('so_low');
                expect(details.preview.detail.title).toBe('So_low');
        });

        it('uses the native info route for an hm: series, not the MAL preview', async () => {
                // The preview route would resolve `so_low` to an unrelated MAL title;
                // an hm: series must never take that answer.
                stage('/api/preview/hm%3Aso_low', nativePreview());
                stage('/api/info?id=hm%3Aso_low', {
                        success: true,
                        results: {
                                data: {
                                        id: 'hm:so_low',
                                        data_id: '81435',
                                        title: 'So_low',
                                        japanese_title: 'So_low',
                                        poster: 'https://img/so_low.webp',
                                        showType: 'TV',
                                        animeInfo: {
                                                Overview: '',
                                                Genre: ['Uncensored'],
                                                Studios: [],
                                                Status: 'Ongoing',
                                                Episodes: '4/4',
                                                adultContent: true,
                                                rating: 'Rx - Hentai',
                                                tvInfo: { showType: 'TV', eps: 4 },
                                        },
                                },
                                seasons: [],
                        },
                });
                stage('/api/episodes/hm%3Aso_low', {
                        success: true,
                        results: {
                                totalEpisodes: 1,
                                episodes: [
                                        {
                                                key: 'hm:so_low:1',
                                                id: 'hm:so_low:1',
                                                number: 1,
                                                title: 'Episode 1',
                                                subbed: true,
                                                dubbed: false,
                                                filler: false,
                                        },
                                ],
                        },
                });

                const details = await loadSeriesDetails(BASE, 'hm:so_low', { episodes: true });
                expect(details.info.adultContent).toBe(true);
                expect(details.preview.detail.title).toBe('So_low');
                expect(details.preview.detail.image).toBe('https://img/so_low.webp');
                expect(details.episodes?.[0]?.id).toBe('hm:so_low:1');
                expect(details.synthesized).toBe(false);
        });

        it('merges the native preview and info routes', async () => {
                stage('/api/preview/one-piece', nativePreview());
                stage('/api/info?id=one-piece', nativeInfo());

                const details = await loadSeriesDetails(BASE, 'one-piece');
                expect(details.synthesized).toBe(false);
                expect(details.preview.detail.title).toBe('One Piece');
                expect(details.preview.detail.synopsis).toBe('A real synopsis.');
                expect(details.info.showType).toBe('TV');
                expect(details.info.genres).toEqual(['Action', 'Adventure']);
        });

        it('keeps a page when only the preview route answers', async () => {
                stage('/api/preview/one-piece', nativePreview());

                const details = await loadSeriesDetails(BASE, 'one-piece');
                expect(details.synthesized).toBe(true);
                expect(details.preview.detail.title).toBe('One Piece');
                expect(details.info.episodeCount).toBe(1000);
        });

        it('falls back to the 18+ source when neither native route knows a title', async () => {
                stage(
                        '/api/search?keyword=So_low&page=1&includeAdult=1',
                        {
                                success: true,
                                results: {
                                        data: [],
                                        sources: [
                                                {
                                                        provider: 'hentaimama',
                                                        ok: true,
                                                        results: [{ slug: 'so_low', title: 'So_low', type: 'TV' }],
                                                },
                                        ],
                                },
                        },
                );
                stage('/api/providers/hentaimama/anime?id=so_low', adultDetail());

                const details = await loadSeriesDetails(BASE, 'So_low');
                expect(details.info.provider).toBe('hentaimama');
                expect(details.preview.detail.title).toBe('So_low');
        });
});

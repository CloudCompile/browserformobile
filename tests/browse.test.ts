import { describe, it, expect, beforeEach, vi } from 'vitest';

import { browseSection, browseGenre, loadGenres, NATIVE_GENRES } from '../src/animeApi';
import { requestUrl } from 'obsidian';

vi.mock('obsidian', () => ({
        requestUrl: vi.fn(),
}));

const mockedRequestUrl = vi.mocked(requestUrl);

function respondWith(payload: unknown) {
        return (options: { url: string }) => {
                void options;
                return Promise.resolve({ status: 200, json: payload, text: JSON.stringify(payload) });
        };
}

beforeEach(() => {
        mockedRequestUrl.mockReset();
});

describe('browseSection', () => {
        it('reads the native section shape and asks the section route', async () => {
                mockedRequestUrl.mockImplementation(
                        respondWith({
                                results: {
                                        totalPages: 389,
                                        page: 2,
                                        data: [
                                                {
                                                        id: 'one-piece-81553',
                                                        title: 'One Piece',
                                                        japanese_title: 'One Piece',
                                                        poster: 'p.jpg',
                                                        tvInfo: { showType: 'TV', sub: '1180', dub: '1159' },
                                                },
                                        ],
                                },
                        }),
                );
                const page = await browseSection('https://api', 'most-popular', 2);
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe('https://api/api/most-popular?page=2');
                expect(page.totalPages).toBe(389);
                expect(page.page).toBe(2);
                expect(page.series[0]).toMatchObject({ id: 'one-piece-81553', title: 'One Piece', sub: 1180 });
        });

        it('reads the 18+ shape and asks the provider route when the source is hentaimama', async () => {
                mockedRequestUrl.mockImplementation(
                        respondWith({
                                results: {
                                        totalPages: 48,
                                        page: 1,
                                        data: [
                                                {
                                                        id: '81435',
                                                        slug: 'so_low',
                                                        episode: 'so_low-episode-4',
                                                        title: 'So_low – Episode 4',
                                                        poster: 'p.webp',
                                                        type: 'Episode',
                                                        episodes: null,
                                                },
                                        ],
                                },
                        }),
                );
                const page = await browseSection('https://api', 'monthly', 1, 'hentaimama');
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe(
                        'https://api/api/providers/hentaimama/browse?section=monthly&page=1',
                );
                expect(page.totalPages).toBe(48);
                expect(page.series[0]).toMatchObject({
                        id: 'so_low',
                        adultContent: true,
                        provider: 'hentaimama',
                });
        });
});

describe('browseGenre', () => {
        it('uses the native genre route without a source', async () => {
                mockedRequestUrl.mockImplementation(respondWith({ results: { totalPages: 1, data: [] } }));
                await browseGenre('https://api', 'action', 3);
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe('https://api/api/genre/action?page=3');
        });

        it('uses the provider browse route with the 18+ source', async () => {
                mockedRequestUrl.mockImplementation(respondWith({ results: { totalPages: 1, data: [] } }));
                await browseGenre('https://api', 'uncensored', 1, 'hentaimama');
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe(
                        'https://api/api/providers/hentaimama/browse?genre=uncensored&page=1',
                );
        });
});

describe('loadGenres', () => {
        it('returns the fixed native list without a request', async () => {
                const genres = await loadGenres('https://api');
                expect(mockedRequestUrl).not.toHaveBeenCalled();
                expect(genres).toEqual(NATIVE_GENRES);
        });

        it('scrapes the 18+ genre list from the provider route', async () => {
                mockedRequestUrl.mockImplementation(
                        respondWith({
                                results: {
                                        data: [
                                                { slug: 'uncensored', name: 'Uncensored' },
                                                { slug: '3d', name: '3D' },
                                        ],
                                },
                        }),
                );
                const genres = await loadGenres('https://api', 'hentaimama');
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe('https://api/api/providers/hentaimama/genres');
                expect(genres).toEqual([
                        { slug: 'uncensored', name: 'Uncensored' },
                        { slug: '3d', name: '3D' },
                ]);
        });
});

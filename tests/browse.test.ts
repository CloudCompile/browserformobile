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

        it('reads the 18+ browse feed with hm: references', async () => {
                mockedRequestUrl.mockImplementation(
                        respondWith({
                                results: {
                                        totalPages: 48,
                                        page: 1,
                                        data: [
                                                {
                                                        id: 'hm:so_low',
                                                        data_id: '81435',
                                                        title: 'So_low – Episode 4',
                                                        poster: 'p.webp',
                                                        showType: 'Episode',
                                                        eps: null,
                                                },
                                        ],
                                },
                        }),
                );
                const page = await browseSection('https://api', 'monthly', 1, 'hentaimama');
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe(
                        'https://api/api/adult/browse?section=monthly&page=1',
                );
                expect(page.totalPages).toBe(48);
                expect(page.series[0]).toMatchObject({
                        id: 'hm:so_low',
                        adultContent: true,
                        provider: undefined,
                });
        });
});

describe('browseGenre', () => {
        it('uses the filter route so every catalogue genre resolves', async () => {
                mockedRequestUrl.mockImplementation(respondWith({ results: { totalPages: 1, data: [] } }));
                await browseGenre('https://api', 'avant-garde', 3);
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe(
                        'https://api/api/filter?genre=avant-garde&page=3',
                );
        });

        it('uses the adult browse feed with the 18+ source', async () => {
                mockedRequestUrl.mockImplementation(respondWith({ results: { totalPages: 1, data: [] } }));
                await browseGenre('https://api', 'uncensored', 1, 'hentaimama');
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe(
                        'https://api/api/adult/browse?genre=uncensored&page=1',
                );
        });
});

describe('loadGenres', () => {
        it('reads the native genre index and turns names into route slugs', async () => {
                mockedRequestUrl.mockImplementation(
                        respondWith({
                                results: {
                                        genres: ['Slice of Life', 'Action', 'Sci-Fi', 'Boys Love', 'Hentai', 'Erotica'],
                                },
                        }),
                );
                const genres = await loadGenres('https://api');
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe('https://api/api');
                expect(genres).toEqual([
                        { slug: 'action', name: 'Action' },
                        { slug: 'boys-love', name: 'Boys Love' },
                        { slug: 'sci-fi', name: 'Sci-Fi' },
                        { slug: 'slice-of-life', name: 'Slice of Life' },
                ]);
        });

        it('falls back to the bundled list when the home payload has no genres', async () => {
                mockedRequestUrl.mockImplementation(respondWith({ results: {} }));
                const genres = await loadGenres('https://api');
                expect(genres).toEqual(NATIVE_GENRES);
        });

        it('falls back to the bundled list when the home request fails', async () => {
                mockedRequestUrl.mockRejectedValue(new Error('offline'));
                const genres = await loadGenres('https://api');
                expect(genres).toEqual(NATIVE_GENRES);
        });

        it('reads the 18+ source\u2019s own genre list', async () => {
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
                expect(mockedRequestUrl.mock.calls[0][0].url).toBe('https://api/api/adult/genres');
                expect(genres).toEqual([
                        { slug: 'uncensored', name: 'Uncensored' },
                        { slug: '3d', name: '3D' },
                ]);
        });
});

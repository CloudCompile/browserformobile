import { describe, it, expect, beforeEach, vi } from 'vitest';

import { AnimeCache, ttlForPath, isPersistable, pruneEntries, MAX_CACHE_ENTRIES } from '../src/animeCache';
import { setAnimeCache, searchSeries, loadAnimeInfo, loadEpisodes, loadStream } from '../src/animeApi';
import { requestUrl } from 'obsidian';

vi.mock('obsidian', () => ({
        requestUrl: vi.fn(),
}));

const mockedRequestUrl = vi.mocked(requestUrl);

/** A requestUrl stub that records calls and answers with a JSON payload. */
function respondWith(payload: unknown, status = 200) {
        return (options: { url: string }) => {
                void options;
                return Promise.resolve({ status, json: payload, text: JSON.stringify(payload) });
        };
}

beforeEach(() => {
        mockedRequestUrl.mockReset();
        setAnimeCache(null);
});

describe('ttlForPath', () => {
        it('gives metadata a long life and stream URLs a short one', () => {
                expect(ttlForPath('/api/info?id=x')).toBeGreaterThan(ttlForPath('/api/search?keyword=x'));
                expect(ttlForPath('/api/info?id=x')).toBeGreaterThan(ttlForPath('/api/stream?id=x'));
        });

        it('does not persist stream URLs', () => {
                // A stream link is likely dead by the next launch, and a stale link
                // fails late, mid-download, so it stays memory-only.
                expect(isPersistable('/api/stream?id=x')).toBe(false);
                expect(isPersistable('/api/info?id=x')).toBe(true);
                expect(isPersistable('/api/episodes/x')).toBe(true);
                expect(isPersistable('/api/search?keyword=x')).toBe(true);
        });
});

describe('AnimeCache', () => {
        it('serves a second read without calling the producer again', async () => {
                const cache = new AnimeCache();
                let calls = 0;
                const produce = async () => {
                        calls++;
                        return { v: 1 };
                };
                await cache.getOrFetch('k', '/api/info?id=1', produce);
                await cache.getOrFetch('k', '/api/info?id=1', produce);
                expect(calls).toBe(1);
        });

        it('coalesces concurrent requests for the same key', async () => {
                const cache = new AnimeCache();
                let calls = 0;
                const produce = async () => {
                        calls++;
                        await new Promise((resolve) => setTimeout(resolve, 10));
                        return { v: 1 };
                };
                const [a, b] = await Promise.all([
                        cache.getOrFetch('k', '/api/info?id=1', produce),
                        cache.getOrFetch('k', '/api/info?id=1', produce),
                ]);
                expect(calls).toBe(1);
                expect(a).toEqual(b);
        });

        it('retries after a failure instead of caching the rejection', async () => {
                const cache = new AnimeCache();
                let calls = 0;
                const failing = async () => {
                        calls++;
                        throw new Error('boom');
                };
                await expect(cache.getOrFetch('k', '/api/info?id=1', failing)).rejects.toThrow('boom');
                await expect(cache.getOrFetch('k', '/api/info?id=1', failing)).rejects.toThrow('boom');
                expect(calls).toBe(2);
        });

        it('expires an entry once its TTL lapses', async () => {
                const cache = new AnimeCache();
                let calls = 0;
                const produce = async () => {
                        calls++;
                        return calls;
                };
                await cache.getOrFetch('k', '/api/search?keyword=x', produce);
                const entry = cache.toJSON()['k'];
                expect(entry).toBeDefined();
                // Expire it by hand rather than waiting on a real clock.
                cache.load({ k: { value: 1, expiresAt: Date.now() - 1 } });
                await cache.getOrFetch('k', '/api/search?keyword=x', produce);
                expect(calls).toBe(2);
        });

        it('does not persist stream URLs', async () => {
                const cache = new AnimeCache();
                await cache.getOrFetch('s', '/api/stream?id=1', async () => ({ v: 1 }));
                await cache.getOrFetch('i', '/api/info?id=1', async () => ({ v: 2 }));
                const persisted = cache.toJSON();
                expect(persisted['s']).toBeUndefined();
                expect(persisted['i']).toBeDefined();
        });

        it('drops expired records on load', () => {
                const cache = new AnimeCache();
                cache.load({
                        fresh: { value: 1, expiresAt: Date.now() + 60_000 },
                        stale: { value: 2, expiresAt: Date.now() - 1 },
                        junk: 'not an entry',
                });
                expect(cache.get('fresh')).toBe(1);
                expect(cache.get('stale')).toBeUndefined();
                expect(cache.get('junk')).toBeUndefined();
        });

        it('bounds the number of entries', () => {
                const entries = new Map<string, { value: unknown; expiresAt: number; persist: boolean }>();
                for (let index = 0; index < MAX_CACHE_ENTRIES + 50; index++) {
                        // Ascending expiry, so the first keys are the oldest.
                        entries.set(`k${index}`, { value: index, expiresAt: index + 1, persist: true });
                }
                pruneEntries(entries);
                expect(entries.size).toBe(MAX_CACHE_ENTRIES);
                // The oldest are the ones dropped.
                expect(entries.has('k0')).toBe(false);
                expect(entries.has(`k${MAX_CACHE_ENTRIES + 49}`)).toBe(true);
        });

        it('persists on flush and survives a reload', async () => {
                const saved: unknown[] = [];
                const cache = new AnimeCache({ saveData: async (data) => void saved.push(data) });
                await cache.getOrFetch('k', '/api/info?id=1', async () => ({ title: 'Frieren' }));
                await cache.flush();
                expect(saved).toHaveLength(1);

                const reloaded = new AnimeCache();
                reloaded.load(saved[0]);
                expect(reloaded.get('k')).toEqual({ title: 'Frieren' });
        });

        it('does not write when nothing changed', async () => {
                const saved: unknown[] = [];
                const cache = new AnimeCache({ saveData: async (data) => void saved.push(data) });
                await cache.flush();
                expect(saved).toHaveLength(0);
        });
});

describe('animeApi caching', () => {
        it('serves a repeated search from the cache', async () => {
                setAnimeCache(new AnimeCache());
                mockedRequestUrl.mockImplementation(
                        respondWith({ results: { data: [{ id: '1', title: 'Naruto' }], totalPage: 1 } }) as never,
                );
                const first = await searchSeries('https://api.test', 'naruto');
                const second = await searchSeries('https://api.test', 'naruto');
                expect(first.series).toHaveLength(1);
                expect(second.series).toHaveLength(1);
                expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
        });

        it('does not cache across different keywords', async () => {
                setAnimeCache(new AnimeCache());
                mockedRequestUrl.mockImplementation(
                        respondWith({ results: { data: [{ id: '1', title: 'x' }], totalPage: 1 } }) as never,
                );
                await searchSeries('https://api.test', 'naruto');
                await searchSeries('https://api.test', 'bleach');
                expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
        });

        it('does not share entries between API bases', async () => {
                setAnimeCache(new AnimeCache());
                mockedRequestUrl.mockImplementation(
                        respondWith({ results: { data: [{ id: '1', title: 'x' }], totalPage: 1 } }) as never,
                );
                await searchSeries('https://one.test', 'naruto');
                await searchSeries('https://two.test', 'naruto');
                expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
        });

        it('bypasses the cache entirely when none is installed', async () => {
                setAnimeCache(null);
                mockedRequestUrl.mockImplementation(
                        respondWith({ results: { data: [{ id: '1', title: 'x' }], totalPage: 1 } }) as never,
                );
                await searchSeries('https://api.test', 'naruto');
                await searchSeries('https://api.test', 'naruto');
                expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
        });

        it('does not cache a failed response', async () => {
                setAnimeCache(new AnimeCache());
                mockedRequestUrl.mockImplementation(respondWith({}, 500) as never);
                await expect(loadEpisodes('https://api.test', '1')).rejects.toThrow();
                mockedRequestUrl.mockImplementation(
                        respondWith({ results: { episodes: [{ id: '1', episode_no: 1 }], totalEpisodes: 1 } }) as never,
                );
                const detail = await loadEpisodes('https://api.test', '1');
                expect(detail.episodes).toHaveLength(1);
        });

        it('serves repeated info lookups from the cache', async () => {
                setAnimeCache(new AnimeCache());
                mockedRequestUrl.mockImplementation(
                        respondWith({
                                results: {
                                        data: {
                                                id: '1',
                                                title: 'Frieren',
                                                adultContent: false,
                                                animeInfo: { Genre: ['Adventure'], Overview: 'x' },
                                        },
                                },
                        }) as never,
                );
                const first = await loadAnimeInfo('https://api.test', '1');
                const second = await loadAnimeInfo('https://api.test', '1');
                expect(first.title).toBe('Frieren');
                expect(second.title).toBe('Frieren');
                expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
        });
});

describe('loadStream caching', () => {
        const streamPayload = {
                results: {
                        streamingLink: {
                                server: 'Vidplay',
                                iframe: null,
                                link: { file: 'https://cdn.test/master.m3u8' },
                        },
                        servers: [{ serverName: 'Vidplay', type: 'sub' }],
                },
        };
        const playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n720.m3u8\n';

        it('caches the API call but re-reads the playlist', async () => {
                setAnimeCache(new AnimeCache());
                const calls: string[] = [];
                mockedRequestUrl.mockImplementation(((options: { url: string }) => {
                        calls.push(options.url);
                        if (options.url.includes('/api/stream')) {
                                return Promise.resolve({
                                        status: 200,
                                        json: streamPayload,
                                        text: JSON.stringify(streamPayload),
                                });
                        }
                        return Promise.resolve({ status: 200, json: null, text: playlist });
                }) as never);

                const first = await loadStream('https://api.test', '74575_1');
                const second = await loadStream('https://api.test', '74575_1');
                expect(first.variants).toHaveLength(1);
                expect(second.variants).toHaveLength(1);
                // One API call for both, but the playlist is re-read each time: it
                // lives on the CDN, not the API, and is short-lived.
                expect(calls.filter((url) => url.includes('/api/stream'))).toHaveLength(1);
                expect(calls.filter((url) => url.includes('master.m3u8'))).toHaveLength(2);
        });

        it('keeps stream entries out of the persisted payload', async () => {
                const cache = new AnimeCache();
                setAnimeCache(cache);
                mockedRequestUrl.mockImplementation(((options: { url: string }) =>
                        Promise.resolve(
                                options.url.includes('/api/stream')
                                        ? { status: 200, json: streamPayload, text: JSON.stringify(streamPayload) }
                                        : { status: 200, json: null, text: playlist },
                        )) as never);
                await loadStream('https://api.test', '74575_1');
                expect(Object.keys(cache.toJSON()).some((key) => key.includes('/api/stream'))).toBe(false);
        });
});

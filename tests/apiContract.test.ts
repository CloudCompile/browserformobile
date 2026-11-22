import { describe, it, expect, beforeEach, vi } from 'vitest';

import { loadAnimeInfo, loadEpisodes, loadStream, searchSeries, setAnimeCache } from '../src/animeApi';
import { downloadSubtitleTrack } from '../src/hls';
import { requestUrl } from 'obsidian';

vi.mock('obsidian', () => ({
        requestUrl: vi.fn(),
}));

const mockedRequestUrl = vi.mocked(requestUrl);

type Reply = { status: number; json: unknown; text: string };

/** Answer each request from a URL-keyed table, defaulting to an empty object. */
function respondByUrl(replies: Array<{ match: string; reply: Reply }>) {
        return (options: { url: string }) => {
                const found = replies.find((entry) => options.url.includes(entry.match));
                const reply = found?.reply ?? { status: 200, json: {}, text: '' };
                return Promise.resolve(reply);
        };
}

beforeEach(() => {
        mockedRequestUrl.mockReset();
        setAnimeCache(null);
});

describe('the current catalogue shape', () => {
        it('reads a flat search row (showType and eps, no tvInfo)', async () => {
                mockedRequestUrl.mockImplementation(
                        respondByUrl([
                                {
                                        match: '/api/search',
                                        reply: {
                                                status: 200,
                                                text: '',
                                                json: {
                                                        success: true,
                                                        results: {
                                                                totalPage: 1,
                                                                data: [
                                                                        {
                                                                                id: 'naruto-20',
                                                                                data_id: '20',
                                                                                title: 'Naruto',
                                                                                poster: 'https://img/naruto.jpg',
                                                                                showType: 'TV',
                                                                                rating: '8.0',
                                                                                eps: 220,
                                                                        },
                                                                ],
                                                        },
                                                },
                                        },
                                },
                        ]),
                );

                const result = await searchSeries('https://api', 'naruto');
                expect(result.series[0]).toMatchObject({
                        id: 'naruto-20',
                        title: 'Naruto',
                        poster: 'https://img/naruto.jpg',
                        showType: 'TV',
                        eps: 220,
                });
        });

        it('reads the episode number field the catalogue now serves', async () => {
                mockedRequestUrl.mockImplementation(
                        respondByUrl([
                                {
                                        match: '/api/episodes/',
                                        reply: {
                                                status: 200,
                                                text: '',
                                                json: {
                                                        success: true,
                                                        results: {
                                                                totalEpisodes: 1,
                                                                episodes: [
                                                                        {
                                                                                key: '20_1',
                                                                                id: 'naruto-20?ep=20_1',
                                                                                number: 1,
                                                                                title: 'Enter: Naruto Uzumaki!',
                                                                        },
                                                                ],
                                                        },
                                                },
                                        },
                                },
                        ]),
                );

                const detail = await loadEpisodes('https://api', 'naruto-20');
                expect(detail.episodes[0]).toMatchObject({ number: 1, title: 'Enter: Naruto Uzumaki!' });
        });

        it('finds the adult flag nested under animeInfo', async () => {
                mockedRequestUrl.mockImplementation(
                        respondByUrl([
                                {
                                        match: '/api/info',
                                        reply: {
                                                status: 200,
                                                text: '',
                                                json: {
                                                        success: true,
                                                        results: {
                                                                data: {
                                                                        id: 'adult-1',
                                                                        data_id: '1',
                                                                        title: 'Adult title',
                                                                        showType: 'TV',
                                                                        poster: 'https://img/a.jpg',
                                                                        animeInfo: {
                                                                                adultContent: true,
                                                                                rating: 'Rx - Hentai',
                                                                                tvInfo: { showType: 'TV', eps: 4 },
                                                                        },
                                                                },
                                                                seasons: [],
                                                        },
                                                },
                                        },
                                },
                        ]),
                );

                const info = await loadAnimeInfo('https://api', 'adult-1');
                expect(info.adultContent).toBe(true);
        });

        it('adds the opt-in adult source by searching its provider route', async () => {
                mockedRequestUrl.mockImplementation(
                        respondByUrl([
                                {
                                        match: '/api/providers/hentaimama/search',
                                        reply: {
                                                status: 200,
                                                text: '',
                                                json: {
                                                        success: true,
                                                        results: {
                                                                data: [
                                                                        {
                                                                                slug: 'so_low',
                                                                                title: 'So_low',
                                                                                poster: 'https://img/so-low.webp',
                                                                                type: 'TV',
                                                                                episodes: 4,
                                                                        },
                                                                ],
                                                        },
                                                },
                                        },
                                },
                                {
                                        match: '/api/search',
                                        reply: {
                                                status: 200,
                                                text: '',
                                                json: {
                                                        success: true,
                                                        results: {
                                                                totalPage: 1,
                                                                data: [
                                                                        {
                                                                                id: 'naruto-20',
                                                                                title: 'Naruto',
                                                                                showType: 'TV',
                                                                                eps: 220,
                                                                        },
                                                                ],
                                                        },
                                                },
                                        },
                                },
                        ]),
                );

                const result = await searchSeries('https://api', 'naruto', { includeAdult: true });
                expect(result.series.map((entry) => entry.id)).toEqual(['naruto-20', 'so_low']);
                expect(result.series[1]).toMatchObject({ adultContent: true, provider: 'hentaimama', eps: 4 });
        });
});

describe('stream headers', () => {
        it('forwards the API\u2019s CDN headers to the manifest request', async () => {
                const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\nindex.m3u8\n';
                const manifestUrl = 'https://fetch.example/master.m3u8';
                mockedRequestUrl.mockImplementation(
                        respondByUrl([
                                {
                                        match: '/api/stream',
                                        reply: {
                                                status: 200,
                                                text: '',
                                                json: {
                                                        success: true,
                                                        results: {
                                                                streamingLink: {
                                                                        link: { file: manifestUrl, type: 'hls' },
                                                                        iframe: null,
                                                                        server: 'HD-1',
                                                                        headers: { Referer: 'https://megaplay.buzz/' },
                                                                        tracks: [
                                                                                {
                                                                                        file: 'https://subs.example/eng.vtt',
                                                                                        label: 'English',
                                                                                        kind: 'captions',
                                                                                },
                                                                                {
                                                                                        file: 'https://subs.example/thumbs.vtt',
                                                                                        kind: 'thumbnails',
                                                                                },
                                                                        ],
                                                                },
                                                                servers: [],
                                                        },
                                                },
                                        },
                                },
                                {
                                        match: manifestUrl,
                                        reply: { status: 200, text: master, json: {} },
                                },
                        ]),
                );

                const source = await loadStream('https://api', 'naruto-20?ep=20_1');
                expect(source.headers.Referer).toBe('https://megaplay.buzz/');
                expect(source.variants).toHaveLength(1);
                // The CDN publishes captions beside the playlist, not inside it.
                expect(source.subtitles).toEqual([
                        { name: 'English', language: null, url: 'https://subs.example/eng.vtt' },
                ]);

                const manifestCall = mockedRequestUrl.mock.calls.find(
                        ([options]) => options.url === manifestUrl,
                );
                expect(manifestCall?.[0].headers?.Referer).toBe('https://megaplay.buzz/');
        });

        it('downloads a whole-document caption track as one VTT file', async () => {
                const vtt = [
                        'WEBVTT',
                        '',
                        '00:00:04.810 --> 00:00:10.980',
                        'A long time ago.',
                        '',
                ].join('\n');
                mockedRequestUrl.mockImplementation(
                        respondByUrl([
                                {
                                        match: 'https://subs.example/eng.vtt',
                                        reply: { status: 200, text: vtt, json: null },
                                },
                        ]),
                );

                const track = await downloadSubtitleTrack(
                        { name: 'English', language: 'en', url: 'https://subs.example/eng.vtt' },
                        { headers: { Referer: 'https://megaplay.buzz/' } },
                );
                expect(track.segments).toBe(1);
                expect(track.vtt).toContain('00:00:04.810 --> 00:00:10.980\nA long time ago.');
                expect(mockedRequestUrl.mock.calls[0][0].headers?.Referer).toBe('https://megaplay.buzz/');
        });
});

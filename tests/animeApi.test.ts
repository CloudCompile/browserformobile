import { describe, it, expect } from 'vitest';
import {
        collectPosters,
        infoFromPreview,
        isProviderTemplate,
        parseMasterPlaylist,
        previewFromInfo,
        providerStatus,
        readableSynopsis,
        resolveUrl,
        selectVariant,
        type AnimeInfo,
        type AnimePreview,
} from '../src/animeApi';

describe('parseMasterPlaylist', () => {
        it('parses variants', () => {
                const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\nstream.m3u8\n';
                const variants = parseMasterPlaylist(text, 'https://example.com/base/');
                expect(variants).toHaveLength(1);
                expect(variants[0].height).toBe(720);
        });
});

describe('resolveUrl', () => {
        it('resolves relative', () => {
                expect(resolveUrl('x.m3u8', 'https://example.com/a/b')).toBe('https://example.com/a/x.m3u8');
        });
});

describe('selectVariant', () => {
        it('falls back', () => {
                const variants = [{ width: 0, height: 720, bandwidth: 0, url: 'u' }];
                expect(selectVariant(variants, 1080)?.height).toBe(720);
        });
});

describe('collectPosters', () => {
        it('mines title and poster pairs from cached envelopes', () => {
                const records = {
                        'https://api.example/api/search?keyword=naruto': {
                                value: {
                                        success: true,
                                        results: [
                                                { id: '1', title: 'Naruto', poster: 'https://img/naruto.jpg' },
                                                { id: '2', title: 'Bleach', poster: 'https://img/bleach.jpg' },
                                        ],
                                },
                                expiresAt: Date.now() + 60_000,
                        },
                };
                const posters = collectPosters(records);
                expect(posters.get('naruto')).toBe('https://img/naruto.jpg');
                expect(posters.get('bleach')).toBe('https://img/bleach.jpg');
        });

        it('reads preview recommendation images and info objects', () => {
                const records = {
                        'https://api.example/api/preview/naruto-1': {
                                value: {
                                        success: true,
                                        results: {
                                                title: 'Naruto',
                                                poster: 'https://img/info.jpg',
                                                recommendations: [
                                                        { title: 'Boruto', image: 'https://img/boruto.jpg' },
                                                        { title: 'No image', votes: 5 },
                                                ],
                                        },
                                },
                                expiresAt: Date.now() + 60_000,
                        },
                };
                const posters = collectPosters(records);
                expect(posters.get('naruto')).toBe('https://img/info.jpg');
                expect(posters.get('boruto')).toBe('https://img/boruto.jpg');
                expect(posters.has('no image')).toBe(false);
        });

        it('keeps the first poster per title and rejects non-URLs', () => {
                const records = {
                        a: { value: { results: [{ title: 'X', poster: 'https://img/first.jpg' }] } },
                        b: { value: { results: [{ title: 'x', poster: 'https://img/second.jpg' }] } },
                        c: { value: { results: [{ title: 'Bad', poster: 'not-a-url' }] } },
                        d: { value: { results: [{ title: 'Episode 1', filler: false }] } },
                };
                const posters = collectPosters(records);
                expect(posters.get('x')).toBe('https://img/first.jpg');
                expect(posters.has('bad')).toBe(false);
                expect(posters.has('episode 1')).toBe(false);
        });

        it('tolerates junk input', () => {
                expect(collectPosters(null).size).toBe(0);
                expect(collectPosters('text').size).toBe(0);
                expect(collectPosters({ broken: { value: 42 } }).size).toBe(0);
        });
});

const BOILERPLATE =
        'Watch So_low hentai online free in HD with English subtitles. 3 episodes, Ongoing. Genres: Anal, Blowjob…';

function info(overrides: Partial<AnimeInfo> = {}): AnimeInfo {
        return {
                adultContent: true,
                id: 'so_low',
                dataId: '12402',
                title: 'So_low',
                japaneseTitle: null,
                poster: 'https://img/so_low.jpg',
                showType: 'TV',
                duration: null,
                status: 'Ongoing',
                score: null,
                genres: ['Uncensored', '3D'],
                studios: ['Nur'],
                overview: null,
                metadata: {},
                seasons: [],
                recommended: [],
                related: {},
                popular: [],
                provider: 'hentaimama',
                episodeCount: 4,
                year: 2023,
                rating: null,
                ...overrides,
        };
}

function preview(overrides: Partial<AnimePreview['detail']> = {}): AnimePreview {
        return {
                source: 'jikan',
                malId: 55548,
                detail: {
                        id: 55548,
                        url: 'https://myanimelist.net/anime/55548/So_low',
                        title: 'So_low',
                        titleEnglish: null,
                        titleJapanese: 'so_low',
                        image: 'https://img/mal.jpg',
                        images: null,
                        synopsis: 'A real synopsis.',
                        type: 'OVA',
                        episodes: 4,
                        status: 'Finished Airing',
                        score: 6.17,
                        scoredBy: 1200,
                        members: 3417,
                        favorites: 40,
                        rank: 5000,
                        popularity: 3000,
                        duration: '24 min',
                        rating: 'Rx',
                        source: 'Manga',
                        season: null,
                        year: 2023,
                        aired: { from: null, to: null, string: null },
                        broadcast: { day: null, time: null, timezone: null, string: null },
                        trailer: { youtubeId: null, url: null, embedUrl: null },
                        genres: ['Hentai'],
                        themes: [],
                        demographics: [],
                        studios: [{ id: 2014, name: 'Nur', url: null }],
                        producers: [],
                        licensors: [],
                        relations: [],
                        streaming: [],
                        externalLinks: [],
                        ...overrides,
                },
                characters: [],
                staff: [],
                recommendations: [],
                themes: [],
        };
}

describe('readableSynopsis', () => {
        it('recognizes the 18+ provider template', () => {
                expect(isProviderTemplate(BOILERPLATE)).toBe(true);
                expect(isProviderTemplate(' A real synopsis. ')).toBe(false);
                expect(isProviderTemplate(null)).toBe(false);
                expect(isProviderTemplate(undefined)).toBe(false);
        });

        it('drops the template instead of repeating it on every page', () => {
                expect(readableSynopsis(BOILERPLATE)).toBeNull();
                expect(readableSynopsis('  A real synopsis.  ')).toBe('A real synopsis.');
                expect(readableSynopsis('')).toBeNull();
                expect(readableSynopsis(null)).toBeNull();
        });

        it('recovers the status the template carries', () => {
                expect(providerStatus(BOILERPLATE)).toBe('Ongoing');
                expect(
                        providerStatus(
                                'Watch Overflow hentai online free in HD with English subtitles. 8 episodes, Completed. Genres: Ecchi…',
                        ),
                ).toBe('Completed');
                expect(providerStatus('A real synopsis.')).toBeNull();
                expect(providerStatus(null)).toBeNull();
        });
});

describe('previewFromInfo', () => {
        it('maps the 18+ structured fields into the shared shape', () => {
                const built = previewFromInfo(info());
                expect(built.source).toBe('hentaimama');
                expect(built.detail.title).toBe('So_low');
                expect(built.detail.image).toBe('https://img/so_low.jpg');
                expect(built.detail.type).toBe('TV');
                expect(built.detail.episodes).toBe(4);
                expect(built.detail.status).toBe('Ongoing');
                expect(built.detail.year).toBe(2023);
                expect(built.detail.genres).toEqual(['Uncensored', '3D']);
                expect(built.detail.studios[0]?.name).toBe('Nur');
                expect(built.detail.synopsis).toBeNull();
                expect(built.characters).toEqual([]);
        });

        it('keeps a real synopsis and parses a numeric rating', () => {
                const built = previewFromInfo(info({ overview: 'A real synopsis.', rating: '7.5' }));
                expect(built.detail.synopsis).toBe('A real synopsis.');
                expect(built.detail.rating).toBe('7.5');
        });

        it('carries the record\u2019s score, views and air date into the facts', () => {
                const built = previewFromInfo(info({ score: '7.8', views: 1079075, aired: 'Aug 2023' }));
                expect(built.detail.score).toBe(7.8);
                expect(built.detail.views).toBe(1079075);
                expect(built.detail.aired.string).toBe('Aug 2023');
        });
});

describe('infoFromPreview', () => {
        it('carries the preview detail back into source-level fields', () => {
                const built = infoFromPreview(preview(), '55548');
                expect(built.id).toBe('55548');
                expect(built.dataId).toBe('55548');
                expect(built.title).toBe('So_low');
                expect(built.showType).toBe('OVA');
                expect(built.score).toBe('6.17');
                expect(built.genres).toEqual(['Hentai']);
                expect(built.studios).toEqual(['Nur']);
                expect(built.episodeCount).toBe(4);
                expect(built.year).toBe(2023);
                expect(built.rating).toBe('Rx');
                expect(built.provider).toBeUndefined();
        });
        it('round-trips through previewFromInfo', () => {
                const source = preview();
                const rebuilt = previewFromInfo(infoFromPreview(source, '55548'));
                expect(rebuilt.detail.title).toBe(source.detail.title);
                expect(rebuilt.detail.episodes).toBe(source.detail.episodes);
                expect(rebuilt.detail.score).toBe(source.detail.score);
                expect(rebuilt.detail.genres).toEqual(source.detail.genres);
                expect(rebuilt.detail.studios.map((studio) => studio.name)).toEqual(['Nur']);
        });
});

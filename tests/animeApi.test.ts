import { describe, it, expect } from 'vitest';
import { collectPosters, parseMasterPlaylist, resolveUrl, selectVariant } from '../src/animeApi';

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

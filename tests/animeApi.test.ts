import { describe, it, expect } from 'vitest';
import { parseMasterPlaylist, resolveUrl, selectVariant } from '../src/animeApi';

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

import { describe, it, expect } from 'vitest';
import { parseMasterPlaylist, parseSubtitleRenditions, serverNames } from '../src/animeApi';
import { buildVttDocument, parseVttCues, shiftCueTimes, type VttCue } from '../src/hls';
import { renderTemplate } from '../src/downloader';

const MASTER = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English, CC",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="subs/en.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Spanish",LANGUAGE="es",URI="subs/es.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",TYPE=AUDIO,URI="audio/en.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="No URI"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720,SUBTITLES="subs"',
        'stream.m3u8',
].join('\n');

describe('parseSubtitleRenditions', () => {
        it('reads subtitle renditions and resolves their URLs', () => {
                const renditions = parseSubtitleRenditions(MASTER, 'https://cdn.example.com/master.m3u8');
                expect(renditions).toEqual([
                        { name: 'English, CC', language: 'en', url: 'https://cdn.example.com/subs/en.m3u8' },
                        { name: 'Spanish', language: 'es', url: 'https://cdn.example.com/subs/es.m3u8' },
                ]);
        });

        it('ignores audio renditions and non-subtitle playlists', () => {
                expect(parseSubtitleRenditions(MASTER, 'https://cdn.example.com/').some((r) => r.url.includes('audio'))).toBe(false);
                expect(parseSubtitleRenditions('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\ns.m3u8\n', 'https://cdn.example.com/')).toEqual([]);
        });
});

describe('parseMasterPlaylist still parses variants alongside subtitles', () => {
        it('reads the video variant', () => {
                const variants = parseMasterPlaylist(MASTER, 'https://cdn.example.com/master.m3u8');
                expect(variants).toHaveLength(1);
                expect(variants[0].height).toBe(720);
        });
});

describe('serverNames', () => {
        const servers = [
                { serverName: 'Vidplay', type: 'sub' },
                { serverName: 'MyCloud', type: 'sub' },
                { serverName: 'MegaDub', type: 'dub' },
                { serverName: 'Vidplay', type: 'dub' },
                { serverName: 'Other', type: '' },
        ];

        it('lists subbed servers first and drops duplicates', () => {
                expect(serverNames(servers)).toEqual(['Vidplay', 'MyCloud', 'MegaDub', 'Other']);
        });

        it('puts dubbed servers first when a dub is preferred', () => {
                expect(serverNames(servers, true)).toEqual(['MegaDub', 'Vidplay', 'MyCloud', 'Other']);
        });

        it('is unaffected by a catalogue with no dubbed server', () => {
                const subbedOnly = [{ serverName: 'Vidplay', type: 'sub' }];
                expect(serverNames(subbedOnly, true)).toEqual(['Vidplay']);
        });

        it('tolerates junk', () => {
                expect(serverNames(null)).toEqual([]);
                expect(serverNames([{}, { serverName: 'A' }])).toEqual(['A']);
        });
});

describe('parseVttCues', () => {
        it('collects cues and drops segment headers and notes', () => {
                const segment = [
                        'WEBVTT',
                        'X-TIMESTAMP_MAP=LOCAL:00:00:00.000,MPEGTS:900000',
                        '',
                        'NOTE this is a comment',
                        '',
                        '00:01:02.500 --> 00:01:04.000',
                        'Hello there.',
                        '',
                ].join('\n');
                expect(parseVttCues(segment)).toEqual([
                        { start: '00:01:02.500', end: '00:01:04.000', text: 'Hello there.' },
                ]);
        });

        it('keeps multi-line cue text and a cue identifier line', () => {
                const segment = [
                        'WEBVTT',
                        '',
                        'cue-1',
                        '00:00:01.000 --> 00:00:02.000 line align:start',
                        'First line',
                        'Second line',
                        '',
                ].join('\n');
                const cues = parseVttCues(segment);
                expect(cues).toHaveLength(1);
                expect(cues[0].text).toBe('First line\nSecond line');
                expect(cues[0].start).toBe('00:00:01.000');
        });

        it('returns nothing for a header-only segment', () => {
                expect(parseVttCues('WEBVTT\n\n')).toEqual([]);
        });
});

describe('buildVttDocument', () => {
        it('merges cues from several segments into one document', () => {
                const cues: VttCue[] = [
                        { start: '00:00:01.000', end: '00:00:02.000', text: 'One.' },
                        { start: '00:00:03.000', end: '00:00:04.000', text: 'Two.' },
                ];
                const document = buildVttDocument(cues);
                expect(document.startsWith('WEBVTT\n\n')).toBe(true);
                expect(document).toContain('00:00:01.000 --> 00:00:02.000\nOne.');
                expect(document).toContain('00:00:03.000 --> 00:00:04.000\nTwo.');
        });

        it('stays a valid (empty) WebVTT file when the track has no cues', () => {
                expect(buildVttDocument([])).toBe('WEBVTT\n');
        });
});

describe('subtitle sidecar naming', () => {
        it('swaps the extension through the same filename template', () => {
                const template = '{seriesFolder}/{series} - {ep:02} - {title}.{ext}';
                const values = { series: 'Naruto', seriesFolder: 'Naruto', episode: 1, title: 'Enter', ext: 'vtt' };
                expect(renderTemplate(template, values)).toBe('Naruto/Naruto - 01 - Enter.vtt');
        });
});

describe('shiftCueTimes', () => {
        it('moves every cue by the delay, later and earlier', () => {
                const cues = [
                        { startTime: 1, endTime: 2 },
                        { startTime: 10, endTime: 12.5 },
                ];
                shiftCueTimes(cues, 0.5);
                expect(cues).toEqual([
                        { startTime: 1.5, endTime: 2.5 },
                        { startTime: 10.5, endTime: 13 },
                ]);
                // Back to the original timing: the player re-shifts by the delta
                // when the user changes the delay, so it must be exact.
                shiftCueTimes(cues, -0.5);
                expect(cues).toEqual([
                        { startTime: 1, endTime: 2 },
                        { startTime: 10, endTime: 12.5 },
                ]);
        });

        it('clamps cues that would start before zero', () => {
                const cues = [{ startTime: 0.5, endTime: 1.5 }];
                shiftCueTimes(cues, -1);
                expect(cues).toEqual([{ startTime: 0, endTime: 0.5 }]);
        });

        it('flattens a cue the delay moves entirely past the start', () => {
                const cues = [{ startTime: 0.2, endTime: 0.8 }];
                shiftCueTimes(cues, -1);
                expect(cues).toEqual([{ startTime: 0, endTime: 0 }]);
        });

        it('ignores a zero or non-finite delay', () => {
                const cues = [{ startTime: 1, endTime: 2 }];
                shiftCueTimes(cues, 0);
                shiftCueTimes(cues, Number.NaN);
                expect(cues).toEqual([{ startTime: 1, endTime: 2 }]);
        });
});

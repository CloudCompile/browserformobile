import { describe, it, expect } from 'vitest';

import { elapsedSeconds, remainingBytesFromBitrate } from '../src/perf';

describe('elapsedSeconds', () => {
        const durations = [4, 4, 4, 6, 6, 10];

        it('sums the first count segments', () => {
                expect(elapsedSeconds(durations, 0)).toBe(0);
                expect(elapsedSeconds(durations, 1)).toBe(4);
                expect(elapsedSeconds(durations, 3)).toBe(12);
                expect(elapsedSeconds(durations, durations.length)).toBe(34);
        });

        it('clamps a count past the end rather than returning undefined', () => {
                expect(elapsedSeconds(durations, 999)).toBe(34);
        });

        it('clamps a negative count to zero', () => {
                expect(elapsedSeconds(durations, -5)).toBe(0);
        });

        it('returns zero for an empty playlist', () => {
                expect(elapsedSeconds([], 3)).toBe(0);
        });

        it('gives the same answer whether or not the prefix is reused', () => {
                // The first call builds the prefix sums; later calls reuse them.
                // Both must agree, and a longer playlist must not inherit the
                // shorter one's table.
                const short = [1, 2, 3];
                const long = [1, 2, 3, 4, 5];
                expect(elapsedSeconds(short, 3)).toBe(6);
                expect(elapsedSeconds(long, 5)).toBe(15);
                expect(elapsedSeconds(short, 2)).toBe(3);
        });
});

describe('remainingBytesFromBitrate', () => {
        it('scales the remaining seconds by the measured bitrate', () => {
                // 5 segments of 4s = 20s elapsed, 100s total, 1000 bytes fetched.
                // Bitrate 50 B/s, 80s left, so 4000 bytes remain.
                const durations = [4, 4, 4, 4, 4];
                const remaining = remainingBytesFromBitrate(durations, 100, 5, 1000);
                expect(remaining).toBeCloseTo(4000, 5);
        });

        it('returns zero once the media is fully covered', () => {
                expect(remainingBytesFromBitrate([4, 4], 8, 2, 500)).toBe(0);
        });

        it('returns null when there is nothing to go on', () => {
                expect(remainingBytesFromBitrate([], 100, 5, 1000)).toBeNull();
                expect(remainingBytesFromBitrate([4], 100, 0, 1000)).toBeNull();
                expect(remainingBytesFromBitrate([4], 100, 1, 0)).toBeNull();
        });

        it('treats all-zero durations as unknown', () => {
                expect(remainingBytesFromBitrate([0, 0, 0], 100, 2, 1000)).toBeNull();
        });

        it('handles a count past the end of the durations', () => {
                expect(remainingBytesFromBitrate([4, 4], 8, 99, 500)).toBe(0);
        });
});

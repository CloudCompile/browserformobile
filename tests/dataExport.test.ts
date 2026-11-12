import { describe, it, expect } from 'vitest';
import { buildStatsCsv, parseDataExport, StatsStore, type DownloadRun } from '../src/stats';

/** A run with every field set, so round-trips cannot pass by default. */
function run(overrides: Partial<DownloadRun> = {}): DownloadRun {
        return {
                id: 'run-1',
                series: 'Naruto',
                episode: 'Episode 3',
                bytes: 1000,
                fileSize: 4000,
                seconds: 12,
                averageSpeed: 83,
                peakSpeed: 120,
                format: 'mp4',
                quality: 720,
                segments: 40,
                resumed: false,
                finishedAt: Date.UTC(2026, 10, 12, 8, 0, 0),
                outcome: 'done',
                ...overrides,
        };
}

describe('buildStatsCsv', () => {
        it('writes a header row and one row per run, oldest first', () => {
                const newer = run({ id: 'late', finishedAt: Date.UTC(2026, 10, 12, 9, 0, 0) });
                const older = run({ id: 'early', finishedAt: Date.UTC(2026, 10, 12, 7, 0, 0) });
                const csv = buildStatsCsv([newer, older]);
                const lines = csv.trimEnd().split('\n');
                expect(lines[0]).toBe(
                        'id,series,episode,outcome,format,quality,segments,resumed,bytes,fileSize,seconds,averageSpeed,peakSpeed,finishedAt',
                );
                expect(lines).toHaveLength(3);
                expect(lines[1]).toContain('early');
                expect(lines[2]).toContain('late');
                // Timestamps are ISO 8601 in UTC so a spreadsheet sorts them.
                expect(lines[1]).toContain('2026-11-12T07:00:00.000Z');
        });

        it('quotes fields that contain commas and doubles embedded quotes', () => {
                const csv = buildStatsCsv([
                        run({ series: 'Campfire Cooking, Vol. 2', episode: 'The "Real" Hero' }),
                ]);
                expect(csv).toContain('"Campfire Cooking, Vol. 2"');
                expect(csv).toContain('"The ""Real"" Hero"');
        });

        it('writes a bare header for an empty log', () => {
                const csv = buildStatsCsv([]);
                expect(csv.trimEnd().split('\n')).toHaveLength(1);
        });

        it('omits the timestamp of a run that never recorded one', () => {
                const csv = buildStatsCsv([run({ finishedAt: 0 })]);
                expect(csv).toMatch(/,\n|,$/m);
                expect(csv).not.toContain('1970-01-01');
        });
});

describe('parseDataExport', () => {
        it('round-trips what the exporter wrote', () => {
                const watch = { 'Downloads/Naruto - 01.mp4': { position: 300, duration: 1440, updatedAt: 5 } };
                const stats = [run(), run({ id: 'run-2', outcome: 'failed' })];
                const parsed = parseDataExport({
                        version: 1,
                        exportedAt: '2026-11-12T00:00:00.000Z',
                        watch,
                        stats,
                });
                expect(parsed).not.toBeNull();
                expect(parsed?.exportedAt).toBe('2026-11-12T00:00:00.000Z');
                expect(parsed?.watch['Downloads/Naruto - 01.mp4']).toEqual(watch['Downloads/Naruto - 01.mp4']);
                expect(parsed?.stats).toHaveLength(2);
                expect(parsed?.stats[0].series).toBe('Naruto');
        });

        it('rejects a file that is not a version-1 export', () => {
                expect(parseDataExport(null)).toBeNull();
                expect(parseDataExport('x')).toBeNull();
                expect(parseDataExport([1, 2])).toBeNull();
                expect(parseDataExport({ version: 2, watch: {}, stats: [] })).toBeNull();
                expect(parseDataExport({ version: 1, stats: [] })).toBeNull();
                expect(parseDataExport({ version: 1, watch: [], stats: [] })).toBeNull();
                expect(parseDataExport({ version: 1, watch: {}, stats: 'no' })).toBeNull();
        });

        it('drops malformed records instead of rejecting the whole file', () => {
                const parsed = parseDataExport({
                        version: 1,
                        watch: {
                                good: { position: 12, duration: 100, updatedAt: 3 },
                                junk: 'nope',
                                'bad-position': { position: -5, duration: 100, updatedAt: 3 },
                        },
                        stats: [run(), { nope: true }, { id: '', series: 'X' }],
                });
                expect(Object.keys(parsed?.watch ?? {})).toEqual(['good']);
                expect(parsed?.stats).toHaveLength(1);
        });

        it('caps an oversized run log the way the plugin itself would', () => {
                const flood = Array.from({ length: 900 }, (_, index) =>
                        run({ id: `run-${index}`, finishedAt: index }),
                );
                const parsed = parseDataExport({ version: 1, watch: {}, stats: flood });
                expect(parsed?.stats).toHaveLength(500);
                // The oldest are the ones dropped.
                expect(parsed?.stats.some((entry) => entry.id === 'run-0')).toBe(false);
                expect(parsed?.stats.some((entry) => entry.id === 'run-899')).toBe(true);
        });
});

describe('import applies through the live stores', () => {
        it('replaces the contents of a StatsStore', () => {
                const store = new StatsStore();
                store.load([run({ id: 'old-1' }), run({ id: 'old-2' })]);
                const parsed = parseDataExport({ version: 1, watch: {}, stats: [run({ id: 'new-1' })] });
                store.load(parsed?.stats ?? []);
                expect(store.toJSON().map((entry) => entry.id)).toEqual(['new-1']);
        });
});

/**
 * Download statistics.
 *
 * Every finished download appends a `DownloadRun`, and the stats page is a
 * summary over that log. The log is deliberately small and flat — one record
 * per run, capped — so it stays cheap to load and to persist, and `summarize`
 * is a pure function over it so the page has no state of its own.
 */

import { VideoLibrary, type WatchRecord } from './library';

/** How a run ended. */
export type RunOutcome = 'done' | 'failed' | 'cancelled';

/** One completed download attempt, as the stats page sees it. */
export interface DownloadRun {
        /** Unique per run, so the log can be pruned without collisions. */
        id: string;
        /** Series the episode belongs to, or an empty string when unknown. */
        series: string;
        /** Short label for the episode, e.g. `Episode 3`. */
        episode: string;
        /**
         * Bytes actually transferred by this run. For a resumed run this excludes
         * the prefix already on disk, so `bytes / seconds` is a true throughput
         * rather than one inflated by work an earlier run did.
         */
        bytes: number;
        /** Final size of the file, or 0 when nothing was written. */
        fileSize: number;
        /** Wall-clock seconds the run took, measured start to finish. */
        seconds: number;
        /** Bytes per second across the run, or 0 when it could not be measured. */
        averageSpeed: number;
        /** Fastest windowed rate seen, or 0 when unknown. */
        peakSpeed: number;
        /** Output format used. */
        format: 'mp4' | 'ts';
        /** Preferred height in pixels. */
        quality: number;
        /** Segments fetched. */
        segments: number;
        /** True when the run continued an earlier download. */
        resumed: boolean;
        /** Epoch milliseconds the run ended. */
        finishedAt: number;
        outcome: RunOutcome;
        /**
         * Where the run happened — `Android`, `iOS`, `Mobile` or `Desktop`.
         * Optional because runs recorded before 4.2.5 have no label; they are
         * summarised under no device at all rather than a guess.
         */
        device?: string;
}

/** Totals and breakdowns the stats page renders. */
export interface StatsSummary {
        /** Every run in the log, newest first. */
        runs: DownloadRun[];
        /** Runs that finished successfully. */
        completed: number;
        failed: number;
        cancelled: number;
        /** Bytes written by successful runs. */
        totalBytes: number;
        /** Seconds spent on successful runs. */
        totalSeconds: number;
        /** Bytes per second across every successful run, or 0 with none. */
        averageSpeed: number;
        /** The single fastest run's average rate, or 0 with none. */
        bestSpeed: number;
        /** The run that hit the fastest peak, or 0 with none. */
        peakSpeed: number;
        /** Successful runs that resumed an earlier attempt. */
        resumed: number;
        /** Per-series totals, largest first. */
        series: SeriesTotals[];
        /**
         * Per-device totals, largest first. Empty when every run is
         * unlabeled; the page hides the section unless two or more devices
         * actually appear — one device is what the totals already show.
         */
        devices: DeviceTotals[];
        /** Average rates of the most recent runs, oldest first, for the chart. */
        speedHistory: number[];
}

/** One series' contribution to the totals. */
export interface SeriesTotals {
        series: string;
        episodes: number;
        bytes: number;
        seconds: number;
        /** Bytes per second across this series' successful runs. */
        averageSpeed: number;
}

/** One device's contribution to the totals. */
export interface DeviceTotals {
        device: string;
        episodes: number;
        bytes: number;
        seconds: number;
        /** Bytes per second across this device's successful runs. */
        averageSpeed: number;
}

/** Most recent runs kept for the chart, and the cap on the whole log. */
export const HISTORY_POINTS = 24;
export const MAX_RUNS = 500;

/**
 * Fold a run log into the figures the page shows. Pure, so the page can call it
 * on every render without caching or invalidation.
 */
export function summarize(runs: DownloadRun[]): StatsSummary {
        const ordered = [...runs].sort((a, b) => b.finishedAt - a.finishedAt);
        let completed = 0;
        let failed = 0;
        let cancelled = 0;
        let totalBytes = 0;
        let totalSeconds = 0;
        let bestSpeed = 0;
        let peakSpeed = 0;
        let resumed = 0;
        // Throughput is measured over the bytes a run actually transferred and the
        // time it took. Dividing the *file* size by the run's time would inflate a
        // resumed run, which only fetches the tail of a file an earlier run began.
        let rateBytes = 0;
        let rateSeconds = 0;

        const bySeries = new Map<
                string,
                { episodes: number; bytes: number; rateBytes: number; rateSeconds: number }
        >();
        const byDevice = new Map<
                string,
                { episodes: number; bytes: number; rateBytes: number; rateSeconds: number }
        >();

        for (const run of ordered) {
                if (run.outcome === 'failed') failed++;
                else if (run.outcome === 'cancelled') cancelled++;
                else completed++;
                if (run.outcome !== 'done') continue;

                totalBytes += run.fileSize || run.bytes;
                totalSeconds += run.seconds;
                if (run.averageSpeed > bestSpeed) bestSpeed = run.averageSpeed;
                if (run.peakSpeed > peakSpeed) peakSpeed = run.peakSpeed;
                if (run.resumed) resumed++;

                // A run that transferred nothing (fully resumed from disk, or failed
                // before its first byte) has no throughput to contribute.
                const measured = run.bytes > 0 && run.seconds > 0;
                if (measured) {
                        rateBytes += run.bytes;
                        rateSeconds += run.seconds;
                }

                const key = run.series || 'Unknown series';
                const entry =
                        bySeries.get(key) ??
                        { episodes: 0, bytes: 0, rateBytes: 0, rateSeconds: 0 };
                entry.episodes++;
                entry.bytes += run.fileSize || run.bytes;
                if (measured) {
                        entry.rateBytes += run.bytes;
                        entry.rateSeconds += run.seconds;
                }
                bySeries.set(key, entry);

                // Device totals mirror the series ones, over successful runs
                // that carry a label at all.
                if (run.device) {
                        const deviceEntry =
                                byDevice.get(run.device) ??
                                { episodes: 0, bytes: 0, rateBytes: 0, rateSeconds: 0 };
                        deviceEntry.episodes++;
                        deviceEntry.bytes += run.fileSize || run.bytes;
                        if (measured) {
                                deviceEntry.rateBytes += run.bytes;
                                deviceEntry.rateSeconds += run.seconds;
                        }
                        byDevice.set(run.device, deviceEntry);
                }
        }

        const series: SeriesTotals[] = [...bySeries.entries()]
                .map(([name, entry]) => ({
                        series: name,
                        episodes: entry.episodes,
                        bytes: entry.bytes,
                        seconds: entry.rateSeconds,
                        averageSpeed: entry.rateSeconds > 0 ? entry.rateBytes / entry.rateSeconds : 0,
                }))
                .sort((a, b) => b.bytes - a.bytes || a.series.localeCompare(b.series));

        const devices: DeviceTotals[] = [...byDevice.entries()]
                .map(([name, entry]) => ({
                        device: name,
                        episodes: entry.episodes,
                        bytes: entry.bytes,
                        seconds: entry.rateSeconds,
                        averageSpeed: entry.rateSeconds > 0 ? entry.rateBytes / entry.rateSeconds : 0,
                }))
                .sort((a, b) => b.bytes - a.bytes || a.device.localeCompare(b.device));

        const speedHistory = ordered
                .filter((run) => run.outcome === 'done' && run.averageSpeed > 0)
                .slice(0, HISTORY_POINTS)
                .map((run) => run.averageSpeed)
                .reverse();

        return {
                runs: ordered,
                completed,
                failed,
                cancelled,
                totalBytes,
                totalSeconds,
                averageSpeed: rateSeconds > 0 ? rateBytes / rateSeconds : 0,
                bestSpeed,
                peakSpeed,
                resumed,
                series,
                devices,
                speedHistory,
        };
}

/** Keep only the most recent runs, so the log cannot grow without bound. */
export function pruneRuns(runs: DownloadRun[], max = MAX_RUNS): DownloadRun[] {
        if (runs.length <= max) return runs;
        return [...runs].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, max);
}

/** Coerce a persisted record into a run, or null when it is unusable. */
function parseRun(value: unknown): DownloadRun | null {
        if (!value || typeof value !== 'object') return null;
        const raw = value as Record<string, unknown>;
        const number = (key: string): number => {
                const parsed = Number(raw[key]);
                return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        };
        const outcome = raw.outcome;
        return {
                id: typeof raw.id === 'string' ? raw.id : '',
                series: typeof raw.series === 'string' ? raw.series : '',
                episode: typeof raw.episode === 'string' ? raw.episode : '',
                bytes: number('bytes'),
                fileSize: number('fileSize'),
                seconds: number('seconds'),
                averageSpeed: number('averageSpeed'),
                peakSpeed: number('peakSpeed'),
                format: raw.format === 'ts' ? 'ts' : 'mp4',
                quality: number('quality'),
                segments: number('segments'),
                resumed: raw.resumed === true,
                finishedAt: number('finishedAt'),
                outcome: outcome === 'failed' || outcome === 'cancelled' ? outcome : 'done',
                device: typeof raw.device === 'string' && raw.device !== '' ? raw.device : undefined,
        };
}

/** The run log, with the persistence the page reads and writes through. */
export class StatsStore {
        private runs: DownloadRun[] = [];

        load(records: unknown): void {
                this.runs = [];
                if (!Array.isArray(records)) return;
                for (const record of records) {
                        const run = parseRun(record);
                        if (run && run.id) this.runs.push(run);
                }
                this.runs = pruneRuns(this.runs);
        }

        toJSON(): DownloadRun[] {
                return this.runs;
        }

        /** Append a finished run. Newest-first order is applied by `summarize`. */
        record(run: DownloadRun): void {
                this.runs.push(run);
                this.runs = pruneRuns(this.runs);
        }

        clear(): void {
                this.runs = [];
        }

        get count(): number {
                return this.runs.length;
        }

        summary(): StatsSummary {
                return summarize(this.runs);
        }
}

/** One field of a CSV row, quoted when it contains a comma, quote, or newline. */
function csvField(value: string | number | boolean): string {
        const text = String(value);
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The columns of the statistics CSV, in order. */
const CSV_COLUMNS = [
        'id',
        'series',
        'episode',
        'outcome',
        'format',
        'quality',
        'segments',
        'resumed',
        'bytes',
        'fileSize',
        'seconds',
        'averageSpeed',
        'peakSpeed',
        'device',
        'finishedAt',
] as const;

/**
 * The run log as a CSV document, oldest first so it reads in download order.
 *
 * Timestamps are ISO 8601 in UTC so a spreadsheet sorts them without guessing,
 * and every field goes through the same quoting rule, so a series named
 * `Campfire Cooking, Vol. 2` survives the round trip. Pure, so the export
 * command writes exactly what this returns and a test can hold it to that.
 */
export function buildStatsCsv(runs: DownloadRun[]): string {
        const rows = [...runs]
                .sort((a, b) => a.finishedAt - b.finishedAt)
                .map((run) =>
                        [
                                run.id,
                                run.series,
                                run.episode,
                                run.outcome,
                                run.format,
                                run.quality,
                                run.segments,
                                run.resumed,
                                run.bytes,
                                run.fileSize,
                                run.seconds,
                                run.averageSpeed,
                                run.peakSpeed,
                                run.device ?? '',
                                run.finishedAt > 0 ? new Date(run.finishedAt).toISOString() : '',
                        ]
                                .map(csvField)
                                .join(','),
                );
        return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

/** The parsed contents of a data export file. */
export interface DataExport {
        /** Watch progress by vault path, already validated. */
        watch: Record<string, WatchRecord>;
        /** Download runs, already validated and pruned. */
        stats: DownloadRun[];
        /** When the file was written, as the exporter recorded it. */
        exportedAt: string | null;
}

/**
 * Parse a data export file, or return null when it is not one.
 *
 * Import *replaces* the live watch progress and run log, so the shape is
 * checked before anything is applied: the version must be exactly 1 (there is
 * no migration path into arbitrary JSON a user may have edited), and both
 * sections go through the same parsers the plugin's own persisted data uses, so
 * a malformed record is dropped rather than smuggled in. `stats` reuse of the
 * run parser also caps the list, so an oversized file cannot grow the log past
 * what the plugin itself would keep.
 */
export function parseDataExport(payload: unknown): DataExport | null {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
        const raw = payload as Record<string, unknown>;
        if (raw.version !== 1) return null;
        if (!raw.watch || typeof raw.watch !== 'object' || Array.isArray(raw.watch)) return null;
        if (!Array.isArray(raw.stats)) return null;

        const library = new VideoLibrary();
        library.load(raw.watch as Record<string, WatchRecord>);
        const store = new StatsStore();
        store.load(raw.stats);
        return {
                watch: library.toJSON(),
                stats: store.toJSON(),
                exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
        };
}

/**
 * Download statistics.
 *
 * Every finished download appends a `DownloadRun`, and the stats page is a
 * summary over that log. The log is deliberately small and flat — one record
 * per run, capped — so it stays cheap to load and to persist, and `summarize`
 * is a pure function over it so the page has no state of its own.
 */

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

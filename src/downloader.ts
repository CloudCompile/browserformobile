import type { EpisodeSummary } from './animeApi';
import { loadStream, selectVariant } from './animeApi';
import { createDestination, sanitizeName, type Destination, type DestinationRequest } from './destination';
import {
        DownloadError,
        downloadSegmentsStreaming,
        formatBytes,
        formatDuration,
        formatSpeed,
        loadMediaPlaylist,
        RateLimitError,
        type MediaPlaylist,
} from './hls';
import { patchDuration, TransmuxStream } from './transmux';
import { generateId } from './utils';
import { ScreenWakeLock } from './wakelock';

/** Bytes coalesced into one write. Appending is costly on mobile. */
const TS_BATCH_BYTES = 8 * 1024 * 1024;
/**
 * Upper bound on a coalesced write; also the transmux flush window. Larger
 * batches mean fewer passes over the file, which matters because the vault
 * adapter rewrites the whole file on every append; the cap keeps the batch (and
 * so peak memory) bounded.
 */
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
/**
 * Smallest batch ceiling, used on low-memory phones. A batch is held in memory
 * while it is written, and MP4 holds the transmux window too, so the 64 MB
 * ceiling that is comfortable on a 4 GB phone can push a 1 GB one into an OOM
 * restart — the failure this ceiling exists to avoid.
 */
const MIN_BATCH_BYTES = 16 * 1024 * 1024;

/**
 * The batch ceiling for this device. `navigator.deviceMemory` reports an
 * approximate RAM size in GB (0.25–8) on Chromium, which is what Obsidian
 * mobile uses; it is absent on iOS, where the device has memory to spare, so an
 * unknown value keeps the full ceiling. Scaling down only ever reduces peak
 * memory at the cost of a few more write passes.
 */
export function batchCeiling(): number {
        const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
        if (typeof memory !== 'number' || !Number.isFinite(memory)) return MAX_BATCH_BYTES;
        if (memory >= 4) return MAX_BATCH_BYTES;
        if (memory >= 2) return MAX_BATCH_BYTES / 2;
        return MIN_BATCH_BYTES;
}

/** Video timescale mux.js writes into the MP4, and the unit of its timeline. */
const MP4_TIMESCALE = 90000;
/** Suffix of the staging file holding the raw stream of an unfinished job. */
const PART_SUFFIX = '.part';
/** Suffix of the JSON sidecar describing that staging file. */
const PART_META_SUFFIX = '.part.json';
/** How far a resumed stream may differ in total length before it is discarded. */
const DURATION_TOLERANCE_SECONDS = 1;
/**
 * How long a rate-limited job waits before it is tried again. The queue parks
 * it at the bottom rather than failing it, so a throttled server costs time
 * instead of the download.
 */
const RATE_LIMIT_RETRY_MS = 60_000;
/** Longest a rate-limited job waits before being retried again. */
const RATE_LIMIT_MAX_WAIT_MS = 15 * 60_000;
/** Bounds the retry wait shown to the user, so a clock skew cannot hide it. */
const MAX_RATE_LIMIT_RETRIES = 12;
/**
 * Sidecar layout version. Bumped when the staging file's contents change shape:
 * v1 held the raw MPEG-TS stream for every format, v2 holds the converted MP4
 * for the MP4 format. v3 adds the episode number and title so a queue restored
 * after a restart can name a job without calling the API.
 *
 * The staging file's shape is unchanged from v2 to v3, so a v2 sidecar is still
 * readable and is accepted rather than discarded — the only thing missing is the
 * episode label, which falls back to the id. A v1 sidecar must be discarded:
 * appending to it would corrupt the file.
 */
const PARTIAL_VERSION = 3;
/** Sidecar versions whose staging file this build can still append to. */
const COMPATIBLE_PARTIAL_VERSIONS = new Set([2, 3]);
/**
 * How many times a job is retried automatically after a non-rate-limit failure
 * before it is surfaced as failed. Mobile connectivity drops constantly and a
 * drop mid-download used to strand the job until the user noticed and tapped
 * Resume.
 */
const MAX_AUTO_RETRIES = 3;
/** First automatic retry delay; doubles per attempt, capped below. */
const AUTO_RETRY_BASE_MS = 4000;
const AUTO_RETRY_MAX_MS = 60_000;

export type JobStatus =
        | 'queued'
        | 'running'
        | 'paused'
        /** Parked by the queue waiting out a rate limit. Distinct from `paused`, which is the user's own pause. */
        | 'waiting'
        | 'done'
        | 'failed'
        | 'cancelled';

export type OutputFormat = 'mp4' | 'ts';

export interface DownloadJob {
        id: string;
        seriesTitle: string;
        episode: EpisodeSummary;
        status: JobStatus;
        /** Segments downloaded / total, or null before the playlist is known. */
        completed: number | null;
        total: number | null;
        bytes: number;
        /** Final file size once written. */
        fileSize: number | null;
        filePath: string | null;
        error: string | null;
        startedAt: number | null;
        finishedAt: number | null;
        /** True when this run continued an earlier, unfinished download. */
        resumed: boolean;
        /** Segments already on disk that a resume will skip. */
        resumeSegments: number;
        /** Bytes already on disk for this job. */
        resumeBytes: number;
        /** True when a resumable partial file was found for this episode. */
        partialFound: boolean;
        /** Segments written so far by the running job, kept for the sidecar. */
        writtenSegments: number;
        /** Bytes written so far by the running job, kept for the sidecar. */
        writtenBytes: number;
        /** Bytes per second, averaged over the last few seconds of a run. */
        speed: number | null;
        /** Estimated seconds remaining, or null while it cannot be estimated. */
        eta: number | null;
        /** When a rate-limited job parked at the bottom of the queue will retry. */
        retryAt: number | null;
        /** How many times the job has been parked for rate limiting. */
        rateLimitRetries: number;
        /** How many times the job has been retried automatically after a plain failure. */
        autoRetries: number;
        /** Timestamp and byte count of the last speed sample. */
        speedSampleAt?: number;
        speedSampleBytes?: number;
}

export interface DownloaderOptions {
        apiBase: string;
        /** Preferred height in pixels. Falls back to the closest variant. */
        quality: number;
        format: OutputFormat;
        /** Parallel segment requests per episode. */
        segmentConcurrency: number;
        /** Episodes downloaded at the same time. */
        maxConcurrentJobs: number;
        filenameTemplate: string;
        destination: DestinationRequest;
}

export interface EnqueueRequest {
        seriesTitle: string;
        episodes: EpisodeSummary[];
}

/** A partial found on disk, with the identity a resume can be checked against. */
interface PartialState {
        version: number;
        episodeId: string;
        seriesTitle: string;
        format: OutputFormat;
        quality: number;
        totalSegments: number;
        durationSeconds: number;
        segments: number;
        bytes: number;
        /** Episode number, so a restored job can name itself without the API. */
        episodeNumber?: number;
        /** Episode title, for the same reason. Absent in v2 sidecars. */
        episodeTitle?: string;
}

function partialStatePath(finalPath: string): string {
        return `${finalPath}${PART_SUFFIX}`;
}

function partialMetaPath(finalPath: string): string {
        return `${finalPath}${PART_META_SUFFIX}`;
}

/** Read a job's sidecar, or null when it is missing, unreadable, or too old. */
async function readPartial(
        destination: Destination,
        finalPath: string,
): Promise<PartialState | null> {
        const raw = await destination.read(partialMetaPath(finalPath));
        if (!raw) return null;
        try {
                const parsed = JSON.parse(new TextDecoder().decode(raw)) as PartialState;
                if (!COMPATIBLE_PARTIAL_VERSIONS.has(parsed.version)) return null;
                return parsed;
        } catch {
                return null;
        }
}

/** Write a job's sidecar. */
async function writePartial(
        destination: Destination,
        finalPath: string,
        state: PartialState,
): Promise<void> {
        await destination.write(partialMetaPath(finalPath), new TextEncoder().encode(JSON.stringify(state)));
}

/** Delete a job's staging file and sidecar. */
async function discardPartial(destination: Destination, finalPath: string): Promise<void> {
        await destination.remove(partialMetaPath(finalPath));
        await destination.remove(partialStatePath(finalPath));
}

export class DownloadManager {
        readonly jobs: DownloadJob[] = [];

        private options: DownloaderOptions;
        private destination: Destination | null = null;
        /** Relative staging path per job, so discard/resume target the right file. */
        private readonly stagingPaths = new Map<string, string>();
        private readonly controllers = new Map<string, AbortController>();
        private running = 0;
        private updateTimer: number | null = null;
        /** Pending rate-limit retry timers, cleared on dispose. */
        private readonly retryTimers = new Set<number>();
        /** Holds the screen awake while a job runs, so Android does not freeze it. */
        private readonly wakeLock = new ScreenWakeLock();

        constructor(
                private readonly app: { vault: { adapter: unknown } },
                options: DownloaderOptions,
                private readonly onUpdate: () => void,
        ) {
                this.options = options;
        }

        setOptions(options: DownloaderOptions): void {
                // The folder or external toggle may have changed; rebuild lazily.
                if (
                        options.destination.folder !== this.options.destination.folder ||
                        options.destination.external !== this.options.destination.external
                ) {
                        this.destination = null;
                }
                this.options = options;
        }

        /**
         * Enqueue episodes for download, skipping ones already queued or running.
         * A finished-but-failed episode is revived in place so its partial file
         * is resumed rather than a second job writing the same staging path.
         */
        enqueue(request: EnqueueRequest): DownloadJob[] {
                const created: DownloadJob[] = [];
                for (const episode of request.episodes) {
                        const existing = this.jobs.find((job) => job.episode.id === episode.id);
                        if (
                                existing &&
                                (existing.status === 'queued' ||
                                        existing.status === 'running' ||
                                        existing.status === 'paused' ||
                                        existing.status === 'waiting')
                        ) {
                                continue;
                        }
                        if (existing && (existing.status === 'failed' || existing.status === 'cancelled')) {
                                existing.status = 'queued';
                                existing.error = null;
                                existing.startedAt = null;
                                existing.finishedAt = null;
                                existing.resumeSegments = 0;
                                existing.resumeBytes = 0;
                                existing.resumed = false;
                                existing.retryAt = null;
                                existing.rateLimitRetries = 0;
                                existing.autoRetries = 0;
                                created.push(existing);
                                continue;
                        }
                        const job: DownloadJob = {
                                id: generateId(),
                                seriesTitle: request.seriesTitle,
                                episode,
                                status: 'queued',
                                completed: null,
                                total: null,
                                bytes: 0,
                                fileSize: null,
                                filePath: null,
                                error: null,
                                startedAt: null,
                                finishedAt: null,
                                resumed: false,
                                resumeSegments: 0,
                                resumeBytes: 0,
                                partialFound: false,
                                writtenSegments: 0,
                                writtenBytes: 0,
                                speed: null,
                                eta: null,
                                retryAt: null,
                                rateLimitRetries: 0,
                                autoRetries: 0,
                        };
                        this.jobs.push(job);
                        created.push(job);
                }
                this.scheduleUpdate();
                this.pump();
                return created;
        }

        /** Failed jobs whose partial file can still be continued. */
        get resumableJobs(): DownloadJob[] {
                return this.jobs.filter((job) => job.status === 'failed' && job.partialFound);
        }

        /**
         * Forget a job's partial file. Used by the queue's discard action and
         * when a download is cancelled outright.
         */
        async discard(jobId: string): Promise<void> {
                const job = this.jobs.find((entry) => entry.id === jobId);
                if (!job) return;
                const destination = this.destinationFor();
                const path = this.stagingPaths.get(jobId) ?? this.buildPath(job);
                await discardPartial(destination, path);
                this.stagingPaths.delete(jobId);
                job.partialFound = false;
                job.resumeSegments = 0;
                job.resumeBytes = 0;
                this.scheduleUpdate();
        }

        cancel(jobId: string): void {
                const job = this.jobs.find((entry) => entry.id === jobId);
                if (!job) return;
                if (
                        job.status === 'queued' ||
                        job.status === 'paused' ||
                        job.status === 'waiting'
                ) {
                        job.status = 'cancelled';
                        job.retryAt = null;
                        job.finishedAt = Date.now();
                        this.scheduleUpdate();
                        return;
                }
                this.controllers.get(jobId)?.abort();
        }

        /**
         * Hold a download without losing what it has fetched. The run is aborted
         * the same way a cancel is, but the staging file is kept and the job stays
         * resumable, so pausing is safe to do to save bandwidth or battery.
         */
        pause(jobId: string): void {
                const job = this.jobs.find((entry) => entry.id === jobId);
                if (!job) return;
                if (job.status === 'queued' || job.status === 'waiting') {
                        job.status = 'paused';
                        job.retryAt = null;
                        this.scheduleUpdate();
                        return;
                }
                if (job.status !== 'running') return;
                // Set the status before aborting: the run's catch block reads it to
                // tell a pause from a cancel and keep the partial accordingly.
                job.status = 'paused';
                job.speed = null;
                job.eta = null;
                this.scheduleUpdate();
                this.controllers.get(jobId)?.abort();
        }

        /**
         * Put a job back in the queue. Covers the three states the queue offers to
         * continue: paused by the user, parked waiting on a retry, and failed with
         * a partial still on disk. A finished job is left alone — its file exists,
         * so re-running it would only hit "already exists".
         */
        resume(jobId: string): void {
                const job = this.jobs.find((entry) => entry.id === jobId);
                if (!job) return;
                if (job.status === 'running' || job.status === 'queued' || job.status === 'done') return;
                job.status = 'queued';
                job.error = null;
                // A manual resume gets a fresh retry budget: the counters exist to
                // stop the automatic paths looping, not to punish the user.
                job.autoRetries = 0;
                job.rateLimitRetries = 0;
                this.scheduleUpdate();
                this.pump();
        }

        cancelAll(): void {
                for (const job of this.jobs) {
                        if (
                                job.status === 'running' ||
                                job.status === 'queued' ||
                                job.status === 'paused' ||
                                job.status === 'waiting'
                        ) {
                                this.cancel(job.id);
                        }
                }
        }

        clearFinished(): void {
                for (let index = this.jobs.length - 1; index >= 0; index--) {
                        const job = this.jobs[index];
                        if (job && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')) {
                                // Any staging file is left on disk: re-enqueueing the
                                // episode rediscovers and resumes it, so clearing the
                                // row must not throw that work away.
                                this.stagingPaths.delete(job.id);
                                this.jobs.splice(index, 1);
                        }
                }
                this.scheduleUpdate();
        }

        get activeCount(): number {
                return this.jobs.filter(
                        (job) =>
                                job.status === 'running' ||
                                job.status === 'queued' ||
                                job.status === 'paused' ||
                                job.status === 'waiting',
                ).length;
        }

        private pump(): void {
                while (this.running < this.options.maxConcurrentJobs) {
                        const next = this.jobs.find((job) => job.status === 'queued');
                        if (!next) break;
                        void this.run(next);
                }
        }

        /**
         * How long to wait before retrying a rate-limited job. The wait grows with
         * each park so a sustained throttle is not hammered every minute forever,
         * and is capped so a long block still gets retried within a session.
         */
        private rateLimitWaitMs(retries: number): number {
                const wait = RATE_LIMIT_RETRY_MS * 2 ** Math.max(0, retries - 1);
                return Math.min(wait, RATE_LIMIT_MAX_WAIT_MS);
        }

        /**
         * Move a rate-limited job to the bottom of the queue and schedule it to
         * run again. Failing the job instead would throw away a nearly complete
         * download over a transient throttle, so it waits rather than dies. Only
         * after many consecutive parks does it surface as failed, and even then
         * the partial is kept so Resume continues it.
         */
        private parkForRateLimit(job: DownloadJob): boolean {
                job.rateLimitRetries++;
                if (job.rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
                        job.status = 'failed';
                        job.error = 'The server kept rate limiting the download. Resume continues where it stopped.';
                        job.retryAt = null;
                        return false;
                }
                job.status = 'waiting';
                job.error = null;
                job.speed = null;
                job.eta = null;
                const wait = this.rateLimitWaitMs(job.rateLimitRetries);
                job.retryAt = Date.now() + wait;
                // Re-queue behind everything else, so other episodes get their turn
                // while this one waits out the throttle.
                const index = this.jobs.indexOf(job);
                if (index !== -1) this.jobs.splice(index, 1);
                this.jobs.push(job);
                this.scheduleUpdate();
                const timer = window.setTimeout(() => {
                        this.retryTimers.delete(timer);
                        if (job.status !== 'waiting') return;
                        job.retryAt = null;
                        job.status = 'queued';
                        this.scheduleUpdate();
                        this.pump();
                }, wait);
                this.retryTimers.add(timer);
                return true;
        }

        /** Jobs parked waiting out a rate limit, oldest retry first. */
        get waitingJobs(): DownloadJob[] {
                return this.jobs.filter((job) => job.status === 'waiting');
        }

        /** Jobs the user paused. */
        get pausedJobs(): DownloadJob[] {
                return this.jobs.filter((job) => job.status === 'paused');
        }

        private async run(job: DownloadJob): Promise<void> {
                this.running++;
                job.status = 'running';
                // Android suspends the WebView when the screen sleeps, which stalls
                // the requests and can let the OS reclaim the app. Hold the screen
                // on for the duration of the job.
                this.wakeLock.acquire();
                job.startedAt = Date.now();
                job.speed = null;
                job.eta = null;
                let deferred = false;
                const controller = new AbortController();
                this.controllers.set(job.id, controller);
                this.scheduleUpdate();

                try {
                        await this.execute(job, controller.signal, () => this.trackSpeed(job));
                        job.status = 'done';
                } catch (error) {
                        if (controller.signal.aborted) {
                                // A pause aborts the run but must keep the work, so
                                // the status set by pause() decides which way to go.
                                if (this.isPaused(job)) {
                                        await this.markPartial(job);
                                } else {
                                        job.status = 'cancelled';
                                        // An explicit cancel abandons the download, so
                                        // the staging file and sidecar are removed
                                        // rather than left for a resume the user did
                                        // not ask for.
                                        await this.forgetPartial(job);
                                }
                        } else if (error instanceof RateLimitError) {
                                // Keep whatever landed on disk: the retry resumes it.
                                await this.markPartial(job);
                                deferred = this.parkForRateLimit(job);
                        } else {
                                // A dropped connection or a flaky server is usually
                                // transient, so retry it a few times before showing a
                                // failure. The partial is kept either way.
                                await this.markPartial(job);
                                if (this.scheduleAutoRetry(job, error)) {
                                        deferred = true;
                                } else {
                                        job.status = 'failed';
                                        job.error = error instanceof Error ? error.message : String(error);
                                }
                        }
                } finally {
                        // A deferred job is only waiting on a timer, so let the screen
                        // sleep during the pause and re-acquire when it retries.
                        this.wakeLock.release();
                        // A deferred job has not finished; it is only waiting.
                        if (!deferred) job.finishedAt = Date.now();
                        job.speed = null;
                        job.eta = null;
                        this.controllers.delete(job.id);
                        this.running--;
                        this.scheduleUpdate();
                        this.pump();
                }
        }

        /**
         * Whether the user paused this job. Read through a method so the compiler
         * does not narrow `status` to the values assigned earlier in `run`: the
         * pause handler mutates it from outside that flow.
         */
        private isPaused(job: DownloadJob): boolean {
                return job.status === 'paused';
        }

        /**
         * Re-queue a job that failed for a reason that is likely transient, with a
         * growing delay. Returns false when the failure is not retryable or the
         * retries are spent, so the caller surfaces the failure instead. A job
         * that has already made progress is always worth retrying: the partial
         * means the retry costs only the remaining segments.
         */
        private scheduleAutoRetry(job: DownloadJob, error: unknown): boolean {
                if (job.autoRetries >= MAX_AUTO_RETRIES) return false;
                // A validation failure or "already exists" is deterministic; retrying
                // it would spin for no reason.
                if (error instanceof DownloadError && !error.retryable) return false;
                job.autoRetries++;
                const wait = Math.min(AUTO_RETRY_BASE_MS * 2 ** (job.autoRetries - 1), AUTO_RETRY_MAX_MS);
                job.status = 'waiting';
                job.error = error instanceof Error ? error.message : String(error);
                job.retryAt = Date.now() + wait;
                const index = this.jobs.indexOf(job);
                if (index !== -1) this.jobs.splice(index, 1);
                this.jobs.push(job);
                this.scheduleUpdate();
                const timer = window.setTimeout(() => {
                        this.retryTimers.delete(timer);
                        if (job.status !== 'waiting') return;
                        job.retryAt = null;
                        job.status = 'queued';
                        this.scheduleUpdate();
                        this.pump();
                }, wait);
                this.retryTimers.add(timer);
                return true;
        }

        /**
         * Smooth the byte rate over a short window so the figure is readable
         * rather than jumping with every segment. The ETA is derived from the
         * average bytes per segment seen so far, which is accurate enough to be
         * useful and needs no knowledge of the file size up front.
         */
        private trackSpeed(job: DownloadJob): void {
                const now = Date.now();
                const elapsed = (now - (job.speedSampleAt ?? now)) / 1000;
                if (elapsed < 1) return;
                const delta = job.bytes - (job.speedSampleBytes ?? job.bytes);
                const instant = delta / elapsed;
                job.speed = job.speed === null ? instant : job.speed * 0.6 + instant * 0.4;
                job.speedSampleAt = now;
                job.speedSampleBytes = job.bytes;
                if (job.speed > 0 && job.completed !== null && job.total !== null && job.completed > 0) {
                        const perSegment = job.bytes / job.completed;
                        const remainingBytes = perSegment * (job.total - job.completed);
                        job.eta = remainingBytes / job.speed;
                }
        }

        /** Remove a job's staging file and sidecar, ignoring any error. */
        private async forgetPartial(job: DownloadJob): Promise<void> {
                try {
                        const destination = this.destinationFor();
                        const path = this.stagingPaths.get(job.id) ?? this.buildPath(job);
                        await discardPartial(destination, path);
                } catch {
                        /* Best effort. */
                }
                job.partialFound = false;
                job.resumeSegments = 0;
                job.resumeBytes = 0;
        }

        private async execute(
                job: DownloadJob,
                signal: AbortSignal,
                onTick: () => void,
        ): Promise<void> {
                const source = await loadStream(this.options.apiBase, job.episode.id);
                if (signal.aborted) throw new DownloadError('Download cancelled.');
                if (!source.url || source.variants.length === 0) {
                        throw new DownloadError(
                                source.iframe
                                        ? `The ${source.server || 'default'} server only offers an embedded player, which cannot be downloaded.`
                                        : 'No downloadable stream was found for this episode.',
                        );
                }
                const variant = selectVariant(source.variants, this.options.quality);
                if (!variant) throw new DownloadError('No stream quality was available.');

                const playlist = await loadMediaPlaylist(variant.url);
                if (signal.aborted) throw new DownloadError('Download cancelled.');

                const destination = this.destinationFor();
                const path = this.buildPath(job);
                const validation = destination.validate(path);
                if (validation) throw new DownloadError(validation);
                // Remember the relative staging path: the partial file and its
                // sidecar are derived from it, so a failed or cancelled job must
                // keep it even though the final file does not exist yet.
                this.stagingPaths.set(job.id, path);
                job.filePath = destination.displayPath(path);

                // A failed run leaves its staging file behind so it can be
                // continued. Resume is only safe when the stream has not changed
                // underneath it, so the sidecar is checked against this run's
                // episode, format, quality, and the freshly loaded playlist.
                let resumeFrom = 0;
                let resumeBytes = 0;
                const partial = await readPartial(destination, path);
                if (partial) {
                        const matches =
                                partial.episodeId === job.episode.id &&
                                partial.format === this.options.format &&
                                partial.quality === this.options.quality &&
                                partial.totalSegments === playlist.segments.length &&
                                Math.abs(partial.durationSeconds - playlist.duration) <=
                                        DURATION_TOLERANCE_SECONDS;
                        const onDisk = await destination.size(partialStatePath(path));
                        // The sidecar is written after each batch, so a crash
                        // between the append and that write leaves the staging
                        // file longer than the recorded byte count. Those extra
                        // bytes are a torn batch: cut them off rather than
                        // discarding a download that may be almost complete. A
                        // file *shorter* than recorded is not recoverable, so
                        // that is still thrown away.
                        if (matches && partial.segments > 0 && onDisk !== null && onDisk >= partial.bytes) {
                                if (onDisk > partial.bytes) {
                                        await destination.truncate(partialStatePath(path), partial.bytes);
                                }
                                resumeFrom = Math.min(partial.segments, playlist.segments.length);
                                resumeBytes = partial.bytes;
                                job.partialFound = true;
                        } else {
                                await discardPartial(destination, path);
                        }
                }

                if (await destination.exists(path)) {
                        throw new DownloadError(`${destination.displayPath(path)} already exists.`);
                }

                job.total = playlist.segments.length;
                job.completed = resumeFrom;
                job.resumeSegments = resumeFrom;
                job.resumeBytes = resumeBytes;
                job.resumed = resumeFrom > 0;
                job.writtenSegments = resumeFrom;
                job.writtenBytes = resumeBytes;
                job.speedSampleAt = Date.now();
                job.speedSampleBytes = job.bytes;
                this.scheduleUpdate();

                const onProgress = (progress: { completed: number; bytes: number }): void => {
                        job.completed = progress.completed;
                        job.bytes = progress.bytes;
                        onTick();
                        this.scheduleUpdate();
                };

                const written =
                        this.options.format === 'ts'
                                ? await this.writeTs(job, destination, path, playlist, signal, onProgress, resumeFrom, resumeBytes)
                                : await this.writeMp4(job, destination, path, playlist, signal, onProgress, resumeFrom, resumeBytes);

                job.fileSize = written;
                job.partialFound = false;
                this.stagingPaths.delete(job.id);
        }

        /**
         * Download to the staging file, recording progress in a sidecar after
         * every batch so an interrupted run can continue from the last segment
         * that actually landed. The staging file is deliberately left in place
         * when the run fails or is cancelled; the caller finalises or discards
         * it.
         */
        private async stageSegments(
                job: DownloadJob,
                destination: Destination,
                path: string,
                playlist: MediaPlaylist,
                signal: AbortSignal,
                onProgress: (progress: { completed: number; bytes: number }) => void,
                resumeFrom: number,
                resumeBytes: number,
        ): Promise<number> {
                const part = partialStatePath(path);
                // Resuming appends to the existing staging file; a fresh run
                // creates it.
                const writer = await destination.open(part, { append: resumeFrom > 0 });
                const state = this.partialState(job, playlist, resumeFrom, resumeBytes);
                try {
                        await downloadSegmentsStreaming(
                                playlist,
                                {
                                        concurrency: this.options.segmentConcurrency,
                                        signal,
                                        onProgress,
                                        batchBytes: this.batchBytesFor(playlist),
                                        resumeFrom,
                                        resumeBytes,
                                },
                                async (_index, data, writtenThrough) => {
                                        await writer.write(data);
                                        state.segments = writtenThrough;
                                        state.bytes += data.byteLength;
                                        await writePartial(destination, path, state);
                                },
                        );
                } catch (error) {
                        // Let the writes already queued finish so the staging file
                        // and its sidecar agree before the failure is reported. A
                        // write that itself failed is left alone: the sidecar then
                        // describes a shorter, still-valid prefix.
                        await writer.settle();
                        throw error;
                }
                await writer.close();
                return state.bytes;
        }

        /** The sidecar record for a run, before any progress is recorded. */
        private partialState(
                job: DownloadJob,
                playlist: MediaPlaylist,
                segments: number,
                bytes: number,
        ): PartialState {
                return {
                        version: PARTIAL_VERSION,
                        episodeId: job.episode.id,
                        seriesTitle: job.seriesTitle,
                        format: this.options.format,
                        quality: this.options.quality,
                        totalSegments: playlist.segments.length,
                        durationSeconds: playlist.duration,
                        segments,
                        bytes,
                        episodeNumber: job.episode.number,
                        episodeTitle: job.episode.title,
                };
        }

        /**
         * Bytes coalesced into one append. Every append re-reads and rewrites the
         * whole file on mobile, so a longer download uses bigger batches: fewer
         * passes over a large file means far less I/O and less peak memory.
         */
        private batchBytesFor(playlist: MediaPlaylist): number {
                const estimate = playlist.duration * 200 * 1024;
                return Math.max(TS_BATCH_BYTES, Math.min(estimate / 16, batchCeiling()));
        }

        /**
         * TS is already a playable file, so it finalises by moving the staging
         * file to its final name. The sidecar is only dropped once the rename
         * has succeeded, so a crash mid-finalise still leaves a resumable pair.
         */
        private async writeTs(
                job: DownloadJob,
                destination: Destination,
                path: string,
                playlist: MediaPlaylist,
                signal: AbortSignal,
                onProgress: (progress: { completed: number; bytes: number }) => void,
                resumeFrom: number,
                resumeBytes: number,
        ): Promise<number> {
                const written = await this.stageSegments(
                        job,
                        destination,
                        path,
                        playlist,
                        signal,
                        onProgress,
                        resumeFrom,
                        resumeBytes,
                );
                await destination.rename(partialStatePath(path), path);
                await destination.remove(partialMetaPath(path));
                return written;
        }

        /**
         * MP4 is transmuxed as the stream arrives, not from a whole-file
         * read-back.
         *
         * mux.js emits nothing from `push()`; output only appears at `flush()`,
         * and flushing once at the end materialises the entire episode — measured
         * at ~4 GB for a 726 MB stream, which restarts a phone. Each downloaded
         * batch is pushed and flushed in turn instead, so the transmuxer holds one
         * batch rather than the whole movie, and every fragment is written and
         * dropped. The staging file is the partial MP4 itself, so a failure leaves
         * a resumable file and a resume appends to it.
         */
        private async writeMp4(
                job: DownloadJob,
                destination: Destination,
                path: string,
                playlist: MediaPlaylist,
                signal: AbortSignal,
                onProgress: (progress: { completed: number; bytes: number }) => void,
                resumeFrom: number,
                resumeBytes: number,
        ): Promise<number> {
                const part = partialStatePath(path);
                const resuming = resumeFrom > 0;
                const writer = await destination.open(part, { append: resuming });
                const state = this.partialState(job, playlist, resumeFrom, resumeBytes);
                let bytes = resumeBytes;
                let init: Uint8Array | null = null;
                const stream = new TransmuxStream(
                        (segment) => {
                                init = patchDuration(segment, playlist.duration);
                        },
                        async (fragment) => {
                                if (init) {
                                        await writer.write(init);
                                        bytes += init.byteLength;
                                        init = null;
                                }
                                await writer.write(fragment);
                                bytes += fragment.byteLength;
                        },
                        // A resumed file already begins with an init segment;
                        // writing a second one mid-file would corrupt it.
                        { skipInit: resuming },
                );
                if (resuming) {
                        // Continue the timeline where the last run stopped. mux.js
                        // otherwise restarts at zero and the new fragments overlap
                        // what is already written.
                        const base = Math.round(
                                playlist.durations.slice(0, resumeFrom).reduce((sum, value) => sum + value, 0) *
                                        MP4_TIMESCALE,
                        );
                        if (base > 0) stream.setBaseMediaDecodeTime(base);
                }
                try {
                        await downloadSegmentsStreaming(
                                playlist,
                                {
                                        concurrency: this.options.segmentConcurrency,
                                        signal,
                                        onProgress,
                                        batchBytes: this.batchBytesFor(playlist),
                                        resumeFrom,
                                        resumeBytes,
                                },
                                async (_index, chunk, writtenThrough) => {
                                        stream.push(chunk);
                                        await stream.flush();
                                        state.segments = writtenThrough;
                                        state.bytes = bytes;
                                        await writePartial(destination, path, state);
                                },
                        );
                        await stream.finish();
                } catch (error) {
                        // Let the writes already queued finish so the file and its
                        // sidecar agree before the failure is reported.
                        await writer.settle();
                        throw error;
                }
                await writer.close();
                await destination.rename(part, path);
                await destination.remove(partialMetaPath(path));
                return bytes;
        }

        /** True when a partial file with recorded progress exists for this job. */
        private async markPartial(job: DownloadJob): Promise<void> {
                try {
                        const destination = this.destinationFor();
                        const path = this.stagingPaths.get(job.id) ?? this.buildPath(job);
                        const state = await readPartial(destination, path);
                        if (state && state.segments > 0) {
                                job.partialFound = true;
                                job.resumeSegments = state.segments;
                                job.resumeBytes = state.bytes;
                                return;
                        }
                } catch {
                        /* Treated as no partial. */
                }
                job.partialFound = false;
        }

        private destinationFor(): Destination {
                if (!this.destination) {
                        this.destination = createDestination(this.app, this.options.destination);
                }
                return this.destination;
        }

        private buildPath(job: DownloadJob): string {
                const extension = this.options.format === 'mp4' ? 'mp4' : 'ts';
                return buildFileName(this.options.filenameTemplate, job, extension);
        }

        /** The file path an episode would be saved to, without a job object. */
        savedPath(episode: EpisodeSummary, seriesTitle: string): string {
                const extension = this.options.format === 'mp4' ? 'mp4' : 'ts';
                return buildFileName(this.options.filenameTemplate, { episode, seriesTitle }, extension);
        }

        /**
         * Which of these episodes are not already saved, so a series download can
         * fill in the gaps rather than fetching the whole series again. An episode
         * that failed and left a `.part` counts as missing: enqueueing it resumes
         * from where it stopped rather than starting over.
         */
        async missingEpisodes(
                seriesTitle: string,
                episodes: EpisodeSummary[],
        ): Promise<EpisodeSummary[]> {
                const destination = this.destinationFor();
                const missing: EpisodeSummary[] = [];
                for (const episode of episodes) {
                        const path = this.savedPath(episode, seriesTitle);
                        const active = this.jobs.some(
                                (job) =>
                                        job.episode.id === episode.id &&
                                        (job.status === 'queued' ||
                                                job.status === 'running' ||
                                                job.status === 'paused' ||
                                                job.status === 'waiting'),
                        );
                        if (!active && !(await destination.exists(path))) missing.push(episode);
                }
                return missing;
        }

        /**
         * Rebuild the queue from staging files left by an earlier session. The job
         * list only lives in memory, and on mobile the app is killed in the
         * background constantly, so without this an interrupted download vanishes
         * from the UI even though its partial is still on disk. Restored jobs are
         * shown as failed-but-resumable, which is exactly the state the queue's
         * Resume action expects.
         *
         * Returns how many jobs were restored.
         */
        async restore(): Promise<number> {
                const destination = this.destinationFor();
                let entries: string[];
                try {
                        entries = await destination.list();
                } catch {
                        return 0;
                }
                let restored = 0;
                for (const entry of entries) {
                        if (!entry.endsWith(PART_META_SUFFIX)) continue;
                        const finalPath = entry.slice(0, -PART_META_SUFFIX.length);
                        if (!finalPath) continue;
                        // A finished file alongside a stale sidecar means the run
                        // got far enough to finalise; the sidecar is junk.
                        if (await destination.exists(finalPath)) {
                                await destination.remove(entry);
                                continue;
                        }
                        const partial = await readPartial(destination, finalPath);
                        if (!partial || partial.segments <= 0) continue;
                        // Only a partial this build could append to is worth
                        // restoring; a format change makes the bytes meaningless.
                        if (partial.format !== this.options.format) continue;
                        const onDisk = await destination.size(partialStatePath(finalPath));
                        if (onDisk === null || onDisk < partial.bytes) continue;
                        if (this.jobs.some((job) => job.episode.id === partial.episodeId)) continue;
                        const episode: EpisodeSummary = {
                                id: partial.episodeId,
                                number: partial.episodeNumber ?? 0,
                                title: partial.episodeTitle ?? '',
                                filler: false,
                                subbed: true,
                                dubbed: false,
                        };
                        const job: DownloadJob = {
                                id: generateId(),
                                seriesTitle: partial.seriesTitle,
                                episode,
                                status: 'failed',
                                completed: partial.segments,
                                total: partial.totalSegments,
                                bytes: partial.bytes,
                                fileSize: null,
                                filePath: destination.displayPath(finalPath),
                                error: 'Interrupted before it finished.',
                                startedAt: null,
                                finishedAt: null,
                                resumed: false,
                                resumeSegments: partial.segments,
                                resumeBytes: partial.bytes,
                                partialFound: true,
                                writtenSegments: partial.segments,
                                writtenBytes: partial.bytes,
                                speed: null,
                                eta: null,
                                retryAt: null,
                                rateLimitRetries: 0,
                                autoRetries: 0,
                        };
                        this.jobs.push(job);
                        this.stagingPaths.set(job.id, finalPath);
                        restored++;
                }
                if (restored > 0) this.scheduleUpdate();
                return restored;
        }

        private scheduleUpdate(): void {
                if (this.updateTimer !== null) return;
                this.updateTimer = window.setTimeout(() => {
                        this.updateTimer = null;
                        this.onUpdate();
                }, 150);
        }

        dispose(): void {
                if (this.updateTimer !== null) {
                        window.clearTimeout(this.updateTimer);
                        this.updateTimer = null;
                }
                for (const timer of this.retryTimers) window.clearTimeout(timer);
                this.retryTimers.clear();
                this.wakeLock.dispose();
                this.cancelAll();
        }
}

export function renderTemplate(
        template: string,
        values: { series: string; episode: number; title: string; ext: string },
): string {
        const padded = String(values.episode).padStart(2, '0');
        const text = template
                .replace(/\{series\}/g, values.series)
                .replace(/\{ep:02\}/g, padded)
                .replace(/\{ep\}/g, String(values.episode))
                .replace(/\{title\}/g, values.title)
                .replace(/\{ext\}/g, values.ext);
        const trimmed = text.trim();
        if (!trimmed) return `episode.${values.ext}`;
        // A template without an extension still needs one for the player to open it.
        return /\.[a-z0-9]{2,4}$/i.test(trimmed) ? trimmed : `${trimmed}.${values.ext}`;
}

/** The sanitized file name for an episode, given the current template. */
function buildFileName(
        template: string,
        job: { episode: EpisodeSummary; seriesTitle: string },
        extension: string,
): string {
        return sanitizeName(
                renderTemplate(template, {
                        series: job.seriesTitle,
                        episode: job.episode.number,
                        title: job.episode.title,
                        ext: extension,
                }),
        );
}

export function describeProgress(job: DownloadJob): string {
        if (job.status === 'queued') return 'Queued';
        if (job.status === 'cancelled') return 'Cancelled';
        if (job.status === 'failed') return job.error ?? 'Failed';
        if (job.status === 'paused') return 'Paused';
        if (job.status === 'waiting') {
                const wait = job.retryAt ? Math.max(0, Math.round((job.retryAt - Date.now()) / 1000)) : 0;
                const reason = job.rateLimitRetries > 0 ? 'Rate limited' : 'Retrying';
                return `${reason} · retrying in ${formatDuration(wait)}`;
        }
        if (job.status === 'done') return `Saved${job.fileSize ? ` · ${formatBytes(job.fileSize)}` : ''}`;
        if (job.total && job.completed !== null) {
                const progress = `${job.completed} / ${job.total} segments · ${formatBytes(job.bytes)}`;
                const rate = job.speed ? ` · ${formatSpeed(job.speed)}` : '';
                const eta = job.eta ? ` · ${formatDuration(job.eta)} left` : '';
                const prefix = job.resumed ? 'Resuming · ' : '';
                return `${prefix}${progress}${rate}${eta}`;
        }
        return 'Starting…';
}

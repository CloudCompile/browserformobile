import type { EpisodeSummary } from './animeApi';
import { loadStream, selectVariant } from './animeApi';
import { createDestination, sanitizeName, type Destination, type DestinationRequest } from './destination';
import {
        DownloadError,
        downloadSegmentsStreaming,
        formatBytes,
        loadMediaPlaylist,
        type MediaPlaylist,
} from './hls';
import { patchDuration, transmux } from './transmux';
import { generateId } from './utils';

/** Bytes coalesced into one write. Appending is costly on mobile. */
const TS_BATCH_BYTES = 8 * 1024 * 1024;
/** Suffix of the staging file holding the raw stream of an unfinished job. */
const PART_SUFFIX = '.part';
/** Suffix of the JSON sidecar describing that staging file. */
const PART_META_SUFFIX = '.part.json';
/** How far a resumed stream may differ in total length before it is discarded. */
const DURATION_TOLERANCE_SECONDS = 1;

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

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
}

function partialStatePath(finalPath: string): string {
        return `${finalPath}${PART_SUFFIX}`;
}

function partialMetaPath(finalPath: string): string {
        return `${finalPath}${PART_META_SUFFIX}`;
}

/** Read a job's sidecar, or null when it is missing or unreadable. */
async function readPartial(
        destination: Destination,
        finalPath: string,
): Promise<PartialState | null> {
        const raw = await destination.read(partialMetaPath(finalPath));
        if (!raw) return null;
        try {
                const parsed = JSON.parse(new TextDecoder().decode(raw)) as PartialState;
                if (parsed.version !== 1) return null;
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
                        if (existing && (existing.status === 'queued' || existing.status === 'running')) {
                                continue;
                        }
                        if (existing && existing.status === 'failed') {
                                existing.status = 'queued';
                                existing.error = null;
                                existing.startedAt = null;
                                existing.finishedAt = null;
                                existing.resumeSegments = 0;
                                existing.resumeBytes = 0;
                                existing.resumed = false;
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
                if (job.status === 'queued') {
                        job.status = 'cancelled';
                        job.finishedAt = Date.now();
                        this.scheduleUpdate();
                        return;
                }
                this.controllers.get(jobId)?.abort();
        }

        cancelAll(): void {
                for (const job of this.jobs) {
                        if (job.status === 'running' || job.status === 'queued') this.cancel(job.id);
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
                return this.jobs.filter((job) => job.status === 'running' || job.status === 'queued').length;
        }

        private pump(): void {
                while (this.running < this.options.maxConcurrentJobs) {
                        const next = this.jobs.find((job) => job.status === 'queued');
                        if (!next) break;
                        void this.run(next);
                }
        }

        private async run(job: DownloadJob): Promise<void> {
                this.running++;
                job.status = 'running';
                job.startedAt = Date.now();
                const controller = new AbortController();
                this.controllers.set(job.id, controller);
                this.scheduleUpdate();

                try {
                        await this.execute(job, controller.signal);
                        job.status = 'done';
                } catch (error) {
                        if (controller.signal.aborted) {
                                job.status = 'cancelled';
                                // An explicit cancel abandons the download, so the
                                // staging file and sidecar are removed rather than
                                // left behind for a resume the user did not ask for.
                                await this.forgetPartial(job);
                        } else {
                                job.status = 'failed';
                                job.error = error instanceof Error ? error.message : String(error);
                                // A failure leaves whatever landed on disk in place
                                // so the queue can offer to continue it.
                                await this.markPartial(job);
                        }
                } finally {
                        job.finishedAt = Date.now();
                        this.controllers.delete(job.id);
                        this.running--;
                        this.scheduleUpdate();
                        this.pump();
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

        private async execute(job: DownloadJob, signal: AbortSignal): Promise<void> {
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
                        if (matches && onDisk === partial.bytes && partial.segments > 0) {
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
                this.scheduleUpdate();

                const onProgress = (progress: { completed: number; bytes: number }): void => {
                        job.completed = progress.completed;
                        job.bytes = progress.bytes;
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
                const writer = await destination.open(part, { append: resumeFrom > 0 });
                const state: PartialState = {
                        version: 1,
                        episodeId: job.episode.id,
                        seriesTitle: job.seriesTitle,
                        format: this.options.format,
                        quality: this.options.quality,
                        totalSegments: playlist.segments.length,
                        durationSeconds: playlist.duration,
                        segments: resumeFrom,
                        bytes: resumeBytes,
                };
                try {
                        await downloadSegmentsStreaming(
                                playlist,
                                {
                                        concurrency: this.options.segmentConcurrency,
                                        signal,
                                        onProgress,
                                        batchBytes: TS_BATCH_BYTES,
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
         * MP4 has to be transmuxed from the whole stream at once, so the raw
         * stream is staged to disk first (which is what makes it resumable) and
         * then converted. mux.js only emits on flush, so the episode is held in
         * memory for the conversion either way; the final file is not built in
         * a second buffer, because the init segment is patched in place and the
         * fragments are written one at a time.
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
                await this.stageSegments(
                        job,
                        destination,
                        path,
                        playlist,
                        signal,
                        onProgress,
                        resumeFrom,
                        resumeBytes,
                );
                const staged = await destination.read(partialStatePath(path));
                if (!staged) throw new DownloadError('The staged stream could not be read back.');
                const result = transmux([staged]);
                const init = result.init ? patchDuration(result.init, playlist.duration) : null;
                const writer = await destination.open(path);
                let written = 0;
                try {
                        if (init) {
                                await writer.write(init);
                                written += init.byteLength;
                        }
                        for (const fragment of result.fragments) {
                                await writer.write(fragment);
                                written += fragment.byteLength;
                        }
                        await writer.close();
                } catch (error) {
                        // The final file is unusable if it is half written, but
                        // the staging file is untouched and stays resumable.
                        await writer.abort();
                        throw error;
                }
                await discardPartial(destination, path);
                return written;
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
                const name = renderTemplate(this.options.filenameTemplate, {
                        series: job.seriesTitle,
                        episode: job.episode.number,
                        title: job.episode.title,
                        ext: extension,
                });
                return sanitizeName(name);
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

export function describeProgress(job: DownloadJob): string {
        if (job.status === 'queued') return 'Queued';
        if (job.status === 'cancelled') return 'Cancelled';
        if (job.status === 'failed') return job.error ?? 'Failed';
        if (job.status === 'done') return `Saved${job.fileSize ? ` · ${formatBytes(job.fileSize)}` : ''}`;
        if (job.total && job.completed !== null) {
                const progress = `${job.completed} / ${job.total} segments · ${formatBytes(job.bytes)}`;
                return job.resumed ? `Resuming · ${progress}` : progress;
        }
        return 'Starting…';
}

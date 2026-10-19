import type { EpisodeSummary } from './animeApi';
import { loadStream, selectVariant } from './animeApi';
import { createDestination, sanitizeName, type Destination, type DestinationRequest } from './destination';
import {
        DownloadError,
        downloadSegments,
        downloadSegmentsStreaming,
        formatBytes,
        loadMediaPlaylist,
        type MediaPlaylist,
} from './hls';
import { assembleMp4, transmux } from './transmux';
import { generateId } from './utils';

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

export class DownloadManager {
        readonly jobs: DownloadJob[] = [];

        private options: DownloaderOptions;
        private destination: Destination | null = null;
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

        /** Enqueue episodes for download, skipping ones already queued or running. */
        enqueue(request: EnqueueRequest): DownloadJob[] {
                const created: DownloadJob[] = [];
                for (const episode of request.episodes) {
                        const duplicate = this.jobs.some(
                                (job) =>
                                        job.episode.id === episode.id &&
                                        (job.status === 'queued' || job.status === 'running'),
                        );
                        if (duplicate) continue;
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
                        };
                        this.jobs.push(job);
                        created.push(job);
                }
                this.scheduleUpdate();
                this.pump();
                return created;
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
                        } else {
                                job.status = 'failed';
                                job.error = error instanceof Error ? error.message : String(error);
                        }
                } finally {
                        job.finishedAt = Date.now();
                        this.controllers.delete(job.id);
                        this.running--;
                        this.scheduleUpdate();
                        this.pump();
                }
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

                job.total = playlist.segments.length;
                job.completed = 0;
                this.scheduleUpdate();

                const destination = this.destinationFor();
                const path = this.buildPath(job);
                const validation = destination.validate(path);
                if (validation) throw new DownloadError(validation);
                if (await destination.exists(path)) {
                        throw new DownloadError(`${destination.displayPath(path)} already exists.`);
                }

                const onProgress = (progress: { completed: number; bytes: number }): void => {
                        job.completed = progress.completed;
                        job.bytes = progress.bytes;
                        this.scheduleUpdate();
                };

                if (this.options.format === 'ts') {
                        await this.writeTs(destination, path, playlist, signal, onProgress);
                } else {
                        await this.writeMp4(destination, path, playlist, signal, onProgress);
                }

                job.filePath = destination.displayPath(path);
                job.fileSize = job.bytes;
        }

        private async writeTs(
                destination: Destination,
                path: string,
                playlist: MediaPlaylist,
                signal: AbortSignal,
                onProgress: (progress: { completed: number; bytes: number }) => void,
        ): Promise<void> {
                const writer = await destination.open(path);
                try {
                        await downloadSegmentsStreaming(
                                playlist,
                                {
                                        concurrency: this.options.segmentConcurrency,
                                        signal,
                                        onProgress,
                                },
                                async (_index, data) => {
                                        await writer.write(data);
                                },
                        );
                        await writer.close();
                } catch (error) {
                        await writer.abort();
                        throw error;
                }
        }

        private async writeMp4(
                destination: Destination,
                path: string,
                playlist: MediaPlaylist,
                signal: AbortSignal,
                onProgress: (progress: { completed: number; bytes: number }) => void,
        ): Promise<void> {
                // mux.js only emits on flush, so the whole episode has to be held
                // in memory before it can be converted.
                const segments = await downloadSegments(playlist, {
                        concurrency: this.options.segmentConcurrency,
                        signal,
                        onProgress,
                });
                if (signal.aborted) throw new DownloadError('Download cancelled.');
                const mp4 = assembleMp4(transmux(segments), playlist.duration);
                const writer = await destination.open(path);
                try {
                        await writer.write(mp4);
                        await writer.close();
                } catch (error) {
                        await writer.abort();
                        throw error;
                }
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
                return `${job.completed} / ${job.total} segments · ${formatBytes(job.bytes)}`;
        }
        return 'Starting…';
}

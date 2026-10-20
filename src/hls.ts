import { requestUrl } from 'obsidian';
import { STREAM_REFERER, resolveUrl } from './animeApi';

/**
 * HLS download engine.
 *
 * The CDN serves plain, unencrypted MPEG-TS segments and only allows its own
 * player origin through CORS, so every fetch goes through Obsidian's native
 * HTTP client (`requestUrl`) rather than the page's `fetch`. Segments are
 * fetched with a small concurrency limit: the CDN starts answering 429 above
 * four parallel requests.
 */

export interface MediaPlaylist {
        /** Absolute segment URLs in playback order. */
        segments: string[];
        /** Total duration in seconds, from the `#EXTINF` values. */
        duration: number;
        /** Target duration, used to bound the request timeout. */
        targetDuration: number;
}

export interface DownloadProgress {
        /** Segments finished, including failed ones. */
        completed: number;
        total: number;
        /** Bytes received so far. */
        bytes: number;
}

export interface DownloadOptions {
        /** Segments fetched in parallel. 3–4 is safe; 5+ triggers HTTP 429. */
        concurrency: number;
        signal?: AbortSignal;
        onProgress?(progress: DownloadProgress): void;
        /**
         * Bytes buffered before a write is issued. Writing each segment on its
         * own is very expensive on mobile, where every append re-reads and
         * rewrites the whole file, so writes are coalesced.
         */
        batchBytes?: number;
        /** Segments already on disk, skipped by a resumed download. */
        resumeFrom?: number;
        /** Bytes already on disk, added to the progress total of a resumed download. */
        resumeBytes?: number;
}

export class DownloadError extends Error {}

const REQUEST_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 5;
/** HTTP codes the CDN returns when it is rate limiting rather than failing. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * `requestUrl` has no timeout option, so race it against a timer. The request
 * itself is not cancelled, but a hung connection no longer stalls a job.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
        let timer: number | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
                timer = window.setTimeout(() => reject(new DownloadError('The request timed out.')), ms);
        });
        try {
                return await Promise.race([promise, timeout]);
        } finally {
                if (timer !== undefined) window.clearTimeout(timer);
        }
}

export function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
        const lines = text.split(/\r?\n/);
        const segments: string[] = [];
        let duration = 0;
        let targetDuration = 0;
        let pendingDuration = 0;
        for (const line of lines) {
                if (!line) continue;
                if (line.startsWith('#EXTINF:')) {
                        pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;
                        continue;
                }
                if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                        targetDuration = Number.parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
                        continue;
                }
                if (line.startsWith('#')) continue;
                segments.push(resolveUrl(line, baseUrl));
                duration += pendingDuration;
                pendingDuration = 0;
        }
        return { segments, duration, targetDuration };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
                if (signal?.aborted) {
                        reject(new DownloadError('Download cancelled.'));
                        return;
                }
                const timer = window.setTimeout(() => {
                        signal?.removeEventListener('abort', onAbort);
                        resolve();
                }, ms);
                const onAbort = () => {
                        window.clearTimeout(timer);
                        reject(new DownloadError('Download cancelled.'));
                };
                signal?.addEventListener('abort', onAbort, { once: true });
        });
}

async function fetchText(url: string): Promise<string> {
        const response = await withTimeout(
                requestUrl({
                        url,
                        method: 'GET',
                        headers: { Referer: STREAM_REFERER },
                        throw: false,
                }),
                REQUEST_TIMEOUT_MS,
        );
        if (response.status >= 400) {
                throw new DownloadError(`HTTP ${response.status} for ${url}`);
        }
        return response.text;
}

async function fetchSegment(url: string, signal?: AbortSignal): Promise<Uint8Array> {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                if (signal?.aborted) throw new DownloadError('Download cancelled.');
                try {
                        const response = await withTimeout(
                                requestUrl({
                                        url,
                                        method: 'GET',
                                        headers: { Referer: STREAM_REFERER },
                                        throw: false,
                                }),
                                REQUEST_TIMEOUT_MS,
                        );
                        if (response.status >= 400) {
                                if (TRANSIENT_STATUS.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
                                        await delay(400 * 2 ** attempt, signal);
                                        continue;
                                }
                                throw new DownloadError(`HTTP ${response.status}`);
                        }
                        return new Uint8Array(response.arrayBuffer);
                } catch (error) {
                        if (error instanceof DownloadError && error.message === 'Download cancelled.') {
                                throw error;
                        }
                        lastError = error;
                        if (attempt < MAX_ATTEMPTS - 1) {
                                await delay(400 * 2 ** attempt, signal);
                                continue;
                        }
                }
        }
        throw new DownloadError(
                `A segment failed after ${MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        );
}

/**
 * Download segments and hand each one to `onSegment` in playlist order as soon
 * as it is available. Only the out-of-order window (bounded by `concurrency`)
 * is held in memory, which is what makes `.ts` output viable on mobile.
 *
 * The callback's `index` is the first segment in the chunk and `writtenThrough`
 * is the number of segments written to the file so far, so a caller can record
 * a resume point that is always a true contiguous prefix.
 *
 * When `resumeFrom` is set, the first `resumeFrom` segments are assumed to be
 * already on disk and are not fetched again.
 */
export async function downloadSegmentsStreaming(
        playlist: MediaPlaylist,
        options: DownloadOptions,
        onSegment: (index: number, data: Uint8Array, writtenThrough: number) => Promise<void> | void,
): Promise<void> {
        const total = playlist.segments.length;
        const resumeFrom = Math.max(0, Math.min(options.resumeFrom ?? 0, total));
        const batchBytes = Math.max(1, options.batchBytes ?? 8 * 1024 * 1024);
        const pending = new Map<number, Uint8Array>();
        let nextToWrite = resumeFrom;
        let completed = resumeFrom;
        let bytes = options.resumeBytes ?? 0;
        let nextToFetch = resumeFrom;
        let buffer: Uint8Array[] = [];
        let bufferLength = 0;
        // Aborts every worker as soon as one fails, so a background worker cannot
        // keep appending after the download has already reported a failure.
        const internal = new AbortController();
        const forwardAbort = (): void => internal.abort();
        options.signal?.addEventListener('abort', forwardAbort, { once: true });

        /**
         * Writes are chained rather than awaited at the call site. Awaiting
         * inside the worker let a later segment's write begin before an earlier
         * one had finished, which reordered the file and — on the very first
         * write — let an append land before the file existed.
         */
        let writes: Promise<void> = Promise.resolve();
        const flushBuffer = (): void => {
                if (buffer.length === 0) return;
                const chunk = concatSegments(buffer);
                const first = nextToWrite - buffer.length;
                const through = nextToWrite;
                buffer = [];
                bufferLength = 0;
                writes = writes.then(() => onSegment(first, chunk, through));
        };

        const worker = async (): Promise<void> => {
                while (true) {
                        const index = nextToFetch++;
                        if (index >= total) return;
                        const url = playlist.segments[index];
                        if (!url) return;
                        const data = await fetchSegment(url, internal.signal);
                        completed++;
                        bytes += data.byteLength;
                        options.onProgress?.({ completed, total, bytes });
                        pending.set(index, data);
                        // Append every segment that is now contiguous. Deciding
                        // the batches here, in order, keeps the file ordered and
                        // coalesces writes so each one is a decent size.
                        while (pending.has(nextToWrite)) {
                                const nextData = pending.get(nextToWrite) as Uint8Array;
                                pending.delete(nextToWrite);
                                buffer.push(nextData);
                                bufferLength += nextData.byteLength;
                                nextToWrite++;
                                if (bufferLength >= batchBytes) flushBuffer();
                        }
                }
        };

        const workers = Math.max(1, Math.min(options.concurrency, total - resumeFrom));
        let failure: Error | null = null;
        try {
                await Promise.all(
                        Array.from({ length: workers }, () =>
                                worker().catch((error: unknown) => {
                                        internal.abort();
                                        throw error;
                                }),
                        ),
                );
        } catch (error) {
                failure = error instanceof Error ? error : new DownloadError(String(error));
        } finally {
                options.signal?.removeEventListener('abort', forwardAbort);
        }

        // Let every write already in the chain finish, even after a failure, so
        // the file and its sidecar are frozen and consistent before the caller
        // records the resume point. The in-memory tail is dropped: it was never
        // written, so a resume re-fetches it.
        await writes.catch(() => undefined);
        if (failure) throw failure;

        flushBuffer();
        await writes;

        // Every segment must have reached the writer, or the file is short and
        // would play as a truncated episode with no indication why.
        if (nextToWrite !== total) {
                throw new DownloadError(`Only ${nextToWrite} of ${total} segments were written.`);
        }
}

/** Resolve a media playlist URL for a chosen variant. */
export async function loadMediaPlaylist(url: string): Promise<MediaPlaylist> {
        const text = await fetchText(url);
        const playlist = parseMediaPlaylist(text, url);
        if (playlist.segments.length === 0) {
                throw new DownloadError('The stream playlist contained no segments.');
        }
        return playlist;
}

/** Concatenate MPEG-TS segments. The result is directly playable as `.ts`. */
export function concatSegments(segments: Uint8Array[]): Uint8Array {
        const total = segments.reduce((sum, segment) => sum + segment.byteLength, 0);
        const output = new Uint8Array(total);
        let offset = 0;
        for (const segment of segments) {
                output.set(segment, offset);
                offset += segment.byteLength;
        }
        return output;
}

export function formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        const units = ['KB', 'MB', 'GB'];
        let value = bytes / 1024;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
                value /= 1024;
                unit++;
        }
        return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

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
 * Download every segment, running `concurrency` requests at a time. Segments
 * are returned in playlist order regardless of the order they finish.
 */
export async function downloadSegments(
        playlist: MediaPlaylist,
        options: DownloadOptions,
): Promise<Uint8Array[]> {
        const total = playlist.segments.length;
        const results = new Array<Uint8Array | null>(total);
        let next = 0;
        let completed = 0;
        let bytes = 0;

        const worker = async (): Promise<void> => {
                while (true) {
                        const index = next++;
                        if (index >= total) return;
                        const url = playlist.segments[index];
                        if (!url) return;
                        const data = await fetchSegment(url, options.signal);
                        results[index] = data;
                        completed++;
                        bytes += data.byteLength;
                        options.onProgress?.({ completed, total, bytes });
                }
        };

        const workers = Math.max(1, Math.min(options.concurrency, total));
        await Promise.all(Array.from({ length: workers }, worker));

        return results.map((data) => {
                if (!data) throw new DownloadError('A segment is missing from the download.');
                return data;
        });
}

/**
 * Download segments and hand each one to `onSegment` in playlist order as soon
 * as it is available. Only the out-of-order window (bounded by `concurrency`)
 * is held in memory, which is what makes `.ts` output viable on mobile.
 */
export async function downloadSegmentsStreaming(
        playlist: MediaPlaylist,
        options: DownloadOptions,
        onSegment: (index: number, data: Uint8Array) => Promise<void> | void,
): Promise<void> {
        const total = playlist.segments.length;
        const pending = new Map<number, Uint8Array>();
        let nextToWrite = 0;
        let completed = 0;
        let bytes = 0;
        let nextToFetch = 0;

        const flush = async (): Promise<void> => {
                while (pending.has(nextToWrite)) {
                        const data = pending.get(nextToWrite) as Uint8Array;
                        pending.delete(nextToWrite);
                        nextToWrite++;
                        await onSegment(nextToWrite - 1, data);
                }
        };

        const worker = async (): Promise<void> => {
                while (true) {
                        const index = nextToFetch++;
                        if (index >= total) return;
                        const url = playlist.segments[index];
                        if (!url) return;
                        const data = await fetchSegment(url, options.signal);
                        completed++;
                        bytes += data.byteLength;
                        options.onProgress?.({ completed, total, bytes });
                        pending.set(index, data);
                        await flush();
                }
        };

        const workers = Math.max(1, Math.min(options.concurrency, total));
        await Promise.all(Array.from({ length: workers }, worker));
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

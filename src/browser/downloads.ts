import { Notice } from 'obsidian';
import { createDestination, sanitizePath, type Destination, type FileWriter } from '../destination';
import { downloadSegmentsStreaming, formatBytes, formatSpeed, parseMediaPlaylist } from '../hls';
import { mdatHeader, parseFragments, ProgressiveMp4Builder } from '../mp4';
import { TransmuxStream } from '../transmux';
import { generateId } from '../utils';
import { decodeText, headerValue, nativeRequest, type NativeResponse } from './http';
import {
	filenameFor,
	kindForUrl,
	normalizeDirectUrl,
	parseContentRange,
	type BrowserMediaKind,
} from './media';

/** A direct-file or HLS download owned by the browser. */
export interface BrowserDownloadRequest {
	url: string;
	filename?: string;
	/** Vault-relative folder. Defaults to the browser download folder. */
	folder?: string;
	/** Page URL used as the Referer, which many CDNs require. */
	referer?: string;
	kind?: BrowserMediaKind;
	mime?: string;
}

export type BrowserDownloadStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BrowserDownloadJob {
	id: string;
	url: string;
	filename: string;
	folder: string;
	kind: BrowserMediaKind;
	status: BrowserDownloadStatus;
	bytes: number;
	totalBytes: number | null;
	completedSegments: number | null;
	totalSegments: number | null;
	speed: number | null;
	error: string | null;
	filePath: string | null;
	startedAt: number | null;
	finishedAt: number | null;
	/** The name the user asked for, before the server's headers were read. */
	requestedFilename: string;
	referer?: string;
}

const CHUNK_BYTES = 8 * 1024 * 1024;
const HLS_CONCURRENCY = 4;
const MAX_ATTEMPTS = 4;
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('Download cancelled.'));
			return;
		}
		const timer = window.setTimeout(() => {
			signal?.removeEventListener('abort', abort);
			resolve();
		}, ms);
		const abort = (): void => {
			window.clearTimeout(timer);
			reject(new Error('Download cancelled.'));
		};
		signal?.addEventListener('abort', abort, { once: true });
	});
}

function folderName(folder: string): string {
	return sanitizePath(folder.trim()).replace(/^\/+|\/+$/g, '');
}

function statusError(status: number): Error {
	return new Error(`HTTP ${status}`);
}

export class BrowserDownloadManager {
	readonly jobs: BrowserDownloadJob[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly controllers = new Map<string, AbortController>();
	private running = false;
	private notifyTimer: number | null = null;
	private lastNotify = 0;

	constructor(
		private readonly app: { vault: { adapter: unknown } },
		private readonly defaultFolder: () => string,
		private readonly userAgent: () => string,
		private readonly onDebug?: (message: string, details?: unknown) => void,
	) {}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
		if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
		this.notifyTimer = null;
		this.listeners.clear();
	}

	enqueue(request: BrowserDownloadRequest): BrowserDownloadJob {
		const url = normalizeDirectUrl(request.url);
		if (!url) throw new Error('Enter an http(s) URL.');
		const kind = request.kind ?? kindForUrl(url, request.mime);
		const folder = folderName(request.folder ?? this.defaultFolder());
		const job: BrowserDownloadJob = {
			id: generateId(),
			url,
			filename: filenameFor(request.filename, url, request.mime, undefined, kind),
			requestedFilename: request.filename?.trim() ?? '',
			folder,
			kind,
			status: 'queued',
			bytes: 0,
			totalBytes: null,
			completedSegments: null,
			totalSegments: null,
			speed: null,
			error: null,
			filePath: null,
			startedAt: null,
			finishedAt: null,
			referer: request.referer,
		};
		this.jobs.unshift(job);
		this.notify(true);
		void this.pump();
		return job;
	}

	cancel(id: string): void {
		const job = this.jobs.find((entry) => entry.id === id);
		if (!job) return;
		if (job.status === 'queued') {
			job.status = 'cancelled';
			job.finishedAt = Date.now();
			this.notify(true);
			return;
		}
		if (job.status !== 'running') return;
		this.controllers.get(id)?.abort();
		job.status = 'cancelled';
		job.finishedAt = Date.now();
		this.notify(true);
	}

	clearFinished(): void {
		for (let index = this.jobs.length - 1; index >= 0; index--) {
			const job = this.jobs[index];
			if (!job) continue;
			if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
				this.jobs.splice(index, 1);
			}
		}
		this.notify(true);
	}

	private debug(message: string, details?: unknown): void {
		this.onDebug?.(message, details);
	}

	private notify(immediate = false): void {
		const emit = (): void => {
			this.notifyTimer = null;
			this.lastNotify = Date.now();
			for (const listener of this.listeners) {
				try {
					listener();
				} catch {
					/* A closed view must not stop a download. */
				}
			}
		};
		if (immediate) {
			if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
			this.notifyTimer = null;
			emit();
			return;
		}
		const wait = Math.max(0, 150 - (Date.now() - this.lastNotify));
		if (this.notifyTimer !== null) return;
		this.notifyTimer = window.setTimeout(emit, wait);
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		const next = this.jobs.find((job) => job.status === 'queued');
		if (!next) return;
		this.running = true;
		try {
			await this.run(next);
		} finally {
			this.running = false;
			void this.pump();
		}
	}

	private async run(job: BrowserDownloadJob): Promise<void> {
		job.status = 'running';
		job.startedAt = Date.now();
		const controller = new AbortController();
		this.controllers.set(job.id, controller);
		this.notify(true);
		this.debug('browser.download.start', { kind: job.kind, url: job.url, filename: job.filename });
		try {
			const destination = createDestination(this.app, { external: false, folder: job.folder });
			if (job.kind === 'hls') await this.downloadHls(job, destination, controller.signal);
			else await this.downloadDirect(job, destination, controller.signal);
			if ((job.status as BrowserDownloadStatus) === 'cancelled') return;
			job.status = 'done';
			job.finishedAt = Date.now();
			job.speed = null;
			this.notify(true);
			new Notice(`Downloaded ${job.filename} to ${job.filePath ?? (job.folder || 'the vault root')}.`);
			this.debug('browser.download.done', {
				url: job.url,
				filename: job.filename,
				bytes: job.bytes,
			});
		} catch (error) {
			if ((job.status as BrowserDownloadStatus) === 'cancelled' || controller.signal.aborted) {
				job.status = 'cancelled';
				job.finishedAt = Date.now();
				this.notify(true);
				this.debug('browser.download.cancelled', { url: job.url });
				return;
			}
			job.status = 'failed';
			job.finishedAt = Date.now();
			job.speed = null;
			job.error = error instanceof Error ? error.message : String(error);
			this.notify(true);
			new Notice(`Download failed: ${job.error}`, 8000);
			this.debug('browser.download.failed', { url: job.url, error: job.error });
		} finally {
			this.controllers.delete(job.id);
		}
	}

	private headers(job: BrowserDownloadJob, extra: Record<string, string> = {}): Record<string, string> {
		const headers: Record<string, string> = {
			'user-agent': this.userAgent(),
			accept: '*/*',
			// Ranges describe stored bytes; asking for compression would make
			// the offsets disagree with the file on disk.
			'accept-encoding': 'identity',
			...extra,
		};
		if (job.referer) headers.referer = job.referer;
		return headers;
	}

	private async fetchRange(
		url: string,
		start: number,
		end: number,
		headers: Record<string, string>,
		signal: AbortSignal,
	): Promise<NativeResponse> {
		let lastError: unknown = null;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			if (signal.aborted) throw new Error('Download cancelled.');
			try {
				const response = await nativeRequest({
					url,
					method: 'GET',
					headers: { ...headers, range: `bytes=${start}-${end}` },
					body: null,
				});
				if (TRANSIENT_STATUS.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
					await sleep(800 * 2 ** attempt, signal);
					continue;
				}
				return response;
			} catch (error) {
				lastError = error;
				if (attempt < MAX_ATTEMPTS - 1) {
					await sleep(800 * 2 ** attempt, signal);
					continue;
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error('The request failed.');
	}

	private async fetchFull(
		url: string,
		headers: Record<string, string>,
		signal: AbortSignal,
	): Promise<NativeResponse> {
		let lastError: unknown = null;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			if (signal.aborted) throw new Error('Download cancelled.');
			try {
				const response = await nativeRequest({ url, method: 'GET', headers, body: null });
				if (TRANSIENT_STATUS.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
					await sleep(800 * 2 ** attempt, signal);
					continue;
				}
				return response;
			} catch (error) {
				lastError = error;
				if (attempt < MAX_ATTEMPTS - 1) {
					await sleep(800 * 2 ** attempt, signal);
					continue;
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error('The request failed.');
	}

	private async fetchText(
		url: string,
		headers: Record<string, string>,
		signal: AbortSignal,
	): Promise<{ text: string; url: string }> {
		const response = await this.fetchFull(url, headers, signal);
		if (response.status >= 400) throw statusError(response.status);
		return {
			text: decodeText(response.bytes, response.headers['content-type']),
			url: response.url || url,
		};
	}

	private async uniqueName(destination: Destination, wanted: string): Promise<string> {
		if (!(await destination.exists(wanted))) return wanted;
		const dot = wanted.lastIndexOf('.');
		const base = dot > 0 ? wanted.slice(0, dot) : wanted;
		const extension = dot > 0 ? wanted.slice(dot) : '';
		for (let index = 2; index < 1000; index++) {
			const candidate = `${base} (${index})${extension}`;
			if (!(await destination.exists(candidate))) return candidate;
		}
		return `${base} (${Date.now()})${extension}`;
	}

	private progress(job: BrowserDownloadJob, bytes: number, total: number | null = job.totalBytes): void {
		job.bytes = bytes;
		job.totalBytes = total;
		if (job.startedAt) {
			const seconds = Math.max(0.25, (Date.now() - job.startedAt) / 1000);
			job.speed = bytes / seconds;
		}
		this.notify();
	}

	private async downloadDirect(
		job: BrowserDownloadJob,
		destination: Destination,
		signal: AbortSignal,
	): Promise<void> {
		const first = await this.fetchRange(job.url, 0, CHUNK_BYTES - 1, this.headers(job), signal);
		if (first.status >= 400) throw statusError(first.status);
		const contentType = headerValue(first.headers, 'content-type');
		const disposition = headerValue(first.headers, 'content-disposition');
		const finalUrl = first.url || job.url;
		const kind = kindForUrl(finalUrl, contentType);
		if (kind !== 'file') job.kind = kind;
		const name = await this.uniqueName(
			destination,
			filenameFor(job.requestedFilename, finalUrl, contentType, disposition, job.kind),
		);
		job.filename = name;
		const part = `${name}.part`;
		await destination.remove(part);
		let writer: FileWriter | null = null;
		try {
			writer = await destination.open(part);
			const range = parseContentRange(headerValue(first.headers, 'content-range'));
			let total = range?.total ?? null;
			if (first.status === 200) {
				total = first.bytes.length;
				await writer.write(first.bytes);
				this.progress(job, first.bytes.length, total);
			} else {
				await writer.write(first.bytes);
				let offset = first.bytes.length;
				if (range && range.start !== 0) {
					throw new Error('The server returned the wrong byte range.');
				}
				this.progress(job, offset, total);
				while (total === null || offset < total) {
					if (signal.aborted) throw new Error('Download cancelled.');
					const end = total === null ? offset + CHUNK_BYTES - 1 : Math.min(offset + CHUNK_BYTES - 1, total - 1);
					const response = await this.fetchRange(job.url, offset, end, this.headers(job), signal);
					if (response.status === 416) {
						if (total !== null && offset >= total) break;
						throw statusError(416);
					}
					if (response.status >= 400) throw statusError(response.status);
					if (response.status === 200) {
						throw new Error('The server does not support resuming this file.');
					}
					const nextRange = parseContentRange(headerValue(response.headers, 'content-range'));
					if (nextRange?.total !== null && nextRange?.total !== undefined) total = nextRange.total;
					if (nextRange && nextRange.start !== offset) {
						throw new Error('The server returned the wrong byte range.');
					}
					if (response.bytes.length === 0) break;
					await writer.write(response.bytes);
					offset += response.bytes.length;
					this.progress(job, offset, total ?? (response.bytes.length < CHUNK_BYTES ? offset : null));
					if (nextRange === null && response.bytes.length < CHUNK_BYTES) break;
				}
			}
			await writer.close();
			writer = null;
			await destination.rename(part, name);
			job.filePath = destination.displayPath(name);
			job.bytes = total ?? job.bytes;
			this.notify(true);
		} catch (error) {
			if (writer) {
				await writer.settle();
				await writer.abort();
			}
			throw error;
		}
	}

	private chooseVariant(text: string, baseUrl: string): string | null {
		const lines = text.split(/\r?\n/);
		let bestUrl: string | null = null;
		let bestBandwidth = -1;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? '';
			if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
			const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(line)?.[1] ?? 0);
			let next = index + 1;
			while (next < lines.length && (!lines[next] || (lines[next] ?? '').startsWith('#'))) next++;
			const uri = lines[next];
			if (!uri) continue;
			if (bandwidth > bestBandwidth) {
				bestBandwidth = bandwidth;
				try {
					bestUrl = new URL(uri, baseUrl).href;
				} catch {
					/* Try the next variant. */
				}
			}
		}
		return bestUrl;
	}

	private async resolvePlaylist(
		url: string,
		headers: Record<string, string>,
		signal: AbortSignal,
	): Promise<{ url: string; text: string }> {
		let current = url;
		for (let depth = 0; depth < 4; depth++) {
			const file = await this.fetchText(current, headers, signal);
			if (!file.text.includes('#EXT-X-STREAM-INF')) return file;
			const next = this.chooseVariant(file.text, file.url);
			if (!next) throw new Error('The HLS playlist has no playable variant.');
			current = next;
		}
		throw new Error('The HLS playlist nests too deeply.');
	}

	private async downloadHls(
		job: BrowserDownloadJob,
		destination: Destination,
		signal: AbortSignal,
	): Promise<void> {
		const headers = this.headers(job);
		const file = await this.resolvePlaylist(job.url, headers, signal);
		if (/#EXT-X-KEY:[^\n]*METHOD=(?!NONE)/i.test(file.text)) {
			throw new Error('Encrypted HLS streams are not supported.');
		}
		if (/#EXT-X-MAP:/i.test(file.text)) {
			throw new Error('Fragmented HLS streams are not supported yet.');
		}
		const playlist = parseMediaPlaylist(file.text, file.url);
		if (playlist.segments.length === 0) throw new Error('The HLS playlist has no segments.');
		const name = await this.uniqueName(
			destination,
			filenameFor(job.requestedFilename, file.url, 'video/mp4', undefined, 'hls'),
		);
		job.filename = name;
		const part = `${name}.part`;
		await destination.remove(part);
		const writer = await destination.open(part);
		const mp4: { builder: ProgressiveMp4Builder | null } = { builder: null };
		let bytes = 0;
		const stream = new TransmuxStream(
			async (init) => {
				const builder = new ProgressiveMp4Builder(init);
				mp4.builder = builder;
				await writer.write(builder.ftyp);
				bytes += builder.ftyp.byteLength;
			},
			async (fragment) => {
				const builder = mp4.builder;
				if (!builder) throw new Error('The stream could not be converted to MP4.');
				for (const parsed of parseFragments(fragment)) {
					await writer.write(mdatHeader(parsed.media.byteLength));
					await writer.write(parsed.media);
					bytes += 8 + parsed.media.byteLength;
				}
			},
		);
		try {
			await downloadSegmentsStreaming(
				playlist,
				{
					concurrency: HLS_CONCURRENCY,
					signal,
					batchBytes: 8 * 1024 * 1024,
					headers,
					onProgress: (progress) => {
						job.completedSegments = progress.completed;
						job.totalSegments = progress.total;
						job.bytes = bytes;
						this.notify();
					},
				},
				async (_index, chunk) => {
					stream.push(chunk);
					await stream.flush();
				},
			);
			await stream.finish();
			const builder = mp4.builder;
			if (!builder) throw new Error('The stream could not be converted to MP4.');
			const movie = builder.buildMoov();
			await writer.write(movie);
			bytes += movie.byteLength;
			await writer.close();
			await destination.rename(part, name);
			job.bytes = bytes;
			job.filePath = destination.displayPath(name);
			this.notify(true);
		} catch (error) {
			await writer.settle();
			await writer.abort();
			throw error;
		}
	}
}

/** A compact summary for the browser's download tray. */
export function downloadSummary(job: BrowserDownloadJob): string {
	if (job.status === 'queued') return 'Queued';
	if (job.status === 'cancelled') return 'Cancelled';
	if (job.status === 'failed') return job.error ?? 'Failed';
	if (job.status === 'done') return formatBytes(job.bytes);
	if (job.totalSegments) return `${job.completedSegments ?? 0}/${job.totalSegments} segments`;
	if (job.totalBytes) return `${formatBytes(job.bytes)} of ${formatBytes(job.totalBytes)}`;
	return formatBytes(job.bytes);
}

/** Percent complete, or null while the total is unknown. */
export function downloadPercent(job: BrowserDownloadJob): number | null {
	if (job.status === 'done') return 100;
	if (job.totalBytes && job.totalBytes > 0) return Math.min(100, Math.round((job.bytes / job.totalBytes) * 100));
	if (job.totalSegments && job.totalSegments > 0) {
		return Math.min(100, Math.round(((job.completedSegments ?? 0) / job.totalSegments) * 100));
	}
	return null;
}

export function downloadSpeed(job: BrowserDownloadJob): string {
	return job.speed ? `${formatSpeed(job.speed)}` : '';
}

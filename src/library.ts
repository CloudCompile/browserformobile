import { formatBytes, formatDuration } from './hls';
import { mapWithConcurrency, scanFiles } from './utils';

/**
 * The local video library.
 *
 * Downloaded episodes are ordinary files in the vault, so the library is a
 * scan of the download folder rather than a separate database. The only state
 * it owns is per-file watch progress, which is keyed by path so it survives a
 * rename only if the file is not renamed.
 */

/** How far into a file the viewer got. */
export interface WatchRecord {
	/** Seconds into the video, from the last save. */
	position: number;
	/** Total length in seconds, once the player has read it. */
	duration: number;
	/** Epoch milliseconds of the last save. */
	updatedAt: number;
}

/** One playable file on disk. */
export interface LibraryEntry {
	/** Vault-relative path. Doubles as the progress key. */
	path: string;
	/** File name without the folder. */
	name: string;
	/** Series the file belongs to, or an empty string when unknown. */
	series: string;
	/** Episode number, or 0 when the name did not carry one. */
	episode: number;
	/** Episode title, or an empty string when unknown. */
	title: string;
	/** Lowercase extension without the dot. */
	ext: string;
	/** Size in bytes, or 0 when the adapter did not report one. */
	size: number;
	/** Last modified, in epoch milliseconds, or 0 when unknown. */
	modified: number;
}

/** A file plus its progress, as the UI consumes it. */
export interface LibraryItem extends LibraryEntry {
	progress: WatchRecord | null;
	/** True once the viewer has reached the end. */
	watched: boolean;
}

/**
 * How close to the end counts as finished. A file is rarely played to the last
 * frame — credits are skipped — so the threshold is deliberately loose.
 */
const WATCHED_RATIO = 0.95;

/** Seconds from the end that also count as finished, for very short clips. */
const WATCHED_TAIL_SECONDS = 30;

const VIDEO_EXTENSIONS = new Set(['mp4', 'ts']);

/**
 * `stat` calls in flight during a scan. Each is a round-trip; a handful at once
 * turns a large folder from one latency per file into one per batch, without
 * swamping a phone's storage layer.
 */
const STAT_CONCURRENCY = 8;

interface VaultAdapter {
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	exists(path: string): Promise<boolean>;
	stat(path: string): Promise<{ size: number; mtime: number } | null>;
}

/** Token names the filename template understands. */
const TOKEN = /\{(series|ep|ep:02|title|ext)\}/g;

function escapeLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cached compiled templates. `parseEntryName` runs per file on every scan, so
 * recompiling the same pattern for each file was pure waste — a few hundred
 * files meant a few hundred compilations per library open. A template always
 * produces the same pattern, so caching by template is always safe.
 */
const NAME_REGEX_CACHE = new Map<string, RegExp | null>();

/** Bound on cached templates; they come from settings, so this only grows if
 * the setting is edited repeatedly. */
const MAX_TEMPLATE_CACHE = 32;

/**
 * Turn a filename template into a matcher that recovers its parts. The template
 * is the same one the downloader writes with, so a file the plugin produced
 * always parses; a file dropped in by hand matches only if it happens to fit.
 * Returns null when the template has no tokens to capture.
 */
export function buildNameRegex(template: string): RegExp | null {
	const cached = NAME_REGEX_CACHE.get(template);
	if (cached !== undefined) return cached;
	const built = compileNameRegex(template);
	if (NAME_REGEX_CACHE.size >= MAX_TEMPLATE_CACHE) {
		const oldest = NAME_REGEX_CACHE.keys().next().value;
		if (oldest !== undefined) NAME_REGEX_CACHE.delete(oldest);
	}
	NAME_REGEX_CACHE.set(template, built);
	return built;
}

function compileNameRegex(template: string): RegExp | null {
	let pattern = '';
	let last = 0;
	let tokens = 0;
	const scan = new RegExp(TOKEN.source, 'g');
	let match: RegExpExecArray | null;
	while ((match = scan.exec(template))) {
		pattern += escapeLiteral(template.slice(last, match.index));
		const token = match[1];
		if (token === 'ext') pattern += '(?<ext>[A-Za-z0-9]+)';
		else if (token === 'ep' || token === 'ep:02') pattern += '(?<ep>\\d+)';
		else if (token === 'series') pattern += '(?<series>.+?)';
		else pattern += '(?<title>.+?)';
		last = match.index + match[0].length;
		tokens++;
	}
	pattern += escapeLiteral(template.slice(last));
	if (tokens === 0) return null;
	try {
		return new RegExp(`^${pattern}$`);
	} catch {
		return null;
	}
}

export interface ParsedName {
	series: string;
	episode: number;
	title: string;
}

/**
 * Recover the series, episode, and title from a file name. A name that does not
 * match the template is kept whole as the title, so nothing disappears from the
 * library just because the template changed.
 */
export function parseEntryName(name: string, template: string): ParsedName {
	const regex = buildNameRegex(template);
	// Match the whole name, extension included: the template's `{ext}` token is
	// what consumes it, and a template without one still matches a bare name.
	const match = regex?.exec(name);
	const groups = match?.groups;
	if (!groups) return { series: '', episode: 0, title: name.replace(/\.[a-z0-9]+$/i, '') };
	const episode = Number.parseInt(groups.ep ?? '', 10);
	return {
		series: (groups.series ?? '').trim(),
		episode: Number.isFinite(episode) ? episode : 0,
		title: (groups.title ?? '').trim(),
	};
}

/** A staging file is an unfinished download, not an episode. */
function isVideo(path: string): boolean {
	if (path.endsWith('.part') || path.endsWith('.part.json')) return false;
	const name = path.slice(path.lastIndexOf('/') + 1);
	const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
	return VIDEO_EXTENSIONS.has(ext);
}

export class VideoLibrary {
	entries: LibraryEntry[] = [];

	/**
	 * Whether the last `refresh` saw the whole folder. False means "unknown",
	 * not "empty", and anything that deletes state by absence must respect it.
	 */
	private scanComplete = false;

	private readonly progress = new Map<string, WatchRecord>();

	/** Load persisted progress. Keys are vault paths. */
	load(records: Record<string, WatchRecord> | null | undefined): void {
		this.progress.clear();
		if (!records || typeof records !== 'object') return;
		for (const [path, record] of Object.entries(records)) {
			if (!record || typeof record !== 'object') continue;
			const position = Number(record.position);
			const duration = Number(record.duration);
			if (!Number.isFinite(position) || position < 0) continue;
			this.progress.set(path, {
				position,
				duration: Number.isFinite(duration) ? duration : 0,
				updatedAt: Number(record.updatedAt) || 0,
			});
		}
	}

	toJSON(): Record<string, WatchRecord> {
		return Object.fromEntries(this.progress);
	}

	/**
	 * Rebuild the entry list from the folder.
	 *
	 * Each file needs a `stat`, which is a round-trip, so they run with bounded
	 * concurrency: awaiting them one at a time made opening the library cost one
	 * latency per file, which is what made a large folder slow.
	 *
	 * `complete` reports whether the walk saw the whole tree. Callers that delete
	 * state based on absence must check it — see `prune`.
	 */
	async refresh(
		adapter: VaultAdapter,
		folder: string,
		template: string,
	): Promise<{ complete: boolean }> {
		const scan = await scanFiles(adapter, folder, isVideo);
		const entries = await mapWithConcurrency(scan.files, STAT_CONCURRENCY, async (path) => {
			const name = path.slice(path.lastIndexOf('/') + 1);
			const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
			const parsed = parseEntryName(name, template);
			let size = 0;
			let modified = 0;
			try {
				const stat = await adapter.stat(path);
				size = stat?.size ?? 0;
				modified = stat?.mtime ?? 0;
			} catch {
				/* A file that vanished mid-scan keeps its entry, with no size. */
			}
			return { path, name, ext, size, modified, ...parsed };
		});
		entries.sort(compareEntries);
		this.entries = entries;
		this.scanComplete = scan.complete;
		return { complete: scan.complete };
	}

	/** Entries with their progress attached, in display order. */
	items(): LibraryItem[] {
		return this.entries.map((entry) => ({
			...entry,
			progress: this.progress.get(entry.path) ?? null,
			watched: this.isWatched(entry.path),
		}));
	}

	getProgress(path: string): WatchRecord | null {
		return this.progress.get(path) ?? null;
	}

	/**
	 * Record how far the viewer got. A position at the very start is treated
	 * as "not started" and dropped, so an accidental tap does not leave a
	 * stray resume point.
	 */
	record(path: string, position: number, duration: number): void {
		if (!Number.isFinite(position) || position < 1) {
			this.progress.delete(path);
			return;
		}
		this.progress.set(path, {
			position,
			duration: Number.isFinite(duration) ? duration : 0,
			updatedAt: Date.now(),
		});
	}

	clearProgress(path: string): void {
		this.progress.delete(path);
	}

	isWatched(path: string): boolean {
		const record = this.progress.get(path);
		if (!record || record.duration <= 0) return false;
		if (record.position >= record.duration - WATCHED_TAIL_SECONDS) return true;
		return record.position / record.duration >= WATCHED_RATIO;
	}

	/**
	 * Drop progress for files that are no longer on disk.
	 *
	 * Only runs after a *complete* scan. An incomplete walk — the folder was
	 * renamed, the vault is not mounted, the adapter threw — reports no files,
	 * which is indistinguishable from an empty folder unless you ask. Pruning on
	 * that would delete the watch position of every episode at once. Losing one
	 * resume point is small; losing all of them because a folder was briefly
	 * unavailable is not.
	 */
	prune(): void {
		if (!this.scanComplete) return;
		const present = new Set(this.entries.map((entry) => entry.path));
		for (const path of [...this.progress.keys()]) {
			if (!present.has(path)) this.progress.delete(path);
		}
	}
}

/** Newest first, then by series and episode so a folder reads in order. */
function compareEntries(a: LibraryEntry, b: LibraryEntry): number {
	if (b.modified !== a.modified) return b.modified - a.modified;
	const series = a.series.localeCompare(b.series);
	if (series !== 0) return series;
	if (a.episode !== b.episode) return a.episode - b.episode;
	return a.name.localeCompare(b.name);
}

/** `Series · Episode 3` or the file name when the series is unknown. */
export function describeEntry(entry: LibraryEntry): string {
	const parts: string[] = [];
	if (entry.series) parts.push(entry.series);
	if (entry.episode > 0) parts.push(`Episode ${entry.episode}`);
	else if (entry.title) parts.push(entry.title);
	return parts.join(' · ') || entry.name;
}

/** A short status line: size, length, and how far in the viewer is. */
export function describeEntryMeta(item: LibraryItem): string {
	const parts: string[] = [];
	if (item.size > 0) parts.push(formatBytes(item.size));
	if (item.progress && item.progress.duration > 0) {
		parts.push(formatDuration(item.progress.duration));
	}
	if (item.watched) parts.push('Watched');
	else if (item.progress && item.progress.position > 1) {
		parts.push(`Resume at ${formatDuration(item.progress.position)}`);
	}
	parts.push(item.ext.toUpperCase());
	return parts.join(' · ');
}

/** How far through the file the viewer is, as a 0–1 fraction. */
export function watchFraction(item: LibraryItem): number {
	const record = item.progress;
	if (!record || record.duration <= 0) return 0;
	return Math.max(0, Math.min(1, record.position / record.duration));
}

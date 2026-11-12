/**
 * Persistent series metadata, separate from the API's TTL cache.
 *
 * The TTL cache answers "what did the API say recently"; this store answers
 * "what has this series ever looked like". A details page browsed once is kept
 * until evicted by size or age, so the details modal, the poster grid, and the
 * library rows all have something to show when the API is unreachable — which
 * is exactly when someone on a train wants to pick what to watch next.
 *
 * The store holds catalogue text and poster URLs on the device, nothing more:
 * no vault contents, no watch history, nothing the plugin did not already
 * fetch. Bounded both ways (entries and bytes, oldest saved first evicted), so
 * a browsing history cannot grow without end.
 *
 * No Obsidian import here: the store is pure data, and the test suite holds it
 * against plain objects.
 */

import type { Recommendation } from './recommend';

/** One series' kept details answer. */
export interface SeriesMetadata {
	/** Lowercased series key, matching how library rows and details look up. */
	key: string;
	/** Display title, from the payload's own detail block. */
	title: string;
	/** Poster URL, when the payload carried one. */
	poster: string | null;
	/** The details answer itself, verbatim — the stale-while-revalidate copy. */
	payload: unknown;
	/** Epoch milliseconds of the last write; the eviction order. */
	savedAt: number;
	/** Serialized size, so a few huge payloads cannot outgrow the byte cap. */
	bytes: number;
}

/** Bound on kept series, so a browsing history cannot grow forever. */
export const MAX_METADATA_ENTRIES = 200;

/**
 * Bound on the serialized payload bytes kept. Two megabytes of catalogue text
 * is roughly the payload of a hundred well-fleshed-out series; per-entry bytes
 * are measured when written, so the cap is honest even for payloads with long
 * synopses or big cast lists.
 */
export const MAX_METADATA_BYTES = 2_000_000;

/** Read the payload's display title, or null when it does not carry one. */
function detailTitle(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const detail = (payload as Record<string, unknown>).detail;
	if (!detail || typeof detail !== 'object') return null;
	const title = (detail as Record<string, unknown>).title;
	return typeof title === 'string' && title.trim() !== '' ? title : null;
}

/** Read the payload's poster URL, or null when it does not carry one. */
function detailPoster(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const detail = (payload as Record<string, unknown>).detail;
	if (!detail || typeof detail !== 'object') return null;
	const record = detail as Record<string, unknown>;
	const image =
		typeof record.image === 'string' && record.image !== ''
			? record.image
			: typeof record.poster === 'string' && record.poster !== ''
				? record.poster
				: null;
	return image && /^https?:\/\//i.test(image) ? image : null;
}

/** Measure a payload the way it will be persisted. */
function measurePayload(payload: unknown): number {
	try {
		return JSON.stringify(payload ?? null)?.length ?? 0;
	} catch {
		return 0;
	}
}

/** Coerce a persisted record into usable metadata, or null when unusable. */
export function parseMetadata(value: unknown): SeriesMetadata | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const key = typeof raw.key === 'string' ? raw.key : '';
	if (key === '' || raw.payload === undefined || raw.payload === null) return null;
	const savedAt = Number(raw.savedAt);
	return {
		key,
		title: typeof raw.title === 'string' ? raw.title : key,
		poster: typeof raw.poster === 'string' ? raw.poster : null,
		payload: raw.payload,
		savedAt: Number.isFinite(savedAt) ? savedAt : 0,
		bytes: Number(raw.bytes) > 0 ? Number(raw.bytes) : measurePayload(raw.payload),
	};
}

/**
 * Drop entries until both bounds hold. Oldest `savedAt` first: those are the
 * furthest from whatever the viewer last touched, and the TTL cache will still
 * answer for recently browsed series anyway.
 */
export function pruneMetadata(
	entries: Map<string, SeriesMetadata>,
	maxEntries = MAX_METADATA_ENTRIES,
	maxBytes = MAX_METADATA_BYTES,
): void {
	const ordered = [...entries.values()].sort((a, b) => a.savedAt - b.savedAt);
	let total = ordered.reduce((sum, entry) => sum + entry.bytes, 0);
	for (const entry of ordered) {
		if (entries.size <= maxEntries && total <= maxBytes) break;
		entries.delete(entry.key);
		total -= entry.bytes;
	}
}

/**
 * The store itself: a map plus the two bounds, nothing clever. Lookups are map
 * reads, so a library render costs nothing per row — never a network call and
 * never an adapter read.
 */
export class MetadataStore {
	private entries = new Map<string, SeriesMetadata>();

	/**
	 * Keep a details answer for a series. Writing the same key again replaces
	 * the entry and refreshes its eviction age; the bounds are re-applied on
	 * every write.
	 */
	set(seriesKey: string, payload: unknown): SeriesMetadata | null {
		const key = (seriesKey ?? '').trim().toLowerCase();
		if (key === '' || !payload || typeof payload !== 'object') return null;
		const entry: SeriesMetadata = {
			key,
			title: detailTitle(payload) ?? seriesKey,
			poster: detailPoster(payload),
			payload,
			savedAt: Date.now(),
			bytes: measurePayload(payload),
		};
		// Delete first, so a replacement moves to the back of the eviction order.
		this.entries.delete(key);
		this.entries.set(key, entry);
		pruneMetadata(this.entries);
		return entry;
	}

	/** The kept metadata for a series, or null. A map read. */
	get(seriesKey: string): SeriesMetadata | null {
		const key = (seriesKey ?? '').trim().toLowerCase();
		return this.entries.get(key) ?? null;
	}

	/** The poster for a series title, or null. A map read. */
	posterFor(title: string): string | null {
		return this.entries.get((title ?? '').trim().toLowerCase())?.poster ?? null;
	}

	toJSON(): Record<string, SeriesMetadata> {
		return Object.fromEntries(this.entries);
	}

	/** Restore from the persisted shape, dropping anything unusable. */
	load(raw: unknown): void {
		this.entries = new Map();
		if (!raw || typeof raw !== 'object') return;
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			const parsed = parseMetadata(value);
			if (parsed) this.entries.set(key, parsed);
		}
		pruneMetadata(this.entries);
	}

	/**
	 * The catalogue's own recommendations for a series, from the kept details
	 * answer. This is the offline fallback for the recommendation flow: when
	 * the live fan-out cannot reach the API, the series browsed before still
	 * has the list its details page carried, votes and posters included.
	 */
	recommendationsFor(seriesKey: string): Recommendation[] {
		const entry = this.get(seriesKey);
		if (!entry) return [];
		const block = (entry.payload as Record<string, unknown> | null)?.recommended;
		if (!Array.isArray(block)) return [];
		const items: Recommendation[] = [];
		for (const row of block) {
			if (!row || typeof row !== 'object') continue;
			const record = row as Record<string, unknown>;
			const title = typeof record.title === 'string' ? record.title.trim() : '';
			if (title === '') continue;
			const votes = Number(record.votes);
			const id = Number(record.id);
			items.push({
				id: Number.isFinite(id) && id !== 0 ? id : null,
				title,
				image: typeof record.image === 'string' ? record.image : null,
				votes: Number.isFinite(votes) ? votes : undefined,
				score: Number.isFinite(votes) && votes > 0 ? votes : 0,
				because: [entry.title],
			});
		}
		return items;
	}
}

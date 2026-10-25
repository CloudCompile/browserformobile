/**
 * Response cache for the anime API.
 *
 * The API is the slow part of the downloader. A search fans out across every
 * provider upstream, and an info request rebuilds its payload from a page that
 * is dead, so a cold call costs seconds. The same titles are then requested
 * again and again while someone browses a series and queues its episodes.
 *
 * The API cannot absorb that itself: it runs as serverless functions, where no
 * in-memory cache survives between requests, so every call is a cold one no
 * matter what TTLs the server sets. The cache therefore lives here, in the
 * plugin, where it persists across an Obsidian restart.
 *
 * Only API JSON is cached. Stream segments, the vault, and the page cache the
 * browser view keeps are all untouched.
 */

/** Where the cache writes itself, injected so it can be tested without disk. */
export interface CachePersistence {
        saveData(data: unknown): Promise<void>;
}

/**
 * How long each endpoint's answer stays usable. Metadata barely changes, so it
 * is held for a week; a stream URL is short-lived and is re-resolved sooner;
 * search sits in between because new episodes appear but a browsing session
 * repeats the same query.
 */
export const SEARCH_TTL_MS = 10 * 60_000;
export const INFO_TTL_MS = 7 * 24 * 60 * 60_000;
export const EPISODES_TTL_MS = 12 * 60 * 60_000;
export const STREAM_TTL_MS = 10 * 60_000;

/** Bound on retained entries, so a long browsing history cannot grow forever. */
export const MAX_CACHE_ENTRIES = 300;

/** Coalesce a burst of writes into one disk write. */
const SAVE_DEBOUNCE_MS = 2000;

/**
 * TTL for a request path. Long enough to cover a browsing session, short enough
 * that a newly aired episode shows up without a restart.
 */
export function ttlForPath(path: string): number {
        // Preview is metadata too: a series' cast and synopsis do not change, and
        // the call fans out to five upstream requests on the API side, so it is
        // the most expensive thing to re-fetch.
        if (path.startsWith('/api/preview/')) return INFO_TTL_MS;
        if (path.startsWith('/api/info')) return INFO_TTL_MS;
        if (path.startsWith('/api/episodes/')) return EPISODES_TTL_MS;
        if (path.startsWith('/api/stream')) return STREAM_TTL_MS;
        return SEARCH_TTL_MS;
}

/**
 * Whether an entry is worth writing to disk. Stream URLs are deliberately
 * memory-only: they are the most likely to have expired by the next launch, so
 * persisting them would mostly restore dead links, and a stale link is worse
 * than a missing one because it fails late, mid-download.
 */
export function isPersistable(path: string): boolean {
        return !path.startsWith('/api/stream');
}

interface Entry {
        value: unknown;
        expiresAt: number;
        persist: boolean;
}

/** Coerce a persisted record into an entry, or null when it is unusable. */
function parseEntry(value: unknown, now: number): Entry | null {
        if (!value || typeof value !== 'object') return null;
        const raw = value as Record<string, unknown>;
        const expiresAt = Number(raw.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
        if (raw.value === undefined) return null;
        return { value: raw.value, expiresAt, persist: true };
}

/** Drop the least valuable entries when the store is over its bound. */
export function pruneEntries(entries: Map<string, Entry>, max = MAX_CACHE_ENTRIES): void {
        if (entries.size <= max) return;
        // Oldest expiry first: those are the closest to being re-fetched anyway,
        // so dropping them costs the least.
        const ordered = [...entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
        const overflow = entries.size - max;
        for (let index = 0; index < overflow; index++) {
                const key = ordered[index]?.[0];
                if (key !== undefined) entries.delete(key);
        }
}

/**
 * A TTL cache over the anime API's JSON responses.
 *
 * Three behaviours share one store:
 *   * Fresh reads are served without touching the network.
 *   * Concurrent requests for the same key share a single in-flight promise, so
 *     a double-tap on a series does not double the upstream load.
 *   * Persistable entries survive a restart, debounced so a burst of writes
 *     becomes one disk write.
 */
export class AnimeCache {
        private entries = new Map<string, Entry>();
        private inflight = new Map<string, Promise<unknown>>();
        private timer: number | null = null;
        private dirty = false;

        constructor(private readonly persistence?: CachePersistence) {}

        /** Replace the in-memory store from persisted records, dropping stale ones. */
        load(records: unknown): void {
                this.entries.clear();
                if (!records || typeof records !== 'object') return;
                const now = Date.now();
                for (const [key, value] of Object.entries(records as Record<string, unknown>)) {
                        const entry = parseEntry(value, now);
                        if (entry) this.entries.set(key, entry);
                }
                pruneEntries(this.entries);
        }

        /** The cached value, or undefined when absent or expired. */
        get(key: string): unknown {
                const entry = this.entries.get(key);
                if (!entry) return undefined;
                if (Date.now() >= entry.expiresAt) {
                        this.entries.delete(key);
                        return undefined;
                }
                return entry.value;
        }

        set(key: string, value: unknown, path: string): void {
                if (value === undefined) return;
                this.entries.set(key, {
                        value,
                        expiresAt: Date.now() + ttlForPath(path),
                        persist: isPersistable(path),
                });
                pruneEntries(this.entries);
                this.markDirty();
        }

        /**
         * Serve a fresh hit, or run `producer` once and cache the result.
         * Concurrent callers for the same key await the same promise.
         */
        async getOrFetch(key: string, path: string, producer: () => Promise<unknown>): Promise<unknown> {
                const cached = this.get(key);
                if (cached !== undefined) return cached;

                const pending = this.inflight.get(key);
                if (pending) return pending;

                const promise = producer();
                this.inflight.set(key, promise);
                try {
                        const value = await promise;
                        this.set(key, value, path);
                        return value;
                } finally {
                        // Cleared on failure too, so a transient error is retried
                        // rather than cached as a rejected promise.
                        this.inflight.delete(key);
                }
        }

        /** Only the entries that survive a restart are written out. */
        toJSON(): Record<string, { value: unknown; expiresAt: number }> {
                const out: Record<string, { value: unknown; expiresAt: number }> = {};
                for (const [key, entry] of this.entries) {
                        if (entry.persist) out[key] = { value: entry.value, expiresAt: entry.expiresAt };
                }
                return out;
        }

        clear(): void {
                this.entries.clear();
                this.inflight.clear();
                this.markDirty();
        }

        /** Drop expired entries; called on load so a stale file shrinks. */
        prune(): void {
                const now = Date.now();
                for (const [key, entry] of this.entries) {
                        if (entry.expiresAt <= now) this.entries.delete(key);
                }
        }

        get size(): number {
                return this.entries.size;
        }

        markDirty(): void {
                if (!this.persistence) return;
                this.dirty = true;
                if (this.timer !== null) return;
                this.timer = window.setTimeout(() => {
                        this.timer = null;
                        void this.flush();
                }, SAVE_DEBOUNCE_MS);
        }

        async flush(): Promise<void> {
                if (!this.persistence || !this.dirty) return;
                this.dirty = false;
                await this.persistence.saveData(this.toJSON());
        }

        dispose(): void {
                if (this.timer !== null) {
                        window.clearTimeout(this.timer);
                        this.timer = null;
                }
                if (this.persistence && this.dirty) {
                        this.dirty = false;
                        void this.persistence.saveData(this.toJSON());
                }
        }
}

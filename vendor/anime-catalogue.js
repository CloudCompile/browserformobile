/**
 * GENERATED from packages/catalogue/src/index.js — do not edit.
 *
 * The standalone plugin mirror has no packages/ directory, so this copy is what
 * it builds against. `npm run vendor` (scripts/vendor-shared.mjs) rewrites it
 * from the monorepo's copy, and `npm test` fails if the two have drifted;
 * scripts/check-shared.mjs proves the generated branch leaves no @anime import
 * in main.js.
 */
/**
 * Catalogue cache policy, and the request helpers every client shares.
 *
 * The API is the slow part of every client: a search fans out across every
 * provider upstream and an info request rebuilds its payload from a page that
 * is cold. The API cannot absorb that itself — it runs as serverless functions,
 * where no in-memory cache survives between requests — so each client caches in
 * front of it.
 *
 * This package is the policy, taken from the Obsidian plugin's
 * `src/animeCache.ts`, which is the version that has been tuned against real
 * use: per-endpoint TTLs, in-flight de-duplication, a size bound, and a
 * deliberate split between what survives a restart and what does not.
 *
 * It is storage-agnostic on purpose. The plugin persists to `data.json`, the
 * browser app to `localStorage`, the Next.js reader to its process memory; each
 * passes the persistence it has and nothing else changes.
 *
 * Only API JSON is ever cached here. Segments, playlists and files are not.
 */

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
/**
 * Browse listings. Short on purpose: these are the pages whose whole point is
 * to show what is new, and the API's own cache of them lasts five minutes.
 */
export const BROWSE_TTL_MS = 5 * 60_000;

/** Bound on retained entries, so a long browsing history cannot grow forever. */
export const MAX_CACHE_ENTRIES = 300;

/** Coalesce a burst of writes into one disk write. */
const SAVE_DEBOUNCE_MS = 2000;

/** Routes whose rows are a listing of what is new, rather than a search. */
const BROWSE_ROUTES = [
  "/api/most-popular",
  "/api/top-airing",
  "/api/top-upcoming",
  "/api/recently-added",
  "/api/completed",
  "/api/movie",
  "/api/tv",
  "/api/ova",
  "/api/ona",
  "/api/special",
  "/api/filter",
  "/api/genre/",
  "/api/adult/browse",
  "/api/adult/genres",
];

export function isBrowsePath(path) {
  return BROWSE_ROUTES.some((route) => String(path ?? "").startsWith(route));
}

/** TTL for a request path. */
export function ttlForPath(path) {
  const value = String(path ?? "");
  // Preview is metadata too: a series' cast and synopsis do not change, and the
  // call fans out to five upstream requests on the API side, so it is the most
  // expensive thing to re-fetch.
  if (value.startsWith("/api/preview/")) return INFO_TTL_MS;
  if (value.startsWith("/api/info")) return INFO_TTL_MS;
  if (value.startsWith("/api/episodes/")) return EPISODES_TTL_MS;
  if (value.startsWith("/api/stream")) return STREAM_TTL_MS;
  if (isBrowsePath(value)) return BROWSE_TTL_MS;
  return SEARCH_TTL_MS;
}

/**
 * Whether an entry is worth writing to disk. Stream URLs are deliberately
 * memory-only: they are the most likely to have expired by the next launch, so
 * persisting them would mostly restore dead links, and a stale link is worse
 * than a missing one because it fails late, mid-download.
 */
export function isPersistable(path) {
  return !String(path ?? "").startsWith("/api/stream");
}

/** Coerce a persisted record into an entry, or null when it is unusable. */
function parseEntry(value, now) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  const expiresAt = Number(raw.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  if (raw.value === undefined) return null;
  return { value: raw.value, expiresAt, persist: true };
}

/** Drop the least valuable entries when the store is over its bound. */
export function pruneEntries(entries, max = MAX_CACHE_ENTRIES) {
  if (entries.size <= max) return;
  // Oldest expiry first: those are the closest to being re-fetched anyway, so
  // dropping them costs the least.
  const ordered = [...entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const overflow = entries.size - max;
  for (let index = 0; index < overflow; index += 1) {
    const key = ordered[index]?.[0];
    if (key !== undefined) entries.delete(key);
  }
}

/**
 * A TTL cache over the API's JSON responses.
 *
 * Three behaviours share one store:
 *   * Fresh reads are served without touching the network.
 *   * Concurrent requests for the same key share a single in-flight promise, so
 *     a double-tap on a series does not double the upstream load.
 *   * Persistable entries survive a restart, debounced so a burst of writes
 *     becomes one write.
 *
 * `now` and the timers are injectable so the policy is testable without waiting
 * for a TTL to pass.
 */
export class AnimeCache {
  /**
   * @param {{saveData?: (data: unknown) => Promise<void>|void, now?: () => number,
   *          debounceMs?: number, maxEntries?: number}} [options]
   */
  constructor(options = {}) {
    this.persistence = options.saveData ? { saveData: options.saveData } : null;
    this.now = options.now ?? (() => Date.now());
    this.debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
    this.maxEntries = options.maxEntries ?? MAX_CACHE_ENTRIES;
    this.entries = new Map();
    this.inflight = new Map();
    this.timer = null;
    this.dirty = false;
  }

  /** Replace the in-memory store from persisted records, dropping stale ones. */
  load(records) {
    this.entries.clear();
    if (!records || typeof records !== "object") return;
    const now = this.now();
    for (const [key, value] of Object.entries(records)) {
      const entry = parseEntry(value, now);
      if (entry) this.entries.set(key, entry);
    }
    pruneEntries(this.entries, this.maxEntries);
  }

  /** The cached value, or undefined when absent or expired. */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, path) {
    if (value === undefined) return;
    this.entries.set(key, {
      value,
      expiresAt: this.now() + ttlForPath(path),
      persist: isPersistable(path),
    });
    pruneEntries(this.entries, this.maxEntries);
    this.markDirty();
  }

  /**
   * Serve a fresh hit, or run `producer` once and cache the result. Concurrent
   * callers for the same key await the same promise.
   */
  async getOrFetch(key, path, producer) {
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
      // Cleared on failure too, so a transient error is retried rather than
      // cached as a rejected promise.
      this.inflight.delete(key);
    }
  }

  /** Only the entries that survive a restart are written out. */
  toJSON() {
    const out = {};
    for (const [key, entry] of this.entries) {
      if (entry.persist) out[key] = { value: entry.value, expiresAt: entry.expiresAt };
    }
    return out;
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
    this.markDirty();
  }

  /** Drop expired entries; called once on load so a stale file shrinks. */
  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  get size() {
    return this.entries.size;
  }

  markDirty() {
    if (!this.persistence) return;
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    // A Node timer must not keep a process alive on its own.
    this.timer?.unref?.();
  }

  async flush() {
    if (!this.persistence || !this.dirty) return;
    this.dirty = false;
    await this.persistence.saveData(this.toJSON());
  }

  /** Stop the timer and write anything still pending. */
  dispose() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.persistence && this.dirty) {
      this.dirty = false;
      void this.persistence.saveData(this.toJSON());
    }
  }
}

/**
 * GENERATED from packages/catalogue/src/index.d.ts — do not edit.
 * Types for the vendored copy in the standalone plugin mirror.
 */
/**
 * Catalogue cache policy, as types. Mirrors `src/index.js`.
 */

export const SEARCH_TTL_MS: number;
export const INFO_TTL_MS: number;
export const EPISODES_TTL_MS: number;
export const STREAM_TTL_MS: number;
export const BROWSE_TTL_MS: number;
export const MAX_CACHE_ENTRIES: number;

export function isBrowsePath(path: string): boolean;
export function ttlForPath(path: string): number;
export function isPersistable(path: string): boolean;
export function pruneEntries(entries: Map<string, { expiresAt: number }>, max?: number): void;

export interface AnimeCacheOptions {
  /** Where persistable entries are written. Omit for a memory-only cache. */
  saveData?: (data: unknown) => Promise<void> | void;
  now?: () => number;
  debounceMs?: number;
  maxEntries?: number;
}

export type PersistedCache = Record<string, { value: unknown; expiresAt: number }>;

export class AnimeCache {
  constructor(options?: AnimeCacheOptions);
  load(records: unknown): void;
  get(key: string): unknown;
  set(key: string, value: unknown, path: string): void;
  getOrFetch<T>(key: string, path: string, producer: () => Promise<T>): Promise<T>;
  toJSON(): PersistedCache;
  clear(): void;
  prune(): void;
  readonly size: number;
  markDirty(): void;
  flush(): Promise<void>;
  dispose(): void;
}

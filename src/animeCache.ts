/**
 * Response cache for the anime API — the shared policy, with this app's type.
 *
 * The cache itself lives in `@anime/catalogue` now: the web app and the reader
 * needed the same per-endpoint TTLs, the same in-flight de-duplication and the
 * same "never persist a stream URL" rule, and three copies would drift. This
 * module keeps the name the plugin already imports and the persistence shape
 * Obsidian uses, so everything else is untouched.
 *
 * Only API JSON is cached. Stream segments, the vault, and the page cache the
 * browser view keeps are all untouched.
 */
import { AnimeCache as SharedAnimeCache } from '@anime/catalogue';

export {
        SEARCH_TTL_MS,
        INFO_TTL_MS,
        EPISODES_TTL_MS,
        STREAM_TTL_MS,
        BROWSE_TTL_MS,
        MAX_CACHE_ENTRIES,
        ttlForPath,
        isPersistable,
        pruneEntries,
} from '@anime/catalogue';

/** Where the cache writes itself, injected so it can be tested without disk. */
export interface CachePersistence {
        saveData(data: unknown): Promise<void>;
}

/** The shared cache, typed against this app's persistence hook. */
export class AnimeCache extends SharedAnimeCache {
        constructor(persistence?: CachePersistence) {
                super(
                        persistence
                                ? {
                                          saveData: (data) => persistence.saveData(data),
                                          // Obsidian's renderer owns `window`; the
                                          // debounce is the same either way.
                                          debounceMs: 2000,
                                  }
                                : {},
                );
        }
}

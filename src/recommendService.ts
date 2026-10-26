/**
 * Turn download history into a recommendation list.
 *
 * The seeds are the series the user has actually engaged with. For each seed the
 * catalogue's own recommendation list is fetched and every entry is tagged with
 * the seed that produced it, so `rankRecommendations` can weight a candidate by
 * how much the user liked the series it came from.
 *
 * Fetches are bounded and sequential-ish: each preview fans out to several
 * upstream calls on the API side, so asking for five seeds at once would be
 * needlessly hard on a service that runs without a persistent cache of its own.
 */

import { loadPreview } from './animeApi';
import {
        buildTasteProfile,
        rankRecommendations,
        blendModelScores,
        type BlendWeights,
        type Candidate,
        type Recommendation,
        type TasteSeed,
} from './recommend';

/**
 * Ceiling on mined seeds.
 *
 * There is deliberately no small cap: the point of the page is to reflect the
 * whole history, and capping at four made a large library look like a small one.
 * This is a guard against a pathological history, not a policy — a caller that
 * wants fewer passes `maxSeeds`.
 */
export const MAX_SEEDS = 200;

/** Seeds below this many downloads are noise rather than taste. */
const MIN_SEED_WEIGHT = 1;

/** Candidates requested per seed before ranking. */
const PER_SEED_LIMIT = 24;

/**
 * How the two signals are blended. Shared by every caller so the details page and
 * the recommendations page rank identically.
 */
const BLEND: BlendWeights = { votes: 0.7, text: 0.3 };

/**
 * Seeds fetched at once. Each one fans out to five upstream calls on the API
 * side, so this is kept low; it exists to stop a thirty-series library from being
 * thirty sequential round trips.
 */
const DEFAULT_CONCURRENCY = 4;

export interface CollectOptions {
        /** Vault series names already downloaded, so they are not recommended back. */
        alreadyHave?: Iterable<string>;
        /** Hard cap on returned recommendations. */
        limit?: number;
        /** Seeds to mine, overriding the derived ones. */
        seeds?: TasteSeed[];
        /** Mine at most this many seeds. Defaults to all of them. */
        maxSeeds?: number;
        /** Seeds to fetch at once. Defaults to `DEFAULT_CONCURRENCY`. */
        concurrency?: number;
        /** Progress callback, for a UI that wants to show what it is doing. */
        onProgress?: (done: number, total: number, seed: string) => void;
        /**
         * Called after every seed with the ranking so far, then once more with the
         * final list. A long history is many round trips, so the page can fill in
         * while it works instead of showing an empty panel.
         */
        onResults?: (items: Recommendation[], done: number, total: number) => void;
        /** Test seam: the preview fetcher. Defaults to the real API client. */
        loadPreview?: typeof loadPreview;
}

export interface CollectResult {
        items: Recommendation[];
        /** Seeds that produced at least one candidate. */
        usedSeeds: string[];
        /** Seeds whose lookup failed, so the UI can say the list is partial. */
        failedSeeds: string[];
}

/** Build the taste profile from download runs and the local library. */
export function deriveSeeds(
        runs: Array<{ series: string; outcome: string }>,
        libraryItems: Array<{ series: string; watched: boolean; progress?: number }>,
): TasteSeed[] {
        // Only successful runs count: a failed download is not a signal of taste.
        const downloads = runs.filter((run) => run.outcome === 'done').map((run) => ({ series: run.series }));
        const profile = buildTasteProfile(downloads, libraryItems);
        return profile.filter((seed) => seed.weight >= MIN_SEED_WEIGHT);
}

/**
 * Fetch and rank recommendations for a set of seeds.
 *
 * A seed that fails is recorded rather than silently dropped, because a list
 * built from two of five seeds should say so instead of looking complete.
 */
export async function collectRecommendations(
        base: string,
        seeds: TasteSeed[],
        options: CollectOptions = {},
): Promise<CollectResult> {
        const maxSeeds = options.maxSeeds ?? MAX_SEEDS;
        const chosen = (options.seeds ?? seeds).slice(0, maxSeeds);
        const limit = options.limit ?? 24;
        const fetchPreview = options.loadPreview ?? loadPreview;
        if (chosen.length === 0) return { items: [], usedSeeds: [], failedSeeds: [] };

        const candidates: Array<Candidate & { fromSeed?: string }> = [];
        const usedSeeds: string[] = [];
        const failedSeeds: string[] = [];
        const alreadyHave = options.alreadyHave ?? [];
        let done = 0;

        // Rank after every seed rather than once at the end. The list only ever
        // grows, so publishing each pass lets the page show results while the rest
        // of a long history is still being read.
        const publish = (): void => {
                if (!options.onResults) return;
                // Sliced to `limit` here too: the final list is capped, so publishing
                // more would make the grid shrink at the end.
                const partial = rankRecommendations(chosen, candidates, alreadyHave, BLEND).slice(0, limit);
                options.onResults(partial, done, chosen.length);
        };

        // A large library is dozens of round trips, so they run a few at a time
        // rather than one after another: sequential mining of thirty series is
        // minutes of an empty-looking page. The limit is deliberately low because
        // each call fans out upstream on the API side.
        let next = 0;
        const mine = async (): Promise<void> => {
                for (;;) {
                        const index = next++;
                        const seed = chosen[index];
                        if (!seed) return;
                        options.onProgress?.(done, chosen.length, seed.series);
                        try {
                                const preview = await fetchPreview(base, seed.series);
                                const recs = preview?.recommendations ?? [];
                                if (recs.length === 0) {
                                        failedSeeds.push(seed.series);
                                } else {
                                        usedSeeds.push(seed.series);
                                        for (const rec of recs.slice(0, PER_SEED_LIMIT)) {
                                                if (!rec.title) continue;
                                                candidates.push({
                                                        id: rec.id,
                                                        title: rec.title,
                                                        image: rec.image,
                                                        votes: rec.votes ?? 0,
                                                        fromSeed: seed.series,
                                                });
                                        }
                                }
                        } catch {
                                failedSeeds.push(seed.series);
                        }
                        done++;
                        publish();
                }
        };

        const workers = Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, chosen.length);
        await Promise.all(Array.from({ length: Math.max(1, workers) }, mine));

        const items = rankRecommendations(chosen, candidates, alreadyHave, BLEND).slice(0, limit);

        options.onProgress?.(chosen.length, chosen.length, '');
        options.onResults?.(items, chosen.length, chosen.length);
        return { items, usedSeeds, failedSeeds };
}

/**
 * Apply a decision model's scores to an already-ranked list.
 *
 * Kept separate from collection so the list can be shown immediately and refined
 * when the model finishes — scoring is CPU-bound and can take a second or more.
 */
export function applyModelScores(
        ranked: Recommendation[],
        scores: Map<string, number>,
        weight = 0.35,
): Recommendation[] {
        return blendModelScores(ranked, scores, weight);
}

/** A short human phrase for a recommendation's provenance. */
export function describeBecause(item: Recommendation): string {
        if (item.because.length === 0) return 'Popular now';
        if (item.because.length === 1) return `Because you downloaded ${item.because[0]}`;
        const first = item.because.slice(0, 2).join(' and ');
        return `Because you downloaded ${first}${item.because.length > 2 ? ' and more' : ''}`;
}

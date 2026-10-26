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

import { loadPreview, type PreviewRecommendation } from './animeApi';
import {
        buildTasteProfile,
        rankRecommendations,
        blendModelScores,
        type Candidate,
        type Recommendation,
        type TasteSeed,
} from './recommend';

/** How many seeds are mined for candidates. More seeds means more upstream calls. */
export const MAX_SEEDS = 4;

/** Seeds below this many downloads are noise rather than taste. */
const MIN_SEED_WEIGHT = 1;

/** Candidates requested per seed before ranking. */
const PER_SEED_LIMIT = 24;

export interface CollectOptions {
        /** Vault series names already downloaded, so they are not recommended back. */
        alreadyHave?: Iterable<string>;
        /** Hard cap on returned recommendations. */
        limit?: number;
        /** Seeds to mine, overriding the derived ones. */
        seeds?: TasteSeed[];
        /** Progress callback, for a UI that wants to show what it is doing. */
        onProgress?: (done: number, total: number, seed: string) => void;
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
        const chosen = (options.seeds ?? seeds).slice(0, MAX_SEEDS);
        const limit = options.limit ?? 24;
        if (chosen.length === 0) return { items: [], usedSeeds: [], failedSeeds: [] };

        const candidates: Array<Candidate & { fromSeed?: string }> = [];
        const usedSeeds: string[] = [];
        const failedSeeds: string[] = [];

        for (const [index, seed] of chosen.entries()) {
                options.onProgress?.(index, chosen.length, seed.series);
                let recs: PreviewRecommendation[] = [];
                try {
                        const preview = await loadPreview(base, seed.series);
                        recs = preview?.recommendations ?? [];
                } catch {
                        failedSeeds.push(seed.series);
                        continue;
                }
                if (recs.length === 0) {
                        failedSeeds.push(seed.series);
                        continue;
                }
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

        const ranked = rankRecommendations(chosen, candidates, options.alreadyHave ?? [], {
                votes: 0.7,
                text: 0.3,
        });

        options.onProgress?.(chosen.length, chosen.length, '');
        return { items: ranked.slice(0, limit), usedSeeds, failedSeeds };
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

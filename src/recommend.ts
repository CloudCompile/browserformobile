/**
 * Recommendations from what the user has already downloaded.
 *
 * Two signals are combined. The catalogue's own "people who liked this also
 * liked that" list is the main one: it is editorial data with vote counts, and
 * it knows things a genre tag does not. The user's history weights it — a series
 * downloaded twenty times counts for more than one downloaded once.
 *
 * The second signal is a BM25 pass over titles, genres and synopses, which needs
 * no model and no network and keeps the ranking sane when the catalogue has no
 * recommendations for any seed. A decision model can be layered on top (see
 * `decision.ts`); it re-ranks, it does not replace.
 *
 * Everything here is pure so it can be tested without a network or a model.
 */

/** A series the user has engaged with, and how much. */
export interface TasteSeed {
        /** Series name as the downloader recorded it. */
        series: string;
        /** Downloads plus completed watches. Higher means more engaged. */
        weight: number;
}

/** A candidate series to score. */
export interface Candidate {
        /** Catalogue id when known, used for de-duplication. */
        id: number | null;
        title: string;
        /** Genres and themes, when the caller has them. */
        tags?: string[];
        /** Synopsis, when the caller has it. */
        synopsis?: string;
        /** Votes from the catalogue's recommendation list, when it came from one. */
        votes?: number;
}

/** A scored candidate, ready to display. */
export interface Recommendation extends Candidate {
        score: number;
        /** Which seeds produced it, for a "because you downloaded X" line. */
        because: string[];
}

/** Words that carry no signal in titles or genres. */
const STOP_WORDS = new Set([
        'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'no', 'wa', 'ga', 'wo',
        'season', 'part', 'movie', 'ova', 'ona', 'special', 'specials', 'tv', 'the', 'its', 'it',
]);

/**
 * Split text into comparable terms.
 *
 * Titles arrive with punctuation, romanisation and season suffixes, so terms are
 * lowercased, split on anything non-alphanumeric, and stripped of stop words and
 * one-character fragments. CJK has no spaces, so a run of CJK characters is kept
 * whole rather than split.
 */
export function tokenize(text: string): string[] {
        const terms: string[] = [];
        const lower = (text ?? '').toLowerCase();
        // Split on non-alphanumeric, but keep CJK runs intact.
        const parts = lower.split(/[^\p{L}\p{N}]+/u);
        for (const part of parts) {
                if (!part) continue;
                if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(part)) {
                        terms.push(part);
                        continue;
                }
                if (part.length < 2) continue;
                if (STOP_WORDS.has(part)) continue;
                terms.push(part);
        }
        return terms;
}

/** Term frequencies for a document. */
function termFrequency(terms: string[]): Map<string, number> {
        const counts = new Map<string, number>();
        for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
        return counts;
}

/**
 * Build a taste profile from download history and the local library.
 *
 * A series downloaded several times, or watched through, is a stronger signal
 * than one tried once, so weights accumulate. Series names are the only thing
 * the history records, so that is what the profile is keyed on.
 */
export function buildTasteProfile(
        downloads: Array<{ series: string }>,
        watched: Array<{ series: string; watched: boolean; progress?: number }> = [],
): TasteSeed[] {
        const weights = new Map<string, number>();
        const add = (series: string, amount: number) => {
                const name = (series ?? '').trim();
                if (!name) return;
                weights.set(name, (weights.get(name) ?? 0) + amount);
        };

        for (const run of downloads) add(run.series, 1);
        for (const item of watched) {
                // A finished episode is worth more than a file that merely exists.
                if (item.watched) add(item.series, 2);
                else if ((item.progress ?? 0) > 0) add(item.series, 1);
        }

        return [...weights.entries()]
                .map(([series, weight]) => ({ series, weight }))
                .sort((left, right) => right.weight - left.weight || left.series.localeCompare(right.series));
}

/** The text a candidate is compared on. */
function candidateText(candidate: Candidate): string {
        return [candidate.title, ...(candidate.tags ?? []), candidate.synopsis ?? ''].join(' ');
}

/**
 * BM25 scores for every candidate against the taste profile text.
 *
 * BM25 is used rather than raw overlap because it discounts terms that appear
 * everywhere ("anime", "story") and saturates on repetition, which matters when
 * one genre dominates the profile. Returns a score per candidate in `[0, 1]`,
 * normalised so it can be blended with the vote-based score.
 */
export function bm25Scores(profileText: string, candidates: Candidate[]): number[] {
        if (candidates.length === 0) return [];
        const docs = candidates.map((candidate) => tokenize(candidateText(candidate)));
        const lengths = docs.map((terms) => terms.length);
        const averageLength = lengths.reduce((sum, value) => sum + value, 0) / lengths.length || 1;

        // Document frequency per term, for the IDF term.
        const documentFrequency = new Map<string, number>();
        for (const terms of docs) {
                for (const term of new Set(terms)) {
                        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
                }
        }

        const queryTerms = tokenize(profileText);
        const k1 = 1.5;
        const b = 0.75;
        const total = docs.length;

        const raw = docs.map((terms, index) => {
                const frequencies = termFrequency(terms);
                const length = lengths[index] ?? 0;
                let score = 0;
                for (const term of queryTerms) {
                        const frequency = frequencies.get(term);
                        if (!frequency) continue;
                        const df = documentFrequency.get(term) ?? 0;
                        // Smoothed IDF, floored at zero so a term in every document
                        // contributes nothing rather than going negative.
                        const idf = Math.max(0, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
                        const denominator = frequency + k1 * (1 - b + (b * length) / averageLength);
                        score += idf * ((frequency * (k1 + 1)) / denominator);
                }
                return score;
        });

        const max = Math.max(...raw, 0);
        return max > 0 ? raw.map((score) => score / max) : raw;
}

/** Normalise a list of numbers to `[0, 1]`. */
function normalize(values: number[]): number[] {
        const max = Math.max(...values, 0);
        if (max <= 0) return values.map(() => 0);
        return values.map((value) => value / max);
}

/** How the two signals are combined. */
export interface BlendWeights {
        /** Weight on the catalogue's recommendation votes. */
        votes: number;
        /** Weight on the BM25 text match. */
        text: number;
}

/**
 * The catalogue signal leads because a recommendation list already means "similar
 * to this seed"; the text pass only breaks ties and covers candidates that came
 * with no votes at all.
 */
export const DEFAULT_BLEND: BlendWeights = { votes: 0.7, text: 0.3 };

/**
 * Rank candidates against the profile.
 *
 * `votes` are the catalogue's recommendation counts. They are scaled by how
 * engaged the user is with the seed that produced them, so a recommendation for
 * a favourite outranks one for a series tried once. `alreadyHave` is removed
 * first: recommending something already downloaded is noise.
 */
export function rankRecommendations(
        seeds: TasteSeed[],
        candidates: Array<Candidate & { fromSeed?: string }>,
        alreadyHave: Iterable<string> = [],
        weights: BlendWeights = DEFAULT_BLEND,
): Recommendation[] {
        const owned = new Set([...alreadyHave].map((name) => name.trim().toLowerCase()));
        const maxSeedWeight = Math.max(...seeds.map((seed) => seed.weight), 1);
        const seedWeight = new Map(seeds.map((seed) => [seed.series.trim().toLowerCase(), seed.weight]));

        // Merge candidates that several seeds pointed at, summing their votes.
        const merged = new Map<string, Candidate & { because: Set<string>; voteScore: number }>();
        for (const candidate of candidates) {
                const title = (candidate.title ?? '').trim();
                if (!title) continue;
                const key = candidate.id !== null ? `id:${candidate.id}` : `t:${title.toLowerCase()}`;
                if (owned.has(title.toLowerCase())) continue;

                const engagement = candidate.fromSeed
                        ? (seedWeight.get(candidate.fromSeed.trim().toLowerCase()) ?? 1) / maxSeedWeight
                        : 1;
                const votes = Math.max(0, candidate.votes ?? 0);
                // Log-damp the votes: the gap between 5 and 50 matters more than
                // between 500 and 545, and one very popular seed should not dominate.
                //
                // The engagement factor keeps a floor well below one, so a series
                // downloaded once cannot lend nearly as much weight as a favourite
                // even when its recommendation has more votes.
                const contribution = Math.log1p(votes) * (0.25 + 0.75 * engagement);

                const existing = merged.get(key);
                if (existing) {
                        existing.voteScore += contribution;
                        if (candidate.fromSeed) existing.because.add(candidate.fromSeed);
                        existing.tags = existing.tags?.length ? existing.tags : candidate.tags;
                        existing.synopsis = existing.synopsis ?? candidate.synopsis;
                        continue;
                }
                merged.set(key, {
                        ...candidate,
                        because: new Set(candidate.fromSeed ? [candidate.fromSeed] : []),
                        voteScore: contribution,
                });
        }

        const entries = [...merged.values()];
        const profileText = seeds
                .map((seed) => `${seed.series} `.repeat(Math.min(3, Math.max(1, Math.round(seed.weight)))))
                .join(' ');
        const textScores = bm25Scores(profileText, entries);
        const voteScores = normalize(entries.map((entry) => entry.voteScore));

        const ranked: Recommendation[] = entries.map((entry, index) => ({
                id: entry.id,
                title: entry.title,
                tags: entry.tags,
                synopsis: entry.synopsis,
                votes: entry.votes,
                because: [...entry.because],
                score: (voteScores[index] ?? 0) * weights.votes + (textScores[index] ?? 0) * weights.text,
        }));

        ranked.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
        return ranked;
}

/**
 * Re-rank existing recommendations with a decision model's scores.
 *
 * The model's opinion is blended rather than substituted, so a model that is
 * unsure about a candidate (a flat `0.5`) leaves the ordering alone instead of
 * shuffling it, and a strong opinion moves it.
 */
export function blendModelScores(
        ranked: Recommendation[],
        modelScores: Map<string, number>,
        weight = 0.5,
): Recommendation[] {
        if (modelScores.size === 0) return ranked;
        const blended = ranked.map((item) => {
                const model = modelScores.get(item.title);
                if (model === undefined) return item;
                // Treat the model output as a 0..1 preference and centre it, so 0.5
                // is neutral and only a confident score changes the order.
                const adjustment = (model - 0.5) * 2 * weight;
                return { ...item, score: item.score + adjustment };
        });
        blended.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
        return blended;
}

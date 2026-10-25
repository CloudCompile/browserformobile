/**
 * Decision-model scoring for recommendations.
 *
 * Two providers, both optional and both off by default:
 *
 * - **Local (TinyDecide)** — a 6 MB 4-bit decision model with a dependency-free
 *   JavaScript engine. It never generates text and never leaves the device. The
 *   weights are downloaded once, on request, and cached next to the plugin data.
 * - **Hosted (Jev / TypeSafe)** — one HTTP call, better at nuance, but it sends
 *   the user's taste profile and candidate titles to a third party, so it needs
 *   an API key and an explicit opt-in.
 *
 * Both answer the same shape of question: given a profile, is each candidate a
 * good match? The answers are probabilities, and `blendModelScores` in
 * `recommend.ts` treats 0.5 as "no opinion" so a model that is unsure leaves the
 * existing ranking alone.
 *
 * Everything here takes its network and storage through `DecisionDeps`, so the
 * scoring can be tested without a network, a model file, or a vault.
 */

import { TinyDecide, type Meta } from './vendor/tinydecide';

/** The upstream model files. The 4-bit build is the one that fits a phone. */
export const TINYDECIDE_META_URL = 'https://huggingface.co/TheREZOR/TinyDecide/resolve/main/meta.json';
export const TINYDECIDE_MODEL_URL = 'https://huggingface.co/TheREZOR/TinyDecide/resolve/main/model.bin';

/** The hosted endpoint. Jev is TypeSafe's System One model. */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

/**
 * The model reads only the first 127 tokens of `state`, so the profile is kept
 * short deliberately: a truncated state would silently drop whichever candidates
 * fell past the cut and score them at random.
 */
export const MAX_STATE_TOKENS = 127;

/** Candidates scored by a model in one pass. Beyond this the state would truncate. */
export const MAX_MODEL_CANDIDATES = 24;

export interface DecisionDeps {
        /** Download a URL as bytes. Used for the model weights. */
        download?(url: string): Promise<ArrayBuffer>;
        /** Read the cached model weights, or null when they have not been fetched. */
        readModel?(): Promise<ArrayBuffer | null>;
        /** Cache the model weights so they are fetched once. */
        writeModel?(data: ArrayBuffer): Promise<void>;
        /** Read the cached model metadata, or null. */
        readMeta?(): Promise<ArrayBuffer | null>;
        /** Cache the model metadata. */
        writeMeta?(data: ArrayBuffer): Promise<void>;
        /** POST JSON and return the parsed body. Used for the hosted provider. */
        postJson?(url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
}

/** Rough token count: WordPiece splits words and CJK, so characters over-split. */
function approximateTokens(text: string): number {
        return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Build the `state` the model reads: the taste profile, then the candidate
 * titles. Kept within the token budget so nothing is truncated.
 */
export function buildDecisionState(profile: string, titles: string[]): string {
        const trimmed = profile.trim();
        const parts: string[] = [];
        let budget = MAX_STATE_TOKENS - approximateTokens(trimmed) - 4;
        for (const title of titles) {
                const cost = approximateTokens(title) + 1;
                if (cost > budget) break;
                budget -= cost;
                parts.push(title);
        }
        const list = parts.join(', ');
        return list ? `${trimmed} Candidates: ${list}.` : trimmed;
}

/**
 * The local decision model.
 *
 * Loading is lazy and one-shot: the weights are read from the cache on first
 * use, downloaded if absent, and held in memory after that. `answer` is
 * synchronous once loaded, but it is CPU-bound (~1.5 s for two dozen candidates
 * on a phone), so callers run it off the render path.
 */
export class TinyDecideRanker {
        private model: TinyDecide | null = null;
        private loading: Promise<boolean> | null = null;
        private meta: Meta | null = null;

        constructor(private readonly deps: DecisionDeps) {}

        /** Whether the weights are in memory and ready to answer. */
        get ready(): boolean {
                return this.model !== null;
        }

        /** Forget the loaded weights, e.g. when the setting is turned off. */
        unload(): void {
                this.model = null;
                this.meta = null;
                this.loading = null;
        }

        /**
         * Load the weights, fetching them once if needed. Returns false when the
         * model could not be obtained, which the caller reports rather than
         * treating as an empty result.
         */
        async ensureLoaded(): Promise<boolean> {
                if (this.model) return true;
                if (this.loading) return this.loading;
                this.loading = this.load();
                try {
                        return await this.loading;
                } finally {
                        this.loading = null;
                }
        }

        private async load(): Promise<boolean> {
                const { deps } = this;
                try {
                        let metaJson = await this.readMeta();
                        let weights = await deps.readModel?.() ?? null;
                        if (!weights || !metaJson) {
                                // Only now is a network available: the cache may already
                                // hold the weights, and a caller that only reads from the
                                // cache is a valid configuration.
                                if (!deps.download) return false;
                                const [metaBuffer, weightBuffer] = await Promise.all([
                                        deps.download(TINYDECIDE_META_URL),
                                        deps.download(TINYDECIDE_MODEL_URL),
                                ]);
                                metaJson = JSON.parse(new TextDecoder().decode(metaBuffer)) as Meta;
                                weights = weightBuffer;
                                await deps.writeModel?.(weightBuffer);
                                await this.writeMeta(metaBuffer);
                        }
                        this.meta = metaJson;
                        this.model = new TinyDecide(metaJson, weights);
                        return true;
                } catch {
                        // A failed download or a corrupt cache is not fatal: the
                        // caller falls back to the no-model ranking.
                        this.model = null;
                        this.meta = null;
                        return false;
                }
        }

        private async readMeta(): Promise<Meta | null> {
                const stored = await this.deps.readMeta?.();
                if (!stored) return null;
                try {
                        return JSON.parse(new TextDecoder().decode(stored)) as Meta;
                } catch {
                        return null;
                }
        }

        private async writeMeta(data: ArrayBuffer): Promise<void> {
                await this.deps.writeMeta?.(data);
        }

        /**
         * Score every candidate against the profile in a single encoder pass.
         *
         * One pass answers all the questions, which is why the cost barely grows
         * with the number of candidates. Titles the model was not asked about are
         * absent from the result rather than guessed at.
         */
        score(profile: string, titles: string[]): Map<string, number> {
                const scores = new Map<string, number>();
                const model = this.model;
                if (!model || titles.length === 0) return scores;
                const capped = titles.slice(0, MAX_MODEL_CANDIDATES);
                const state = buildDecisionState(profile, capped);
                try {
                        const { answers } = model.answer({
                                state,
                                questions: capped.map((title) => ({
                                        type: 'noul' as const,
                                        text: `The user would want to watch ${title}.`,
                                })),
                        });
                        capped.forEach((title, index) => {
                                const answer = answers[index];
                                if (answer && 'p' in answer) scores.set(title, answer.p);
                        });
                } catch {
                        return new Map();
                }
                return scores;
        }
}

/** The hosted provider. Sends the profile and titles to TypeSafe. */
export class JevRanker {
        constructor(private readonly deps: DecisionDeps) {}

        /**
         * Ask Jev to rate each candidate. The profile and titles leave the device;
         * the caller is responsible for having disclosed that.
         */
        async score(profile: string, titles: string[], apiKey: string): Promise<Map<string, number>> {
                const scores = new Map<string, number>();
                if (!this.deps.postJson || !apiKey || titles.length === 0) return scores;
                const capped = titles.slice(0, MAX_MODEL_CANDIDATES);
                const questions: Record<string, unknown> = {};
                capped.forEach((title, index) => {
                        questions[`candidate_${index}`] = {
                                type: 'noul',
                                instructions: `The user would want to watch ${title}.`,
                        };
                });
                const body = {
                        model: JEV_MODEL,
                        state: `${profile}\nCandidates: ${capped.join(', ')}.`,
                        questions,
                };
                try {
                        const response = (await this.deps.postJson(JEV_ENDPOINT, body, {
                                Authorization: `Bearer ${apiKey}`,
                        })) as { answers?: Record<string, { noul?: number }> };
                        const answers = response?.answers ?? {};
                        capped.forEach((title, index) => {
                                const answer = answers[`candidate_${index}`];
                                if (answer && typeof answer.noul === 'number') scores.set(title, answer.noul);
                        });
                } catch {
                        return new Map();
                }
                return scores;
        }
}

/** Which provider re-ranks, if any. */
export type DecisionProvider = 'off' | 'local' | 'hosted';

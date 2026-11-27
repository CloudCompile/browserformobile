import { describe, expect, it } from 'vitest';
import type { AnimePreview } from '../src/animeApi';
import { collectRecommendations, deriveSeeds, MAX_SEEDS } from '../src/recommendService';
import type { TasteSeed } from '../src/recommend';

/** A preview carrying just the recommendations the collector reads. */
function preview(recommendations: Array<{ title: string; id?: number; votes?: number }>): AnimePreview {
        return {
                source: 'jikan',
                malId: 1,
                detail: {} as AnimePreview['detail'],
                characters: [],
                staff: [],
                themes: [],
                recommendations: recommendations.map((rec) => ({
                        id: rec.id ?? null,
                        title: rec.title,
                        image: null,
                        votes: rec.votes ?? 0,
                })),
        };
}

/** Seeds numbered 1..n, so a test can assert exactly how many were mined. */
function seeds(count: number): TasteSeed[] {
        return Array.from({ length: count }, (_, index) => ({ series: `Series ${index + 1}`, weight: 1 }));
}

describe('collectRecommendations', () => {
        it('mines every seed, not just the first few', async () => {
                const requested: string[] = [];
                const all = seeds(12);

                await collectRecommendations('http://x', all, {
                        loadPreview: async (_base, series) => {
                                requested.push(series);
                                return preview([{ title: `Rec for ${series}` }]);
                        },
                });

                expect(requested).toHaveLength(12);
                expect(new Set(requested)).toEqual(new Set(all.map((seed) => seed.series)));
        });

        it('reports every seed as used when all resolve', async () => {
                const result = await collectRecommendations('http://x', seeds(10), {
                        loadPreview: async (_base, series) => preview([{ title: `Rec for ${series}` }]),
                });

                expect(result.usedSeeds).toHaveLength(10);
                expect(result.failedSeeds).toHaveLength(0);
        });

        it('is not capped at four seeds', async () => {
                const result = await collectRecommendations('http://x', seeds(8), {
                        loadPreview: async (_base, series) => preview([{ title: `Rec for ${series}` }]),
                });

                expect(result.usedSeeds.length).toBeGreaterThan(4);
        });

        it('honours an explicit maxSeeds', async () => {
                const requested: string[] = [];
                await collectRecommendations('http://x', seeds(10), {
                        maxSeeds: 3,
                        loadPreview: async (_base, series) => {
                                requested.push(series);
                                return preview([{ title: `Rec for ${series}` }]);
                        },
                });

                expect(requested).toHaveLength(3);
        });

        it('records a seed that throws rather than aborting the rest', async () => {
                const result = await collectRecommendations('http://x', seeds(6), {
                        loadPreview: async (_base, series) => {
                                if (series === 'Series 3') throw new Error('upstream down');
                                return preview([{ title: `Rec for ${series}` }]);
                        },
                });

                expect(result.failedSeeds).toEqual(['Series 3']);
                expect(result.usedSeeds).toHaveLength(5);
        });

        it('treats an empty recommendation list as a failed seed', async () => {
                const result = await collectRecommendations('http://x', seeds(3), {
                        loadPreview: async (_base, series) =>
                                series === 'Series 2' ? preview([]) : preview([{ title: `Rec for ${series}` }]),
                });

                expect(result.failedSeeds).toEqual(['Series 2']);
                expect(result.usedSeeds).toHaveLength(2);
        });

        it('publishes growing results while it works', async () => {
                const passes: number[] = [];
                await collectRecommendations('http://x', seeds(6), {
                        concurrency: 1,
                        loadPreview: async (_base, series) => preview([{ title: `Rec for ${series}` }]),
                        onResults: (items) => passes.push(items.length),
                });

                // One pass per seed, then the final one, each no smaller than the last.
                expect(passes).toHaveLength(7);
                expect(passes.at(-1)).toBe(6);
                for (let i = 1; i < passes.length; i++) {
                        expect(passes[i]).toBeGreaterThanOrEqual(passes[i - 1]);
                }
        });

        it('counts progress up to the full seed count', async () => {
                const seen: number[] = [];
                await collectRecommendations('http://x', seeds(7), {
                        concurrency: 1,
                        loadPreview: async (_base, series) => preview([{ title: `Rec for ${series}` }]),
                        onProgress: (done) => seen.push(done),
                });

                expect(Math.max(...seen)).toBe(7);
        });

        it('never returns a series already in the vault', async () => {
                const result = await collectRecommendations('http://x', seeds(3), {
                        alreadyHave: ['Series 1'],
                        loadPreview: async (_base, series) => preview([{ title: series }]),
                });

                expect(result.items.map((item) => item.title)).not.toContain('Series 1');
        });

        it('caps the returned list at the limit', async () => {
                const result = await collectRecommendations('http://x', seeds(20), {
                        limit: 5,
                        loadPreview: async (_base, series) => preview([{ title: `Rec for ${series}` }]),
                });

                expect(result.items).toHaveLength(5);
        });

        it('never streams more than the limit, so the grid cannot shrink at the end', async () => {
                const passes: number[] = [];
                const result = await collectRecommendations('http://x', seeds(20), {
                        limit: 5,
                        concurrency: 1,
                        loadPreview: async (_base, series) => preview([{ title: `Rec for ${series}` }]),
                        onResults: (items) => passes.push(items.length),
                });

                expect(passes.every((count) => count <= 5)).toBe(true);
                expect(passes.at(-1)).toBe(result.items.length);
        });

        it('returns nothing for an empty history', async () => {
                const result = await collectRecommendations('http://x', [], {
                        loadPreview: async () => preview([{ title: 'x' }]),
                });

                expect(result).toEqual({ items: [], usedSeeds: [], failedSeeds: [] });
        });

        it('has a ceiling high enough for a real library', () => {
                expect(MAX_SEEDS).toBeGreaterThanOrEqual(100);
        });
});

describe('deriveSeeds', () => {
        it('drops failed downloads', () => {
                const derived = deriveSeeds(
                        [
                                { series: 'Naruto', outcome: 'done' },
                                { series: 'Bleach', outcome: 'failed' },
                        ],
                        [],
                );

                expect(derived.map((seed) => seed.series)).toEqual(['Naruto']);
        });

        it('keeps every distinct series from a long history', () => {
                const runs = Array.from({ length: 25 }, (_, index) => ({
                        series: `Series ${index + 1}`,
                        outcome: 'done',
                }));

                expect(deriveSeeds(runs, [])).toHaveLength(25);
        });
});

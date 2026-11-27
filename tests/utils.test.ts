import { describe, it, expect, vi } from 'vitest';

import { childPath, collectFiles, mapWithConcurrency, scanFiles } from '../src/utils';

describe('mapWithConcurrency', () => {
        it('preserves input order in the results', async () => {
                const input = [5, 1, 4, 2, 3];
                const out = await mapWithConcurrency(input, 2, async (value) => {
                        await new Promise((resolve) => setTimeout(resolve, value));
                        return value * 10;
                });
                expect(out).toEqual([50, 10, 40, 20, 30]);
        });

        it('never exceeds the concurrency limit', async () => {
                let inFlight = 0;
                let peak = 0;
                await mapWithConcurrency([...Array(30).keys()], 4, async () => {
                        inFlight++;
                        peak = Math.max(peak, inFlight);
                        await new Promise((resolve) => setTimeout(resolve, 1));
                        inFlight--;
                        return null;
                });
                expect(peak).toBeLessThanOrEqual(4);
                expect(peak).toBeGreaterThan(1);
        });

        it('passes the index to the task', async () => {
                const seen: number[] = [];
                await mapWithConcurrency(['a', 'b', 'c'], 2, async (_item, index) => {
                        seen.push(index);
                        return index;
                });
                expect(seen.sort()).toEqual([0, 1, 2]);
        });

        it('handles an empty list', async () => {
                expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
        });

        it('clamps a limit larger than the list', async () => {
                const out = await mapWithConcurrency([1, 2], 100, async (value) => value);
                expect(out).toEqual([1, 2]);
        });

        it('treats a non-positive limit as one worker', async () => {
                const out = await mapWithConcurrency([1, 2, 3], 0, async (value) => value * 2);
                expect(out).toEqual([2, 4, 6]);
        });

        it('propagates a task failure', async () => {
                await expect(
                        mapWithConcurrency([1, 2, 3], 2, async (value) => {
                                if (value === 2) throw new Error('boom');
                                return value;
                        }),
                ).rejects.toThrow('boom');
        });
});

describe('scanFiles completeness', () => {
        const adapter = (files: string[], options?: { exists?: boolean; listThrows?: boolean }) => ({
                list: vi.fn(async () => {
                        if (options?.listThrows) throw new Error('unavailable');
                        return { files, folders: [] };
                }),
                exists: vi.fn(async () => options?.exists ?? true),
        });

        it('reports complete when the root exists and lists', async () => {
                const result = await scanFiles(adapter(['a.mp4', 'b.txt']), 'Anime', () => true);
                expect(result.complete).toBe(true);
                expect(result.files).toHaveLength(2);
        });

        it('reports incomplete when the root does not exist', async () => {
                const result = await scanFiles(adapter([], { exists: false }), 'Anime', () => true);
                expect(result.complete).toBe(false);
                expect(result.files).toEqual([]);
        });

        it('reports incomplete when the listing throws', async () => {
                const result = await scanFiles(adapter([], { listThrows: true }), 'Anime', () => true);
                expect(result.complete).toBe(false);
        });

        it('reports complete for an empty vault-root scan', async () => {
                const result = await scanFiles(adapter([]), '', () => true);
                expect(result.complete).toBe(true);
                expect(result.files).toEqual([]);
        });

        it('collectFiles still returns just the files', async () => {
                // The fake adapter returns bare names, which `childPath` joins to
                // the scanned folder — matching how Obsidian reports vault-relative
                // paths for a non-root folder.
                const files = await collectFiles(adapter(['a.mp4']), 'Anime', (path) => path.endsWith('.mp4'));
                expect(files).toEqual(['Anime/a.mp4']);
        });
});

describe('childPath', () => {
        it('joins a bare child name to the folder', () => {
                expect(childPath('Anime', 'Ep 1.mp4')).toBe('Anime/Ep 1.mp4');
        });

        it('leaves a child that already carries the folder', () => {
                expect(childPath('Anime', 'Anime/Ep 1.mp4')).toBe('Anime/Ep 1.mp4');
        });

        it('recovers the vault-relative path from a device-absolute child', () => {
                expect(childPath('Anime', '/storage/emulated/0/Vault/Anime/Ep 1.mp4')).toBe(
                        'Anime/Ep 1.mp4',
                );
        });

        it('returns the child unchanged when there is no folder', () => {
                expect(childPath('', 'Ep 1.mp4')).toBe('Ep 1.mp4');
        });
});

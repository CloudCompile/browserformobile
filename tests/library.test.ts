import { describe, it, expect, vi } from 'vitest';

import { VideoLibrary, buildNameRegex, parseEntryName } from '../src/library';

/** A fake vault adapter backed by a plain path -> size map. */
function fakeAdapter(files: Record<string, number>, options?: { listThrows?: boolean; missingRoot?: boolean }) {
        const listing = (path: string): { files: string[]; folders: string[] } => {
                if (options?.listThrows) throw new Error('unavailable');
                const prefix = path ? `${path}/` : '';
                const directFiles: string[] = [];
                const folders = new Set<string>();
                for (const file of Object.keys(files)) {
                        if (!file.startsWith(prefix)) continue;
                        const rest = file.slice(prefix.length);
                        if (rest.includes('/')) folders.add(`${prefix}${rest.split('/')[0]}`);
                        else directFiles.push(file);
                }
                return { files: directFiles, folders: [...folders] };
        };
        return {
                list: vi.fn(async (path: string) => listing(path)),
                exists: vi.fn(async (path: string) => {
                        if (options?.missingRoot) return false;
                        if (path === '') return true;
                        return Object.keys(files).some((file) => file.startsWith(`${path}/`));
                }),
                stat: vi.fn(async (path: string) => (path in files ? { size: files[path] ?? 0, mtime: 1000 } : null)),
        };
}

const TEMPLATE = '{series} - {ep:02} - {title}.{ext}';

describe('library prune safety', () => {
        it('keeps watch progress when the download folder has gone missing', async () => {
                const library = new VideoLibrary();
                library.load({
                        'Anime/Show - 01 - Pilot.mp4': { position: 600, duration: 1400, updatedAt: 1 },
                });
                // The folder is gone: renamed, moved, or the vault is not mounted.
                // A scan that cannot see the folder is not evidence the files were
                // deleted, so progress must survive.
                const adapter = fakeAdapter({}, { missingRoot: true });
                await library.refresh(adapter, 'Anime', TEMPLATE);
                library.prune();
                expect(library.getProgress('Anime/Show - 01 - Pilot.mp4')).not.toBeNull();
        });

        it('keeps watch progress when listing the folder fails', async () => {
                const library = new VideoLibrary();
                library.load({
                        'Anime/Show - 01 - Pilot.mp4': { position: 600, duration: 1400, updatedAt: 1 },
                });
                const adapter = fakeAdapter({}, { listThrows: true });
                await library.refresh(adapter, 'Anime', TEMPLATE);
                library.prune();
                expect(library.getProgress('Anime/Show - 01 - Pilot.mp4')).not.toBeNull();
        });

        it('still prunes progress for a file that was really deleted', async () => {
                const library = new VideoLibrary();
                library.load({
                        'Anime/Show - 01 - Pilot.mp4': { position: 600, duration: 1400, updatedAt: 1 },
                        'Anime/Show - 02 - Gone.mp4': { position: 10, duration: 1400, updatedAt: 1 },
                });
                const adapter = fakeAdapter({ 'Anime/Show - 01 - Pilot.mp4': 10 });
                await library.refresh(adapter, 'Anime', TEMPLATE);
                library.prune();
                expect(library.getProgress('Anime/Show - 01 - Pilot.mp4')).not.toBeNull();
                expect(library.getProgress('Anime/Show - 02 - Gone.mp4')).toBeNull();
        });

        it('keeps progress when the folder exists but is empty', async () => {
                // An empty folder is authoritative: nothing is there, so pruning is
                // correct. This documents the distinction the missing-folder case
                // relies on.
                const library = new VideoLibrary();
                library.load({ 'Anime/Old - 01 - X.mp4': { position: 5, duration: 10, updatedAt: 1 } });
                const adapter = fakeAdapter({ 'Anime/.keep': 0 });
                await library.refresh(adapter, 'Anime', TEMPLATE);
                library.prune();
                expect(library.getProgress('Anime/Old - 01 - X.mp4')).toBeNull();
        });
});

describe('buildNameRegex caching', () => {
        it('returns the same compiled regex for the same template', () => {
                const first = buildNameRegex(TEMPLATE);
                const second = buildNameRegex(TEMPLATE);
                expect(first).toBe(second);
        });

        it('returns a different regex for a different template', () => {
                expect(buildNameRegex(TEMPLATE)).not.toBe(buildNameRegex('{series} {ep}.{ext}'));
        });

        it('does not leak state between parses', () => {
                // A cached regex with the `g` flag would carry lastIndex across
                // calls and start failing every other parse.
                const a = parseEntryName('Show - 01 - Pilot.mp4', TEMPLATE);
                const b = parseEntryName('Show - 02 - Second.mp4', TEMPLATE);
                expect(a.episode).toBe(1);
                expect(b.episode).toBe(2);
        });
});

describe('library scan performance', () => {
        it('stats files with bounded concurrency rather than one at a time', async () => {
                const files: Record<string, number> = {};
                for (let index = 1; index <= 40; index++) {
                        files[`Anime/Show - ${String(index).padStart(2, '0')} - Ep.mp4`] = 1000;
                }
                const library = new VideoLibrary();
                const adapter = fakeAdapter(files);

                // Track how many stats are in flight at once.
                let inFlight = 0;
                let peak = 0;
                const originalStat = adapter.stat;
                adapter.stat = vi.fn(async (path: string) => {
                        inFlight++;
                        peak = Math.max(peak, inFlight);
                        await new Promise((resolve) => setTimeout(resolve, 1));
                        inFlight--;
                        return originalStat(path);
                }) as typeof adapter.stat;

                await library.refresh(adapter, 'Anime', TEMPLATE);
                expect(library.entries).toHaveLength(40);
                // Serial would peak at 1; the scan must overlap the round-trips.
                expect(peak).toBeGreaterThan(1);
        });

        it('preserves every entry when stat fails for one file', async () => {
                const library = new VideoLibrary();
                const adapter = fakeAdapter({
                        'Anime/Show - 01 - A.mp4': 10,
                        'Anime/Show - 02 - B.mp4': 20,
                });
                adapter.stat = vi.fn(async (path: string) => {
                        if (path.includes('02')) throw new Error('vanished');
                        return { size: 10, mtime: 1000 };
                }) as typeof adapter.stat;
                await library.refresh(adapter, 'Anime', TEMPLATE);
                expect(library.entries).toHaveLength(2);
                const second = library.entries.find((entry) => entry.name.includes('02'));
                expect(second?.size).toBe(0);
        });
});

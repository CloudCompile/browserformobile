import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodeSummary } from '../src/animeApi';
import {
        DownloadManager,
        isMeteredConnection,
        withSeriesPreference,
        type DownloadJob,
        type DownloaderOptions,
        type PersistedDownloadJob,
} from '../src/downloader';

/** A minimal episode; only `id` and `number` matter to the queue. */
function episode(id: string, number: number): EpisodeSummary {
        return { id, number, title: `Episode ${number}`, filler: false, subbed: true, dubbed: false };
}

/** The full job shape the queue keeps, with just the fields tests vary. */
function makeJob(id: string, number: number, status: DownloadJob['status'], series = 'Naruto'): DownloadJob {
        return {
                id,
                seriesTitle: series,
                episode: episode(id, number),
                format: 'mp4',
                quality: 720,
                status,
                completed: null,
                total: null,
                bytes: 0,
                fileSize: null,
                filePath: null,
                error: null,
                startedAt: null,
                finishedAt: null,
                resumed: false,
                resumeSegments: 0,
                resumeBytes: 0,
                partialFound: false,
                writtenSegments: 0,
                writtenBytes: 0,
                speed: null,
                averageSpeed: null,
                peakSpeed: null,
                eta: null,
                retryAt: null,
                rateLimitRetries: 0,
                autoRetries: 0,
        };
}

/**
 * Concurrency 0 keeps the pump inert, so no test ever starts a real run —
 * statuses stay exactly as the test set them.
 */
const OPTIONS: DownloaderOptions = {
        apiBase: 'https://api.example',
        quality: 720,
        format: 'mp4',
        segmentConcurrency: 2,
        maxConcurrentJobs: 0,
        filenameTemplate: '{series} - {ep:02} - {title}.{ext}',
        downloadSubtitles: false,
        preferDub: false,
        destination: { external: false, folder: 'Anime' },
};

/**
 * An in-memory vault adapter, just the surface VaultDestination touches, so
 * auto-resume can look for sidecars without a real vault.
 */
class FakeAdapter {
        files = new Map<string, ArrayBuffer>();

        async exists(path: string): Promise<boolean> {
                return this.files.has(path);
        }
        async readBinary(path: string): Promise<ArrayBuffer> {
                const data = this.files.get(path);
                if (data === undefined) throw new Error(`missing: ${path}`);
                return data;
        }
        async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
                this.files.set(path, data);
        }
        async remove(path: string): Promise<void> {
                this.files.delete(path);
        }
        async rename(from: string, to: string): Promise<void> {
                const data = this.files.get(from);
                if (data === undefined) throw new Error(`missing: ${from}`);
                this.files.delete(from);
                this.files.set(to, data);
        }
        async stat(): Promise<{ size: number; mtime: number } | null> {
                return null;
        }
        async mkdir(): Promise<void> {}
        async list(): Promise<{ files: string[]; folders: string[] }> {
                return { files: [...this.files.keys()], folders: [] };
        }
}

/** The sidecar a resumed run is checked against, written where markPartial looks. */
function writeSidecar(manager: DownloadManager, adapter: FakeAdapter, job: DownloadJob, segments: number): void {
        // The final path comes from the manager's own template rendering; the
        // sidecar sits next to it, under the destination folder the vault
        // destination prefixes every path with.
        const savedPath = manager.savedPath(job.episode, job.seriesTitle);
        const state = {
                version: 4, // PARTIAL_VERSION; the current sidecar shape
                episodeId: job.episode.id,
                seriesTitle: job.seriesTitle,
                format: 'mp4',
                quality: 720,
                totalSegments: segments * 2,
                durationSeconds: 1440,
                segments,
                bytes: segments * 1000,
                episodeNumber: job.episode.number,
                episodeTitle: job.episode.title,
        };
        adapter.files.set(
                `Anime/${savedPath}.part.json`,
                new TextEncoder().encode(JSON.stringify(state)).buffer as ArrayBuffer,
        );
}

/** A manager with the given jobs pushed, pump kept inert by concurrency 0. */
function managerWith(
        statuses: Array<{ id: string; number: number; status: DownloadJob['status'] }>,
): DownloadManager {
        const manager = new DownloadManager({ vault: { adapter: new FakeAdapter() } }, OPTIONS, () => {});
        for (const entry of statuses) {
                manager.jobs.push(makeJob(entry.id, entry.number, entry.status));
        }
        return manager;
}

describe('reorder', () => {
        beforeEach(() => {
                // scheduleUpdate and the retry timers go through window; a fake
                // whose timers never fire keeps the manager synchronous in tests.
                vi.stubGlobal('window', { setTimeout: () => 1, clearTimeout: () => {} });
        });

        afterEach(() => {
                vi.unstubAllGlobals();
        });

        it('swaps with the nearest movable neighbour, skipping finished rows', () => {
                const manager = managerWith([
                        { id: 'a', number: 1, status: 'queued' },
                        { id: 'b', number: 2, status: 'done' },
                        { id: 'c', number: 3, status: 'queued' },
                ]);
                // Moving c up swaps it with the nearest movable row above (a),
                // jumping the finished row between them: c now runs first.
                expect(manager.reorder('c', 'up')).toBe(true);
                expect(manager.jobs.map((job) => job.episode.id)).toEqual(['c', 'b', 'a']);
        });

        it('keeps a waiting row pinned: it cannot be moved, or be jumped over', () => {
                const manager = managerWith([
                        { id: 'a', number: 1, status: 'queued' },
                        { id: 'b', number: 2, status: 'waiting' },
                        { id: 'c', number: 3, status: 'queued' },
                ]);
                // The waiting row itself is not movable.
                expect(manager.reorder('b', 'up')).toBe(false);
                expect(manager.reorder('b', 'down')).toBe(false);
                // And a move swaps with the nearest movable row above, around
                // the parked one — which stays put itself.
                expect(manager.reorder('c', 'up')).toBe(true);
                expect(manager.jobs.map((job) => job.episode.id)).toEqual(['c', 'b', 'a']);
        });

        it('refuses to move a running job', () => {
                const manager = managerWith([
                        { id: 'a', number: 1, status: 'running' },
                        { id: 'b', number: 2, status: 'queued' },
                ]);
                expect(manager.reorder('a', 'down')).toBe(false);
                expect(manager.jobs.map((job) => job.episode.id)).toEqual(['a', 'b']);
        });

        it('reports when there is nothing to swap with', () => {
                const manager = managerWith([{ id: 'a', number: 1, status: 'queued' }]);
                expect(manager.reorder('a', 'up')).toBe(false);
                expect(manager.reorder('a', 'down')).toBe(false);
                expect(manager.canReorder('a', 'up')).toBe(false);
        });

        it('moves paused rows too, and persists the new order', () => {
                const persisted: PersistedDownloadJob[][] = [];
                const manager = new DownloadManager(
                        { vault: { adapter: new FakeAdapter() } },
                        OPTIONS,
                        () => {},
                        undefined,
                        (jobs) => persisted.push(jobs),
                );
                manager.jobs.push(makeJob('a', 1, 'paused'));
                manager.jobs.push(makeJob('b', 2, 'queued'));
                expect(manager.reorder('a', 'down')).toBe(true);
                expect(manager.jobs.map((job) => job.episode.id)).toEqual(['b', 'a']);
                // Array order is the persisted order, so a restart keeps the swap.
                expect(persisted[persisted.length - 1]?.map((job) => job.episode.id)).toEqual(['b', 'a']);
                expect(manager.serializeQueue().map((job) => job.episode.id)).toEqual(['b', 'a']);
        });

        it('canReorder mirrors the swap semantics for the row buttons', () => {
                const manager = managerWith([
                        { id: 'a', number: 1, status: 'done' },
                        { id: 'b', number: 2, status: 'queued' },
                        { id: 'c', number: 3, status: 'queued' },
                        { id: 'd', number: 4, status: 'done' },
                ]);
                expect(manager.canReorder('b', 'up')).toBe(false);
                expect(manager.canReorder('b', 'down')).toBe(true);
                expect(manager.canReorder('c', 'up')).toBe(true);
                expect(manager.canReorder('c', 'down')).toBe(false);
        });
});

describe('autoResumeRestored', () => {
        beforeEach(() => {
                vi.stubGlobal('window', { setTimeout: () => 1, clearTimeout: () => {} });
        });

        afterEach(() => {
                vi.unstubAllGlobals();
        });

        it('revives a paused row whose partial is on disk', async () => {
                const adapter = new FakeAdapter();
                const manager = new DownloadManager({ vault: { adapter } }, OPTIONS, () => {});
                const job = makeJob('ep-1', 1, 'paused');
                manager.jobs.push(job);
                writeSidecar(manager, adapter, job, 12);

                expect(await manager.autoResumeRestored()).toBe(1);
                expect(job.status).toBe('queued');
                expect(job.partialFound).toBe(true);
                expect(job.resumeSegments).toBe(12);
        });

        it('leaves a paused row alone when nothing is on disk', async () => {
                const manager = new DownloadManager({ vault: { adapter: new FakeAdapter() } }, OPTIONS, () => {});
                const job = makeJob('ep-2', 2, 'paused');
                manager.jobs.push(job);

                expect(await manager.autoResumeRestored()).toBe(0);
                expect(job.status).toBe('paused');
                expect(job.partialFound).toBe(false);
        });

        it('skips finished rows entirely', async () => {
                const adapter = new FakeAdapter();
                const manager = new DownloadManager({ vault: { adapter } }, OPTIONS, () => {});
                const done = makeJob('ep-3', 3, 'done');
                manager.jobs.push(done);
                writeSidecar(manager, adapter, done, 5);

                expect(await manager.autoResumeRestored()).toBe(0);
                expect(done.status).toBe('done');
        });

        it('does nothing on a connection the device reports as metered', async () => {
                vi.stubGlobal('navigator', { connection: { saveData: true } });
                try {
                        const adapter = new FakeAdapter();
                        const manager = new DownloadManager({ vault: { adapter } }, OPTIONS, () => {});
                        const job = makeJob('ep-4', 4, 'paused');
                        manager.jobs.push(job);
                        writeSidecar(manager, adapter, job, 8);

                        expect(await manager.autoResumeRestored()).toBe(0);
                        expect(job.status).toBe('paused');
                        // Not even inspected: the metered check answers first.
                        expect(job.partialFound).toBe(false);
                } finally {
                        vi.unstubAllGlobals();
                }
        });
});

describe('suspend guard (no wake lock on the platform)', () => {
	/** A fake `document` whose visibility the test drives. */
	function stubDocument(): { setVisibility(state: 'visible' | 'hidden'): void; fire(): void; removed: boolean } {
		let listener: (() => void) | null = null;
		let state: 'visible' | 'hidden' = 'visible';
		const removed = { current: false };
		vi.stubGlobal('document', {
			get visibilityState() {
				return state;
			},
			addEventListener(type: string, fn: () => void) {
				if (type === 'visibilitychange') listener = fn;
			},
			removeEventListener() {
				removed.current = true;
			},
		});
		return {
			setVisibility(next) {
				state = next;
			},
			fire() {
				listener?.();
			},
			get removed() {
				return removed.current;
			},
		};
	}

	beforeEach(() => {
		// No `wakeLock` on the navigator: the guard's whole reason to exist.
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('window', { setTimeout: () => 1, clearTimeout: () => {} });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('pauses a running job on hide and resumes it on return', () => {
		const doc = stubDocument();
		const manager = managerWith([{ id: 'a', number: 1, status: 'running' }]);
		manager.enqueue({ seriesTitle: 'Naruto', episodes: [episode('ep-9', 9)] });

		doc.setVisibility('hidden');
		doc.fire();
		// The ordinary pause: still resumable, partial marked by the aborting
		// run (which does not exist here, so the job just sits paused).
		expect(manager.jobs.find((job) => job.id === 'a')?.status).toBe('paused');

		doc.setVisibility('visible');
		doc.fire();
		expect(manager.jobs.find((job) => job.id === 'a')?.status).toBe('queued');
	});

	it('leaves a job the user paused alone on return', () => {
		const doc = stubDocument();
		const manager = managerWith([
			{ id: 'a', number: 1, status: 'running' },
			{ id: 'b', number: 2, status: 'paused' }, // the user's own pause
		]);
		manager.enqueue({ seriesTitle: 'Naruto', episodes: [episode('ep-9', 9)] });

		doc.setVisibility('hidden');
		doc.fire();
		doc.setVisibility('visible');
		doc.fire();
		// `a` was guard-paused, so it is revived; `b` was never running, so the
		// guard never claimed it — the user's pause stands.
		expect(manager.jobs.find((job) => job.id === 'a')?.status).toBe('queued');
		expect(manager.jobs.find((job) => job.id === 'b')?.status).toBe('paused');
	});

	it('is not attached where a wake lock exists', () => {
		vi.stubGlobal('navigator', { wakeLock: { request: async () => null } });
		vi.stubGlobal('document', {
			visibilityState: 'visible',
			addEventListener: () => {
				throw new Error('listener must not be attached with a wake lock');
			},
			removeEventListener: () => {},
		});
		const manager = managerWith([{ id: 'a', number: 1, status: 'queued' }]);
		expect(() => manager.enqueue({ seriesTitle: 'Naruto', episodes: [episode('ep-9', 9)] })).not.toThrow();
	});
});

describe('isMeteredConnection', () => {
        it('reads saveData and a cellular type when present', () => {
                expect(isMeteredConnection({ saveData: true })).toBe(true);
                expect(isMeteredConnection({ type: 'cellular' })).toBe(true);
                expect(isMeteredConnection({ type: 'wimax' })).toBe(true);
                expect(isMeteredConnection({ type: 'wifi', saveData: false })).toBe(false);
        });

        it('answers false without a signal, as iOS exposes none', () => {
                expect(isMeteredConnection(undefined)).toBe(false);
                expect(isMeteredConnection(null)).toBe(false);
                expect(isMeteredConnection('junk')).toBe(false);
        });

        it('answers false when no navigator exists at all', () => {
                vi.stubGlobal('navigator', undefined);
                try {
                        expect(isMeteredConnection()).toBe(false);
                } finally {
                        vi.unstubAllGlobals();
                }
        });
});

describe('withSeriesPreference', () => {
        it('records an override without mutating the input', () => {
                const map = { Naruto: { quality: 480 } };
                const next = withSeriesPreference(map, 'Bleach', { format: 'ts' });
                expect(next['Bleach']).toEqual({ format: 'ts' });
                expect(map).toEqual({ Naruto: { quality: 480 } });
                expect(next['Naruto']).toEqual({ quality: 480 });
        });

        it('merges with an existing override, newest value winning', () => {
                const map = { Naruto: { quality: 480 } };
                const next = withSeriesPreference(map, 'Naruto', { format: 'ts' });
                expect(next['Naruto']).toEqual({ quality: 480, format: 'ts' });
                const updated = withSeriesPreference(next, 'Naruto', { quality: 360 });
                expect(updated['Naruto']).toEqual({ quality: 360, format: 'ts' });
        });

        it('ignores a blank series name', () => {
                const map = { Naruto: { quality: 480 } };
                expect(withSeriesPreference(map, '   ', { format: 'ts' })).toBe(map);
        });
});

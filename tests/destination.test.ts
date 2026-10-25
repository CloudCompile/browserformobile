import { describe, it, expect, vi } from 'vitest';
import { ExternalDestination, DownloadWriteError, VaultDestination } from '../src/destination';

function makeFs() {
        const files = new Map<string, Uint8Array>();
        return {
                promises: {
                        mkdir: async () => {},
                        writeFile: async (p: string, d: Uint8Array) => { files.set(p, d); },
                        appendFile: async () => {},
                        readFile: async (p: string) => { const f = files.get(p); if (!f) throw new Error('missing'); return f; },
                        stat: async (p: string) => ({ size: files.get(p)?.byteLength ?? 0 }),
                        rename: async () => {},
                        unlink: async (p: string) => { files.delete(p); },
                        access: async (p: string) => { if (!files.has(p)) throw new Error('missing'); },
                        open: async () => ({ write: async () => ({ bytesWritten: 0 }), close: async () => {} }),
                        readdir: async () => [],
                        truncate: async () => {},
                },
        } as any;
}

describe('ExternalDestination containment', () => {
        it('rejects traversal in validate', () => {
                const d = new ExternalDestination(makeFs(), '/tmp/base');
                expect(d.validate('../etc/passwd')).not.toBeNull();
        });
        it('rejects traversal on open', async () => {
                const d = new ExternalDestination(makeFs(), '/tmp/base');
                await expect(d.open('../escape.txt')).rejects.toBeInstanceOf(DownloadWriteError);
        });
        it('allows normal path', async () => {
                const d = new ExternalDestination(makeFs(), '/tmp/base');
                expect(d.validate('x.mp4')).toBeNull();
                const fw = await d.open('x.mp4');
                await fw.close();
        });
});

/** A vault adapter that records which folders exist. */
function makeAdapter() {
        const folders = new Set<string>();
        const adapter = {
                writeBinary: async () => {},
                appendBinary: async () => {},
                readBinary: async () => new ArrayBuffer(0),
                remove: async () => {},
                rename: async () => {},
                mkdir: async (path: string) => { folders.add(path); },
                exists: vi.fn(async (path: string) => folders.has(path)),
                stat: async () => null,
                list: async () => ({ files: [], folders: [] }),
        };
        return adapter;
}

describe('VaultDestination folder caching', () => {
        it('checks each parent folder only once across opens', async () => {
                const adapter = makeAdapter();
                const d = new VaultDestination(adapter, 'Anime');
                // Two files in the same nested folder. The parents are identical, so
                // after the first open the existence checks must not repeat.
                await (await d.open('Season 1/Ep 1.mp4')).close();
                const afterFirst = adapter.exists.mock.calls.length;
                await (await d.open('Season 1/Ep 2.mp4')).close();
                await (await d.open('Season 1/Ep 3.mp4')).close();
                expect(adapter.exists.mock.calls.length).toBe(afterFirst);
        });

        it('still creates a folder the first time it is needed', async () => {
                const adapter = makeAdapter();
                const d = new VaultDestination(adapter, 'Anime');
                await (await d.open('New/Ep 1.mp4')).close();
                const checked = adapter.exists.mock.calls.map((call) => call[0] as string);
                expect(checked).toContain('Anime');
                expect(checked).toContain('Anime/New');
        });
});


import { describe, it, expect } from 'vitest';
import { ExternalDestination, DownloadWriteError } from '../src/destination';

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

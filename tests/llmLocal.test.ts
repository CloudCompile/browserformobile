import { describe, it, expect, vi } from 'vitest';
import {
        PICKS_GRAMMAR,
        localSamplingOptions,
        MAX_LOCAL_CANDIDATES,
        buildLocalMessages,
        curateInProcess,
        WllamaRuntime,
        sha256Hex,
        type LocalRuntime,
        type LocalRuntimeHost,
} from '../src/llmLocal';

/** A runtime stub that returns a canned reply and records what it was asked. */
function fakeRuntime(reply: string, opts: { failLoad?: boolean; throwOnComplete?: string } = {}) {
        const calls: Array<{ messages: Array<{ role: string; content: string }>; options: unknown }> = [];
        const runtime: LocalRuntime = {
                ready: true,
                unload: vi.fn(),
                ensureModel: async () => !opts.failLoad,
                complete: async (messages, options) => {
                        calls.push({ messages, options });
                        if (opts.throwOnComplete) throw new Error(opts.throwOnComplete);
                        return reply;
                },
        };
        return { runtime, calls };
}

const ranked = [
        { title: 'Naruto', votes: 99, because: ['Bleach'] },
        { title: 'One Piece', votes: 98, because: ['Bleach'] },
        { title: 'Psycho-Pass', votes: 40, because: ['Death Note'] },
];

describe('buildLocalMessages', () => {
        it('puts the system prompt first and the candidates in the user turn', () => {
                const messages = buildLocalMessages(['Death Note'], ranked, 3);
                expect(messages[0]!.role).toBe('system');
                expect(messages[1]!.role).toBe('user');
                expect(messages[1]!.content).toContain('Psycho-Pass');
        });

        it('appends catalogue notes when given', () => {
                const messages = buildLocalMessages(['Death Note'], ranked, 3, 'Naruto: 220 episodes.');
                expect(messages[1]!.content).toContain('Known details:');
                expect(messages[1]!.content).toContain('220 episodes');
        });

        it('omits the notes section when there are none', () => {
                const messages = buildLocalMessages([], ranked, 3, '   ');
                expect(messages[1]!.content).not.toContain('Known details:');
        });

        it('does not leak provenance into the prompt', () => {
                // A real 230M model split "Steins;Gate" on the punctuation when it
                // appeared in a provenance annotation, so it must not be present.
                const messages = buildLocalMessages([], ranked, 3);
                expect(messages[1]!.content).not.toContain('suggested by');
        });
});

describe('curateInProcess', () => {
        it('reorders to the model order and keeps every item', async () => {
                const { runtime } = fakeRuntime('{"picks": ["Psycho-Pass", "Naruto", "One Piece"]}');
                const result = await curateInProcess(ranked, {
                        runtime,
                        allowedTitles: ranked.map((r) => r.title),
                        history: ['Death Note'],
                });
                expect(result.curated).toBe(true);
                expect(result.items.map((i) => i.title)).toEqual(['Psycho-Pass', 'Naruto', 'One Piece']);
                expect(result.items).toHaveLength(3);
        });

        it('drops titles the model invented', async () => {
                const { runtime } = fakeRuntime('{"picks": ["Psycho-Pass", "Bleach", "One Piece"]}');
                const result = await curateInProcess(ranked, {
                        runtime,
                        allowedTitles: ranked.map((r) => r.title),
                        history: [],
                });
                expect(result.items.map((i) => i.title)).toEqual(['Psycho-Pass', 'One Piece', 'Naruto']);
        });

        it('truncates to the limit even when the model returns more', async () => {
                // Observed on a real 230M model: asked for three picks, returned five.
                const { runtime } = fakeRuntime('{"picks": ["Naruto", "One Piece", "Psycho-Pass"]}');
                const result = await curateInProcess(ranked, {
                        runtime,
                        allowedTitles: ranked.map((r) => r.title),
                        history: [],
                        limit: 2,
                });
                expect(result.items.slice(0, 2).map((i) => i.title)).toEqual(['Naruto', 'One Piece']);
        });

        it('returns the input unchanged when no runtime is supplied', async () => {
                const result = await curateInProcess(ranked, { allowedTitles: [], history: [] });
                expect(result.curated).toBe(false);
                expect(result.items).toEqual(ranked);
        });

        it('fails safe when the model will not load', async () => {
                const { runtime } = fakeRuntime('', { failLoad: true });
                const result = await curateInProcess(ranked, {
                        runtime,
                        allowedTitles: ranked.map((r) => r.title),
                        history: [],
                });
                expect(result.curated).toBe(false);
                expect(result.items).toEqual(ranked);
                expect(result.reason).toBeTruthy();
        });

        it('fails safe when generation throws', async () => {
                const { runtime } = fakeRuntime('', { throwOnComplete: 'out of memory' });
                const result = await curateInProcess(ranked, {
                        runtime,
                        allowedTitles: ranked.map((r) => r.title),
                        history: [],
                });
                expect(result.curated).toBe(false);
                expect(result.items).toEqual(ranked);
                expect(result.reason).toContain('out of memory');
        });

        it('fails safe when the reply names nothing usable', async () => {
                const { runtime } = fakeRuntime('{"picks": ["Something Else"]}');
                const result = await curateInProcess(ranked, {
                        runtime,
                        allowedTitles: ranked.map((r) => r.title),
                        history: [],
                });
                expect(result.curated).toBe(false);
                expect(result.items).toEqual(ranked);
        });

        it('times out rather than hanging', async () => {
                const runtime: LocalRuntime = {
                        ready: true,
                        unload: () => undefined,
                        ensureModel: async () => true,
                        complete: () => new Promise(() => undefined),
                };
                const result = await curateInProcess(ranked, {
                        runtime,
                        allowedTitles: ranked.map((r) => r.title),
                        history: [],
                        decode: { timeoutMs: 20 },
                });
                expect(result.curated).toBe(false);
                expect(result.items).toEqual(ranked);
        });

        it('caps how many candidates it sends', async () => {
                const many = Array.from({ length: 40 }, (_, i) => ({ title: `T${i}`, votes: 40 - i }));
                const { runtime, calls } = fakeRuntime(JSON.stringify({ picks: ['T0'] }));
                await curateInProcess(many, {
                        runtime,
                        allowedTitles: many.map((m) => m.title),
                        history: [],
                });
                const prompt = calls[0]!.messages[1]!.content;
                expect(prompt).toContain(`T${MAX_LOCAL_CANDIDATES - 1}`);
                expect(prompt).not.toContain(`T${MAX_LOCAL_CANDIDATES}`);
        });

        it('forwards the decode options to the runtime', async () => {
                const { runtime, calls } = fakeRuntime('{"picks": ["Naruto"]}');
                await curateInProcess(ranked, {
                        runtime,
                        allowedTitles: ranked.map((r) => r.title),
                        history: [],
                        decode: { temperature: 0.7, maxTokens: 42 },
                });
                expect(calls[0]!.options).toMatchObject({ temperature: 0.7, maxTokens: 42 });
        });
});

describe('localSamplingOptions', () => {
        it('constrains decoding with the picks grammar', () => {
                expect(localSamplingOptions()).toEqual({ grammar: PICKS_GRAMMAR });
        });

        it('uses a GBNF rule set with a root rule', () => {
                expect(PICKS_GRAMMAR).toMatch(/^root\s+::=/m);
                expect(PICKS_GRAMMAR).toContain('picks');
        });
});

describe('sha256Hex', () => {
        it('hashes bytes to the known digest', async () => {
                const bytes = new TextEncoder().encode('abc').buffer;
                // Well-known SHA-256 of "abc".
                expect(await sha256Hex(bytes)).toBe(
                        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
                );
        });
});

describe('WllamaRuntime asset handling', () => {
        function host(overrides: Partial<LocalRuntimeHost> = {}) {
                const written: string[] = [];
                const base: LocalRuntimeHost = {
                        readFile: async () => null,
                        writeFile: async (path) => {
                                written.push(path);
                        },
                        download: async () => new ArrayBuffer(8),
                        wasmPath: 'p/wllama.wasm',
                        modulePath: 'p/wllama-module.js',
                        verify: async () => true,
                        ...overrides,
                };
                return { base, written };
        }

        it('rejects an asset that fails verification instead of loading it', async () => {
                const { base } = host({ verify: async () => false });
                const runtime = new WllamaRuntime(base, { url: 'model.gguf', label: 'x' });
                await expect(runtime.ensureModel()).resolves.toBe(false);
        });

        it('downloads and caches an asset only once per path', async () => {
                const downloads: string[] = [];
                const { base, written } = host({
                        download: async (url) => {
                                downloads.push(url);
                                return new ArrayBuffer(8);
                        },
                });
                const runtime = new WllamaRuntime(base, { url: 'model.gguf', label: 'x' });
                // Loading fails (no real wasm), but the assets must have been fetched.
                await runtime.ensureModel();
                expect(downloads).toHaveLength(2);
                expect(written).toContain('p/wllama.wasm');
                expect(written).toContain('p/wllama-module.js');
        });

        it('does not re-download an asset already cached on disk', async () => {
                const downloads: string[] = [];
                const { base } = host({
                        readFile: async () => new ArrayBuffer(8),
                        download: async (url) => {
                                downloads.push(url);
                                return new ArrayBuffer(8);
                        },
                });
                const runtime = new WllamaRuntime(base, { url: 'model.gguf', label: 'x' });
                await runtime.ensureModel();
                expect(downloads).toHaveLength(0);
        });

        it('re-fetches a cached asset that no longer verifies', async () => {
                const downloads: string[] = [];
                let checks = 0;
                const { base } = host({
                        readFile: async () => new ArrayBuffer(8),
                        download: async (url) => {
                                downloads.push(url);
                                return new ArrayBuffer(8);
                        },
                        // Every cached read fails and every fresh download passes,
                        // so both assets must be fetched again.
                        verify: async () => checks++ % 2 === 1,
                });
                const runtime = new WllamaRuntime(base, { url: 'model.gguf', label: 'x' });
                await runtime.ensureModel();
                expect(downloads).toHaveLength(2);
        });

        it('reports not ready before a load and unloads cleanly', () => {
                const { base } = host();
                const runtime = new WllamaRuntime(base, { url: 'model.gguf', label: 'x' });
                expect(runtime.ready).toBe(false);
                expect(() => runtime.unload()).not.toThrow();
        });
});

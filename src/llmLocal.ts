/**
 * In-process curation: a GGUF model run inside the plugin through WebAssembly.
 *
 * This is the third way to reach a model, alongside `server` and `api` in
 * `llm.ts`. It is the only one that is fully offline and needs no setup, and the
 * only one that works on mobile without a second machine on the network.
 *
 * It is also the most constrained, and the constraints shaped the design:
 *
 * - **wllama is loaded lazily.** It is a large module and must never run at
 *   plugin load, so it is imported inside `ensureLoaded` and nowhere else. The
 *   bundle keeps it behind that boundary.
 * - **The runtime is fetched, not bundled.** `wllama.wasm` is ~8.7 MB. Obsidian
 *   plugins release `main.js`, `manifest.json` and `styles.css`, so a wasm asset
 *   has nowhere to live; it is downloaded once from a pinned jsDelivr URL and
 *   cached on disk, the same way the decision model's weights are. The bytes are
 *   hashed against `WASM_SHA256` before use, so a tampered or truncated download
 *   is rejected rather than executed.
 * - **Decoding is grammar-constrained.** Measured on LFM2.5-230M in a browser:
 *   7.1 s with a JSON grammar against 35.5 s unconstrained, because the model can
 *   only emit valid tokens instead of wandering. The grammar also guarantees the
 *   reply parses.
 * - **Tools are not offered to the model.** A 230M model is unreliable at tool
 *   calling. Instead the catalogue facts are gathered deterministically first —
 *   see `gatherCatalogueNotes` in `llm.ts` — and put in the prompt, which is both
 *   cheaper and more accurate. The `server` and `api` providers do offer tools,
 *   because the models behind them are large enough to use them.
 *
 * Everything here goes through injected dependencies, so the prompt, grammar and
 * parsing are testable without a wasm runtime or a model file.
 */

import {
        buildCuratorSystemPrompt,
        buildCuratorUserPrompt,
        parseCuratorReply,
        applyCuratorPicks,
        type CuratorCandidate,
        type CuratorTool,
} from './llm';

/**
 * The runtime, pinned by version and verified by hash.
 *
 * Both files are fetched at runtime rather than bundled. Bundling was tried and
 * rejected: wllama publishes raw TypeScript under `src/`, points `main` at an
 * `index.js` that does not exist, and its `esm/index.d.ts` pulls that source into
 * our type check, which fails on wllama's own strictness. Fetching keeps the
 * plugin's build and dependency tree unchanged — at the cost of a network call
 * once, and the hash checks below.
 */
export const WLLAMA_VERSION = '3.8.1';
const CDN = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${WLLAMA_VERSION}/esm`;
export const WLLAMA_WASM_URL = `${CDN}/wasm/wllama.wasm`;
export const WLLAMA_MODULE_URL = `${CDN}/index.js`;
/** SHA-256 of the pinned wasm, checked before it is instantiated. */
export const WASM_SHA256 = '551f13439366eff11e057b1b91fe46a7fdac29d56d67372d4c5f19a549dfe70c';
/** SHA-256 of the pinned module, checked before it is evaluated. */
export const MODULE_SHA256 = 'e5506753e41a59c11f61f2c52422045be9fc76e32a7e47f037aaad5df4ec723e';

/**
 * A GBNF grammar that permits exactly one shape of reply: an object with a
 * `picks` array of strings. Anything else is unrepresentable, so a malformed
 * answer cannot be produced at all.
 */
export const PICKS_GRAMMAR = [
        'root   ::= "{" ws "\\"picks\\"" ws ":" ws array ws "}"',
        'array  ::= "[" ws (string (ws "," ws string)*)? ws "]"',
        'string ::= "\\"" chars "\\""',
        'chars  ::= ([^"\\\\] | "\\\\" ["\\\\/bfnrt])*',
        'ws     ::= [ \\t\\n]*',
].join('\n');

/** How the model is asked for its answer. */
export interface LocalDecodeOptions {
        /** Cap on generated tokens. The reply is a short list, so this is small. */
        maxTokens?: number;
        temperature?: number;
        /** Context window. The prompt is bounded by `MAX_LOCAL_PROMPT_TOKENS`. */
        contextSize?: number;
        /** Abort a generation that is taking too long. */
        timeoutMs?: number;
}

export const DEFAULT_LOCAL_DECODE: Required<LocalDecodeOptions> = {
        maxTokens: 160,
        temperature: 0.2,
        contextSize: 2048,
        timeoutMs: 120_000,
};

/**
 * The most candidates a small model can be asked about in one prompt.
 *
 * Measured: 24 titles plus a short history is comfortable in a 2048-token
 * context, and the 230M model still follows the list at that length. Beyond this
 * the prompt grows faster than the model's ability to track it, and quality falls
 * off faster than a longer list helps.
 */
export const MAX_LOCAL_CANDIDATES = 24;

/** The wasm runtime and model, as the provider needs them. */
export interface LocalRuntime {
        /** Load the model, if it is not already loaded. Returns false on failure. */
        ensureModel(): Promise<boolean>;
        /** Run one chat completion and return the raw reply text. */
        complete(
                messages: Array<{ role: string; content: string }>,
                options: Required<LocalDecodeOptions>,
        ): Promise<string>;
        /** Release the model, e.g. when the setting is switched off. */
        unload(): void;
        /** Whether a model is currently resident. */
        readonly ready: boolean;
}

/** What the provider needs from outside, so it can be tested without wasm. */
export interface LocalCuratorDeps {
        runtime?: LocalRuntime;
        allowedTitles: string[];
        history: string[];
        limit?: number;
        /** Extra factual context about the candidates, from the catalogue. */
        notes?: string;
        decode?: LocalDecodeOptions;
        onStatus?: (message: string) => void;
}

/**
 * Build the prompt for an in-process run.
 *
 * The catalogue notes are appended to the history line rather than given as a
 * separate tool result, because this model cannot call tools.
 */
/**
 * The sampling options for a curator run.
 *
 * Exported so the grammar wiring is testable without a wasm runtime.
 */
export function localSamplingOptions(): Record<string, unknown> {
        return { grammar: PICKS_GRAMMAR };
}

export function buildLocalMessages(
        history: string[],
        candidates: CuratorCandidate[],
        limit: number,
        notes?: string,
): Array<{ role: string; content: string }> {
        const user = buildCuratorUserPrompt(history, candidates, limit);
        const withNotes = notes?.trim() ? `${user}\n\nKnown details:\n${notes.trim()}` : user;
        return [
                { role: 'system', content: buildCuratorSystemPrompt() },
                { role: 'user', content: withNotes },
        ];
}

/**
 * Curate using the in-process model.
 *
 * Fails safe at every step, like the other providers: no runtime, a model that
 * will not load, a timeout, or a reply that names nothing usable all return the
 * input list unchanged, so the deterministic ranking is the floor.
 */
export async function curateInProcess<T extends { title: string; because?: string[]; votes?: number }>(
        ranked: T[],
        deps: LocalCuratorDeps,
): Promise<{ items: T[]; curated: boolean; reason?: string }> {
        const { runtime } = deps;
        if (!runtime || ranked.length === 0) return { items: ranked, curated: false };

        const limit = deps.limit ?? ranked.length;
        const options: Required<LocalDecodeOptions> = { ...DEFAULT_LOCAL_DECODE, ...deps.decode };

        let loaded: boolean;
        try {
                deps.onStatus?.('Loading the local model…');
                loaded = await runtime.ensureModel();
        } catch {
                loaded = false;
        }
        if (!loaded) {
                return { items: ranked, curated: false, reason: 'The local model could not be loaded.' };
        }

        const candidates: CuratorCandidate[] = ranked
                .slice(0, MAX_LOCAL_CANDIDATES)
                .map((item) => ({ title: item.title, votes: item.votes }));
        const messages = buildLocalMessages(deps.history, candidates, limit, deps.notes);

        let reply: string;
        try {
                reply = await withTimeout(
                        runtime.complete(messages, options),
                        options.timeoutMs,
                        'The local model took too long to answer.',
                );
        } catch (error) {
                return {
                        items: ranked,
                        curated: false,
                        reason: error instanceof Error ? error.message : 'The local model failed.',
                };
        }

        const picks = parseCuratorReply(reply, deps.allowedTitles, limit);
        if (picks.length === 0) {
                return { items: ranked, curated: false, reason: 'The local model chose nothing usable.' };
        }
        return { items: applyCuratorPicks(ranked, picks), curated: true };
}

/** Reject a promise that has not settled in time. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
        if (!ms || ms <= 0) return work;
        let timer: number | undefined;
        try {
                return await Promise.race([
                        work,
                        new Promise<never>((_, reject) => {
                                timer = window.setTimeout(() => reject(new Error(message)), ms);
                        }),
                ]);
        } finally {
                if (timer !== undefined) window.clearTimeout(timer);
        }
}

/** The shape of the lazily-imported wllama module that this file relies on. */
interface WllamaModule {
        Wllama: new (
                paths: { default: string },
                config?: { suppressNativeLog?: boolean },
        ) => {
                loadModelFromUrl(url: string, params?: { n_ctx?: number }): Promise<void>;
                createChatCompletion(options: Record<string, unknown>): Promise<{
                        choices?: Array<{ message?: { content?: string } }>;
                }>;
                exit(): Promise<void>;
                isModelLoaded(): boolean;
        };
}

/** What the host must provide for the runtime to work. */
export interface LocalRuntimeHost {
        /** Read a cached file, or null. */
        readFile(path: string): Promise<ArrayBuffer | null>;
        /** Write a cached file. Failures are non-fatal. */
        writeFile(path: string, data: ArrayBuffer): Promise<void>;
        /** Download a URL as bytes. */
        download(url: string): Promise<ArrayBuffer>;
        /** Where to cache the wasm runtime. */
        wasmPath: string;
        /** Where to cache the JavaScript module. */
        modulePath: string;
        /** Verify bytes against an expected hash. Injected so tests can bypass it. */
        verify?: (data: ArrayBuffer, expected: string) => Promise<boolean>;
}

/** Hex SHA-256 of a buffer, using WebCrypto. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
        const digest = await crypto.subtle.digest('SHA-256', data);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The real runtime: fetch and verify wllama's wasm, then hold a loaded model.
 *
 * Loading is one-shot and lazy, mirroring `TinyDecideRanker`. The model itself is
 * supplied by the caller as a GGUF blob, because the local server path and the
 * in-process path share the same model catalogue in `llm.ts`.
 */
export class WllamaRuntime implements LocalRuntime {
        private instance: InstanceType<WllamaModule['Wllama']> | null = null;
        private loading: Promise<boolean> | null = null;
        /** Blob URLs for fetched assets, keyed by cache path. */
        private readonly assetUrls = new Map<string, string>();

        constructor(
                private readonly host: LocalRuntimeHost,
                private readonly model: { url: string; label: string },
                private readonly contextSize = 2048,
        ) {}

        get ready(): boolean {
                return this.instance !== null;
        }

        unload(): void {
                const instance = this.instance;
                this.instance = null;
                this.loading = null;
                void instance?.exit().catch(() => undefined);
                for (const url of this.assetUrls.values()) URL.revokeObjectURL(url);
                this.assetUrls.clear();
        }

        /**
         * Fetch, verify and cache an asset, then expose it as a blob URL.
         *
         * Serving the bytes back as a blob URL is what lets a plugin that ships as
         * three files use a runtime that is published as separate assets.
         */
        private async ensureAsset(path: string, url: string, expected: string, type: string): Promise<string> {
                const cachedUrl = this.assetUrls.get(path);
                if (cachedUrl) return cachedUrl;

                const verify =
                        this.host.verify ??
                        (async (data: ArrayBuffer, want: string) => (await sha256Hex(data)) === want);

                let bytes = await this.host.readFile(path).catch(() => null);
                if (bytes && !(await verify(bytes, expected))) bytes = null;
                if (!bytes) {
                        bytes = await this.host.download(url);
                        if (!(await verify(bytes, expected))) {
                                throw new Error(`The runtime asset at ${url} failed its integrity check.`);
                        }
                        await this.host.writeFile(path, bytes).catch(() => undefined);
                }

                const objectUrl = URL.createObjectURL(new Blob([bytes], { type }));
                this.assetUrls.set(path, objectUrl);
                return objectUrl;
        }

        async ensureModel(): Promise<boolean> {
                if (this.instance) return true;
                if (this.loading) return this.loading;
                this.loading = this.load();
                try {
                        return await this.loading;
                } finally {
                        this.loading = null;
                }
        }

        private async load(): Promise<boolean> {
                try {
                        const wasmUrl = await this.ensureAsset(
                                this.host.wasmPath,
                                WLLAMA_WASM_URL,
                                WASM_SHA256,
                                'application/wasm',
                        );
                        const moduleUrl = await this.ensureAsset(
                                this.host.modulePath,
                                WLLAMA_MODULE_URL,
                                MODULE_SHA256,
                                'text/javascript',
                        );
						// The URL is a blob built from bytes just hash-checked against MODULE_SHA256,
						// so this is not loading unverified remote code.
						// eslint-disable-next-line no-unsanitized/method -- the URL is a blob of bytes verified against MODULE_SHA256
                        const module = (await import(/* @vite-ignore */ moduleUrl)) as unknown as WllamaModule;
                        const instance = new module.Wllama({ default: wasmUrl }, { suppressNativeLog: true });
                        await instance.loadModelFromUrl(this.model.url, { n_ctx: this.contextSize });
                        this.instance = instance;
                        return true;
                } catch {
                        this.instance = null;
                        return false;
                }
        }

        async complete(
                messages: Array<{ role: string; content: string }>,
                options: Required<LocalDecodeOptions>,
        ): Promise<string> {
                if (!this.instance) throw new Error('The local model is not loaded.');
                const response = await this.instance.createChatCompletion({
                        messages,
                        max_tokens: options.maxTokens,
                        temperature: options.temperature,
                        sampling: localSamplingOptions(),
                });
                return response?.choices?.[0]?.message?.content ?? '';
        }
}

/** Tools are intentionally not exposed for in-process runs. */
export const NO_LOCAL_TOOLS: CuratorTool[] = [];

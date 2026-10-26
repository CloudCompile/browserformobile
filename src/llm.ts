/**
 * An LLM curator layered on top of the recommendation ranking.
 *
 * The ranking engine is good at "more like what you downloaded" and bad at
 * judgement: it cannot tell that you dropped a series, cannot weigh a synopsis
 * against your taste, and cannot go and look something up. This module gives a
 * small instruction model the ranked candidates plus tools, and asks it to pick
 * and order them.
 *
 * Two providers, both off by default:
 *
 * - **Local** — a GGUF model run through `node-llama-cpp`. Nothing leaves the
 *   device. Desktop only: the binding is a native module with no mobile build.
 * - **API** — any OpenAI-compatible chat endpoint. Works everywhere, including
 *   mobile, but sends the taste profile and candidate titles to a third party.
 *
 * Two tools are offered, and the split matters:
 *
 * - **Anime API** — native. Looks up a series on the user's own anime-api, so the
 *   model can check a synopsis or genre before choosing instead of guessing from
 *   the title alone.
 * - **Web search** — pluggable and off by default, because it is the only part
 *   that can reach an arbitrary third party.
 *
 * The model is never trusted with the list. `parseCuratorReply` accepts only
 * titles that were actually offered, so a hallucinated series cannot reach the
 * page, and a reply that names nothing usable leaves the deterministic ranking
 * untouched. The model re-orders and prunes; it does not invent.
 */

/** A model the user can run locally. Sizes are the quantised build. */
export interface LocalModelOption {
        id: string;
        /** Human label for the settings dropdown. */
        label: string;
        /** Hugging Face repository. */
        repo: string;
        /** File within the repository. */
        file: string;
        /** Approximate download size in megabytes. */
        sizeMb: number;
        /** Parameter count, for the label. */
        params: string;
        /** Rough guidance on whether a phone or a laptop is needed. */
        requirement: 'desktop' | 'desktop-powerful';
}

/**
 * Curated local models.
 *
 * Liquid AI's LFM2.5 line is the default because these are small, openly
 * licensed, and trained for exactly this kind of short judgement call. The 230M
 * build is the one to try first: at 149 MB it loads quickly and is good enough to
 * re-order a list, which is a far easier task than generation.
 */
export const LOCAL_MODELS: LocalModelOption[] = [
        {
                id: 'lfm2.5-230m',
                label: 'LFM2.5 230M (fastest, 149 MB)',
                repo: 'LiquidAI/LFM2.5-230M-GGUF',
                file: 'LFM2.5-230M-Q4_0.gguf',
                sizeMb: 149,
                params: '230M',
                requirement: 'desktop',
        },
        {
                id: 'lfm2.5-350m',
                label: 'LFM2.5 350M (balanced, 219 MB)',
                repo: 'LiquidAI/LFM2.5-350M-GGUF',
                file: 'LFM2.5-350M-Q4_0.gguf',
                sizeMb: 219,
                params: '350M',
                requirement: 'desktop',
        },
        {
                id: 'lfm2.5-1.2b',
                label: 'LFM2.5 1.2B Instruct (best quality, 696 MB)',
                repo: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
                file: 'LFM2.5-1.2B-Instruct-Q4_0.gguf',
                sizeMb: 696,
                params: '1.2B',
                requirement: 'desktop-powerful',
        },
];

/** Where a GGUF file is downloaded from. */
export function modelDownloadUrl(model: LocalModelOption): string {
        return `https://huggingface.co/${model.repo}/resolve/main/${model.file}`;
}

export function findLocalModel(id: string): LocalModelOption | null {
        return LOCAL_MODELS.find((model) => model.id === id) ?? null;
}

/**
 * How the curator reaches a model.
 *
 * Both working modes speak the OpenAI chat-completions API, which is why a single
 * client serves both:
 *
 * - `server` — a model running on the user's own machine or LAN (Ollama, LM Studio,
 *   llama.cpp's server). Nothing leaves their network, it works on mobile, and any
 *   GGUF works, including the LFM2.5 builds listed above.
 * - `api` — a hosted OpenAI-compatible endpoint. Works with no local setup, but
 *   the history and candidate titles go to that provider.
 *
 * In-process inference is deliberately not offered here. The obvious route, a
 * native binding such as node-llama-cpp, ships a `.node` binary per platform and
 * genuinely cannot load on mobile. A WebAssembly build of llama.cpp can run in a
 * WebView, so it is not impossible on mobile — but it is a large feature of its
 * own: a multi-megabyte `.wasm` to bundle, a separate 150 MB+ model download, a
 * memory footprint that mobile WebViews are quick to kill, and a decode loop with
 * sampling and grammar-constrained JSON that an encoder-only model does not need.
 * A local server reaches the same models today with none of that.
 */
export type LlmProvider = 'off' | 'server' | 'api';

/** Sensible defaults for the two working modes. */
export const DEFAULT_SERVER_BASE = 'http://localhost:11434/v1';
export const DEFAULT_SERVER_MODEL = 'lfm2.5:latest';

/** A candidate the curator may choose from. */
export interface CuratorCandidate {
        title: string;
        /** Catalogue votes, as a hint at how well regarded it is. */
        votes?: number;
        /** Why the deterministic ranking put it here. */
        because?: string[];
}

/**
 * The task given to the model.
 *
 * Kept terse and explicit. Small models follow a short numbered instruction far
 * better than a paragraph of context, and a JSON reply is asked for because it
 * parses reliably without a grammar.
 */
export function buildCuratorSystemPrompt(): string {
        return [
                'You are choosing what a user should watch next, from a list of candidates.',
                'You will be given their viewing history and the candidates.',
                'Pick the ones most likely to appeal to them and put them in order, best first.',
                '',
                'Rules:',
                '- Only use titles from the candidate list. Never invent a title.',
                '- Prefer variety; do not return many near-identical entries.',
                '- Weight the history: a series they finished matters more than one they tried.',
                '- If a title is unclear, you may look it up with the tools before deciding.',
                '- Reply with JSON only: {"picks": ["Title 1", "Title 2"]}.',
                'Return at most the requested number of picks.',
        ].join('\n');
}

/**
 * The user turn: history, then candidates, then the instruction.
 *
 * The history is capped so a large library cannot push the candidates out of the
 * model's context — the candidates are the part it has to reason about.
 *
 * The provenance (`because`) is deliberately **not** included. It was, and it made
 * a real 230M model split a seed name on its own punctuation: a candidate reading
 * `Erased — suggested by Steins;Gate` came back as the picks `"Steins"` and
 * `"Gate"`. The provenance is for display, and the model does not need it to
 * judge a title.
 */
export function buildCuratorUserPrompt(
        history: string[],
        candidates: CuratorCandidate[],
        limit: number,
): string {
        const lines: string[] = [];
        lines.push(`Viewing history: ${history.slice(0, 40).join(', ')}.`);
        lines.push('');
        lines.push('Candidates:');
        candidates.forEach((candidate, index) => {
                const votes = candidate.votes ? ` (${candidate.votes} votes)` : '';
                lines.push(`${index + 1}. ${candidate.title}${votes}`);
        });
        lines.push('');
        lines.push(`Choose the best ${limit} and reply with JSON only.`);
        return lines.join('\n');
}

/**
 * Pull the picks out of a model reply, keeping only real candidates.
 *
 * A small model will occasionally invent a plausible-sounding title, repeat one,
 * or answer in prose despite being asked for JSON. Everything here is built to
 * fail safe: unknown titles are dropped rather than shown, so the worst case is
 * a shorter list, never a phantom entry.
 */
export function parseCuratorReply(reply: string, allowed: string[], limit?: number): string[] {
        const allowedByLower = new Map(allowed.map((title) => [title.trim().toLowerCase(), title]));
        const picks: string[] = [];
        const seen = new Set<string>();

        const accept = (raw: string): void => {
                // Strip list numbering and quotes the model may have added.
                const cleaned = raw
                        .replace(/^\s*\d+\s*[.)]\s*/, '')
                        .replace(/^[-*]\s*/, '')
                        .trim()
                        .replace(/^["'`]|["'`,]+$/g, '')
                        .trim();
                if (!cleaned) return;
                const match = allowedByLower.get(cleaned.toLowerCase());
                if (!match) return;
                const key = match.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                picks.push(match);
        };

        // Preferred path: a JSON object or array anywhere in the reply.
        const jsonMatches = reply.match(/\{[\s\S]*\}|\[[\s\S]*\]/g);
        if (jsonMatches) {
                for (const block of jsonMatches) {
                        try {
                                const parsed = JSON.parse(block) as unknown;
                                const list = Array.isArray(parsed)
                                        ? parsed
                                        : ((parsed as { picks?: unknown; titles?: unknown })?.picks ??
                                                (parsed as { titles?: unknown })?.titles);
                                if (Array.isArray(list)) {
                                        for (const entry of list) {
                                                if (typeof entry === 'string') accept(entry);
                                        }
                                }
                        } catch {
                                /* Not JSON after all; fall through to line parsing. */
                        }
                }
        }

        if (picks.length === 0) {
                // Fallback: one title per line, in the order given.
                for (const line of reply.split(/\r?\n/)) accept(line);
        }
        // Asking for "the best N" is not a guarantee: a 230M model asked for three
        // picks returned five. Truncate here rather than trusting the instruction.
        return limit && limit > 0 ? picks.slice(0, limit) : picks;
}

/**
 * Re-order `ranked` to match the curator's picks.
 *
 * The picks come first in the model's order; anything the model left out keeps
 * its deterministic position after them, so a model that returns two titles
 * still leaves a full page rather than a two-item list.
 */
export function applyCuratorPicks<T extends { title: string }>(ranked: T[], picks: string[]): T[] {
        if (picks.length === 0) return ranked;
        const byLower = new Map(ranked.map((item) => [item.title.trim().toLowerCase(), item]));
        const chosen: T[] = [];
        const used = new Set<string>();
        for (const pick of picks) {
                const key = pick.trim().toLowerCase();
                const item = byLower.get(key);
                if (!item || used.has(key)) continue;
                used.add(key);
                chosen.push(item);
        }
        if (chosen.length === 0) return ranked;
        const rest = ranked.filter((item) => !used.has(item.title.trim().toLowerCase()));
        return [...chosen, ...rest];
}

/** One tool the model may call. */
export interface CuratorTool {
        name: string;
        description: string;
        /** JSON-schema-ish parameter description for the prompt and the API. */
        parameters: Record<string, unknown>;
        run(args: Record<string, unknown>): Promise<string>;
}

/**
 * The native anime API tool.
 *
 * This is what makes the curator better than a bare prompt: the model can check
 * what a candidate actually is — its synopsis, genres, whether it is even the
 * series it thinks it is — against the user's own API rather than guessing from
 * a title string.
 */
export function createAnimeApiTool(lookup: (title: string) => Promise<string | null>): CuratorTool {
        return {
                name: 'anime_lookup',
                description:
                        'Look up a series on the anime catalogue by name. Returns its synopsis, genres, ' +
                        'score and episode count. Use it when a candidate title is ambiguous or unfamiliar.',
                parameters: {
                        type: 'object',
                        properties: {
                                title: { type: 'string', description: 'The series name to look up.' },
                        },
                        required: ['title'],
                },
                async run(args) {
                        const title = typeof args.title === 'string' ? args.title : '';
                        if (!title) return 'No title given.';
                        try {
                                const result = await lookup(title);
                                return result ?? `No catalogue entry found for "${title}".`;
                        } catch {
                                return `Could not look up "${title}".`;
                        }
                },
        };
}

/**
 * The web search tool.
 *
 * Deliberately a seam rather than an implementation: search means sending the
 * query to a third party, so it is only offered when the user has configured an
 * endpoint, and the description says so.
 */
export function createWebSearchTool(
        search: ((query: string) => Promise<string | null>) | null,
): CuratorTool | null {
        if (!search) return null;
        return {
                name: 'web_search',
                description:
                        'Search the web. Use only when the catalogue has no entry for a title and you ' +
                        'need to identify it. The query is sent to the configured search provider.',
                parameters: {
                        type: 'object',
                        properties: {
                                query: { type: 'string', description: 'The search query.' },
                        },
                        required: ['query'],
                },
                async run(args) {
                        const query = typeof args.query === 'string' ? args.query : '';
                        if (!query) return 'No query given.';
                        try {
                                return (await search(query)) ?? 'No results.';
                        } catch {
                                return 'Search failed.';
                        }
                },
        };
}

/** What the curator needs from the outside, so it can be tested without a model. */
export interface CuratorDeps {
        /** Run a chat turn and return the assistant's text. */
        complete?(messages: Array<{ role: string; content: string }>, tools: CuratorTool[]): Promise<string>;
        /** Candidate titles the curator may return. */
        allowedTitles: string[];
        /** The viewing history, strongest first. */
        history: string[];
        /** How many picks to ask for. */
        limit?: number;
        /** Tools to expose. */
        tools?: CuratorTool[];
}

/**
 * Ask the model to curate, and apply what it says.
 *
 * Any failure — no provider, a model that will not load, a reply that parses to
 * nothing — returns the input unchanged, so the deterministic ranking is always
 * the floor and the model is only ever an improvement.
 */
export async function curateWithModel<T extends { title: string; because?: string[]; votes?: number }>(
        ranked: T[],
        deps: CuratorDeps,
): Promise<{ items: T[]; curated: boolean }> {
        if (!deps.complete || ranked.length === 0) return { items: ranked, curated: false };
        const limit = deps.limit ?? ranked.length;
        const candidates: CuratorCandidate[] = ranked.map((item) => ({
                title: item.title,
                votes: item.votes,
                because: item.because,
        }));
        const messages = [
                { role: 'system', content: buildCuratorSystemPrompt() },
                { role: 'user', content: buildCuratorUserPrompt(deps.history, candidates, limit) },
        ];
        let reply: string;
        try {
                reply = await deps.complete(messages, deps.tools ?? []);
        } catch {
                return { items: ranked, curated: false };
        }
        const picks = parseCuratorReply(reply, deps.allowedTitles, limit);
        if (picks.length === 0) return { items: ranked, curated: false };
        return { items: applyCuratorPicks(ranked, picks), curated: true };
}

/** Format a catalogue entry for the model to read. */
export function describeCatalogueEntry(entry: {
        title?: string | null;
        overview?: string | null;
        genres?: string[];
        score?: string | null;
        totalEpisodes?: number | null;
}): string {
        const parts: string[] = [];
        if (entry.title) parts.push(`Title: ${entry.title}`);
        if (entry.genres && entry.genres.length > 0) parts.push(`Genres: ${entry.genres.join(', ')}`);
        if (entry.score) parts.push(`Score: ${entry.score}`);
        if (entry.totalEpisodes) parts.push(`Episodes: ${entry.totalEpisodes}`);
        const overview = (entry.overview ?? '').replace(/\s+/g, ' ').trim();
        if (overview) parts.push(`Synopsis: ${overview.slice(0, 400)}`);
        return parts.join('\n');
}

/** One HTTP POST that returns JSON, injected so the client is testable. */
export interface LlmHttp {
        postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
}

export interface LlmClientOptions {
        /** Base URL, e.g. `http://localhost:11434/v1`. */
        baseUrl: string;
        /** Model name as the server knows it. */
        model: string;
        /** Bearer token. Empty for a local server that needs none. */
        apiKey?: string;
        /** How many tool-call rounds before giving up. */
        maxToolRounds?: number;
        /** Sampling temperature. Low, because this is a judgement task. */
        temperature?: number;
}

/** A message in the OpenAI chat format, including tool plumbing. */
interface ChatMessage {
        role: string;
        content?: string | null;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        tool_call_id?: string;
}

function normaliseBase(baseUrl: string): string {
        return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * A minimal OpenAI-compatible chat client with tool calling.
 *
 * Only the parts this plugin needs are implemented: a chat completion, and a
 * bounded tool loop. A model that calls the same tool forever is stopped by
 * `maxToolRounds`, and any HTTP or parse failure surfaces as a thrown error so
 * the caller can fall back to the deterministic ranking.
 */
export class LlmClient {
        constructor(
                private readonly http: LlmHttp,
                private readonly options: LlmClientOptions,
        ) {}

        /** Run one chat turn, resolving tool calls until the model answers in text. */
        async complete(
                messages: Array<{ role: string; content: string }>,
                tools: CuratorTool[],
        ): Promise<string> {
                const convo: ChatMessage[] = messages.map((message) => ({ ...message }));
                const rounds = this.options.maxToolRounds ?? 3;
                const byName = new Map(tools.map((tool) => [tool.name, tool]));

                for (let round = 0; round <= rounds; round++) {
                        const body: Record<string, unknown> = {
                                model: this.options.model,
                                messages: convo,
                                temperature: this.options.temperature ?? 0.2,
                        };
                        if (tools.length > 0 && round < rounds) {
                                body.tools = tools.map((tool) => ({
                                        type: 'function',
                                        function: {
                                                name: tool.name,
                                                description: tool.description,
                                                parameters: tool.parameters,
                                        },
                                }));
                                body.tool_choice = 'auto';
                        }
                        const response = await this.post(body);
                        const message = response?.choices?.[0]?.message;
                        if (!message) throw new Error('The model returned no message.');

                        const calls = message.tool_calls ?? [];
                        if (calls.length === 0 || round === rounds) {
                                return typeof message.content === 'string' ? message.content : '';
                        }

                        // Echo the assistant turn back, then answer each tool call.
                        convo.push({
                                role: 'assistant',
                                content: message.content ?? null,
                                tool_calls: calls,
                        });
                        for (const call of calls) {
                                convo.push({
                                        role: 'tool',
                                        tool_call_id: call.id,
                                        content: await this.runTool(byName, call),
                                });
                        }
                }
                return '';
        }

        private async runTool(
                byName: Map<string, CuratorTool>,
                call: { function: { name: string; arguments: string } },
        ): Promise<string> {
                const tool = byName.get(call.function.name);
                if (!tool) return `Unknown tool "${call.function.name}".`;
                let args: Record<string, unknown> = {};
                try {
                        const parsed = JSON.parse(call.function.arguments || '{}') as unknown;
                        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
                } catch {
                        return 'Could not read the tool arguments.';
                }
                try {
                        return await tool.run(args);
                } catch {
                        return 'The tool failed.';
                }
        }

        private async post(body: Record<string, unknown>): Promise<{
                choices?: Array<{ message?: ChatMessage }>;
        }> {
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
                const raw = await this.http.postJson(
                        `${normaliseBase(this.options.baseUrl)}/chat/completions`,
                        body,
                        headers,
                );
                if (raw && typeof raw === 'object') return raw;
                return {};
        }
}

/**
 * Check that a server is reachable and the model is present.
 *
 * Called from settings before the feature is enabled, so a wrong URL or a model
 * that was never pulled is reported at configuration time rather than surfacing
 * later as an unexplained empty list.
 */
export async function probeServer(
        http: LlmHttp,
        baseUrl: string,
        model: string,
): Promise<{ ok: boolean; models: string[]; message: string }> {
        const base = normaliseBase(baseUrl);
        if (!base) return { ok: false, models: [], message: 'No server URL set.' };
        try {
                const raw = (await http.postJson(`${base}/models`, {}, {})) as {
                        data?: Array<{ id?: string }>;
                };
                const models = (raw?.data ?? [])
                        .map((entry) => entry?.id)
                        .filter((id): id is string => typeof id === 'string');
                if (models.length === 0) {
                        return { ok: true, models, message: 'Server reachable, but it reported no models.' };
                }
                const wanted = model.trim().toLowerCase();
                const found = models.some(
                        (id) => id.toLowerCase() === wanted || id.toLowerCase().startsWith(wanted),
                );
                return {
                        ok: true,
                        models,
                        message: found
                                ? `Server reachable. Found ${model}.`
                                : `Server reachable, but "${model}" is not loaded. Available: ${models
                                          .slice(0, 5)
                                          .join(', ')}.`,
                };
        } catch (error) {
                return {
                        ok: false,
                        models: [],
                        message: `Could not reach ${base}: ${
                                error instanceof Error ? error.message : String(error)
                        }`,
                };
        }
}

/**
 * Gather catalogue facts about the leading candidates, without the model asking.
 *
 * The `server` and `api` providers let the model call a lookup tool itself. A
 * 230M model in the plugin cannot be trusted to do that reliably — it may never
 * call the tool, or call it with a mangled title — so for in-process runs the
 * facts are fetched up front and put in the prompt instead. The result is a
 * better answer for less work, at the cost of looking up a fixed slice rather
 * than only what the model is curious about.
 *
 * Only the leading candidates are looked up: they are the ones a re-ranking can
 * realistically promote, and the lookup is one round trip each.
 */
export async function gatherCatalogueNotes(
        candidates: Array<{ title: string }>,
        lookup: (title: string) => Promise<string | null>,
        limit = 8,
): Promise<string> {
        const slice = candidates.slice(0, limit);
        const notes = await Promise.all(
                slice.map(async (candidate) => {
                        try {
                                const note = await lookup(candidate.title);
                                return note?.trim() ? note.trim() : null;
                        } catch {
                                return null;
                        }
                }),
        );
        return notes.filter((note): note is string => note !== null).join('\n\n');
}

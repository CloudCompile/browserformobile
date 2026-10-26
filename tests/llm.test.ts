import { describe, expect, it, vi } from 'vitest';
import {
        applyCuratorPicks,
        buildCuratorSystemPrompt,
        buildCuratorUserPrompt,
        createAnimeApiTool,
        createWebSearchTool,
        curateWithModel,
        describeCatalogueEntry,
        findLocalModel,
        LOCAL_MODELS,
        modelDownloadUrl,
        parseCuratorReply,
        LlmClient,
        probeServer,
} from '../src/llm';

const RANKED = [
        { title: 'Hunter x Hunter', votes: 90 },
        { title: 'One Piece', votes: 80 },
        { title: 'Bleach', votes: 70 },
        { title: 'Naruto', votes: 60 },
];
const TITLES = RANKED.map((item) => item.title);

describe('local model catalogue', () => {
        it('offers small quantised builds only', () => {
                for (const model of LOCAL_MODELS) {
                        expect(model.sizeMb).toBeLessThanOrEqual(1024);
                        expect(model.file.endsWith('.gguf')).toBe(true);
                }
        });

        it('includes a Liquid AI LFM2.5 option', () => {
                expect(LOCAL_MODELS.some((model) => model.repo.includes('LiquidAI/LFM2.5'))).toBe(true);
        });

        it('builds a resolvable download URL', () => {
                const model = findLocalModel('lfm2.5-230m')!;
                expect(modelDownloadUrl(model)).toBe(
                        'https://huggingface.co/LiquidAI/LFM2.5-230M-GGUF/resolve/main/LFM2.5-230M-Q4_0.gguf',
                );
        });

        it('returns null for an unknown model', () => {
                expect(findLocalModel('nope')).toBeNull();
        });

        it('marks the large model as needing a powerful machine', () => {
                const big = findLocalModel('lfm2.5-1.2b')!;
                expect(big.requirement).toBe('desktop-powerful');
        });
});

describe('prompt building', () => {
        it('tells the model not to invent titles', () => {
                expect(buildCuratorSystemPrompt()).toMatch(/never invent/i);
        });

        it('lists every candidate with its vote count', () => {
                const prompt = buildCuratorUserPrompt(['Haikyuu!!'], [
                        { title: 'One Piece', votes: 80, because: ['Naruto'] },
                        { title: 'Bleach' },
                ], 2);
                expect(prompt).toContain('1. One Piece (80 votes)');
                expect(prompt).toContain('2. Bleach');
                expect(prompt).toContain('Choose the best 2');
        });

        it('keeps provenance out of the prompt', () => {
                // A real 230M model split a seed name on the punctuation of the
                // "— suggested by Steins;Gate" annotation, emitting "Steins" and
                // "Gate" as two separate picks. Provenance is for display only.
                const prompt = buildCuratorUserPrompt(['Haikyuu!!'], [
                        { title: 'Erased', votes: 30, because: ['Steins;Gate'] },
                ], 1);
                expect(prompt).not.toContain('suggested by');
                expect(prompt).not.toContain('Steins');
        });

        it('caps the history so it cannot crowd out the candidates', () => {
                const history = Array.from({ length: 100 }, (_, i) => `Series ${i}`);
                const prompt = buildCuratorUserPrompt(history, [{ title: 'X' }], 1);
                expect(prompt).toContain('Series 39');
                expect(prompt).not.toContain('Series 40');
        });
});

describe('parseCuratorReply', () => {
        it('reads a JSON picks object', () => {
                expect(parseCuratorReply('{"picks": ["Bleach", "Naruto"]}', TITLES)).toEqual([
                        'Bleach',
                        'Naruto',
                ]);
        });

        it('reads a bare JSON array', () => {
                expect(parseCuratorReply('["One Piece"]', TITLES)).toEqual(['One Piece']);
        });

        it('reads JSON wrapped in prose and fences', () => {
                const reply = 'Sure!\n```json\n{"picks": ["Bleach"]}\n```\nHope that helps.';
                expect(parseCuratorReply(reply, TITLES)).toEqual(['Bleach']);
        });

        it('drops titles that were never offered', () => {
                const reply = '{"picks": ["Bleach", "Sword Art Online", "Berserk"]}';
                expect(parseCuratorReply(reply, TITLES)).toEqual(['Bleach']);
        });

        it('is case and whitespace insensitive', () => {
                expect(parseCuratorReply('{"picks": ["  bLEACH  "]}', TITLES)).toEqual(['Bleach']);
        });

        it('removes duplicates', () => {
                expect(parseCuratorReply('{"picks": ["Bleach", "Bleach", "bleach"]}', TITLES)).toEqual([
                        'Bleach',
                ]);
        });

        it('falls back to line parsing when there is no JSON', () => {
                const reply = '1. Bleach\n2. Naruto';
                expect(parseCuratorReply(reply, TITLES)).toEqual(['Bleach', 'Naruto']);
        });

        it('returns nothing for an unusable reply', () => {
                expect(parseCuratorReply('I cannot help with that.', TITLES)).toEqual([]);
                expect(parseCuratorReply('', TITLES)).toEqual([]);
        });

        it('ignores a hallucinated list entirely', () => {
                const reply = '{"picks": ["Dragon Ball", "Berserk", "Monster"]}';
                expect(parseCuratorReply(reply, TITLES)).toEqual([]);
        });
});

describe('applyCuratorPicks', () => {
        it('puts picks first in the model order and keeps the rest', () => {
                const out = applyCuratorPicks(RANKED, ['Naruto', 'Bleach']);
                expect(out.map((item) => item.title)).toEqual([
                        'Naruto',
                        'Bleach',
                        'Hunter x Hunter',
                        'One Piece',
                ]);
        });

        it('leaves the list alone when there are no picks', () => {
                expect(applyCuratorPicks(RANKED, [])).toEqual(RANKED);
        });

        it('ignores unknown and duplicate picks', () => {
                const out = applyCuratorPicks(RANKED, ['Bleach', 'Nope', 'Bleach']);
                expect(out.map((item) => item.title)).toEqual([
                        'Bleach',
                        'Hunter x Hunter',
                        'One Piece',
                        'Naruto',
                ]);
        });
});

describe('curateWithModel', () => {
        it('applies the model order', async () => {
                const result = await curateWithModel(RANKED, {
                        allowedTitles: TITLES,
                        history: ['Haikyuu!!'],
                        complete: async () => '{"picks": ["Naruto", "Hunter x Hunter"]}',
                });
                expect(result.curated).toBe(true);
                expect(result.items[0].title).toBe('Naruto');
        });

        it('keeps the deterministic order when the model fails', async () => {
                const result = await curateWithModel(RANKED, {
                        allowedTitles: TITLES,
                        history: [],
                        complete: async () => {
                                throw new Error('model exploded');
                        },
                });
                expect(result.curated).toBe(false);
                expect(result.items).toEqual(RANKED);
        });

        it('keeps the deterministic order when the model hallucinates', async () => {
                const result = await curateWithModel(RANKED, {
                        allowedTitles: TITLES,
                        history: [],
                        complete: async () => '{"picks": ["Nonexistent Anime"]}',
                });
                expect(result.curated).toBe(false);
                expect(result.items).toEqual(RANKED);
        });

        it('does nothing without a provider', async () => {
                const result = await curateWithModel(RANKED, { allowedTitles: TITLES, history: [] });
                expect(result.curated).toBe(false);
        });

        it('passes the tools through to the provider', async () => {
                const complete = vi.fn(async () => '{"picks": ["Bleach"]}');
                const tool = createAnimeApiTool(async () => 'ok');
                await curateWithModel(RANKED, {
                        allowedTitles: TITLES,
                        history: [],
                        complete,
                        tools: [tool],
                });
                expect(complete.mock.calls[0]?.[1]).toEqual([tool]);
        });
});

describe('anime API tool', () => {
        it('returns the formatted lookup', async () => {
                const tool = createAnimeApiTool(async (title) => `Title: ${title}`);
                expect(await tool.run({ title: 'Bleach' })).toBe('Title: Bleach');
        });

        it('says so when the catalogue has no entry', async () => {
                const tool = createAnimeApiTool(async () => null);
                expect(await tool.run({ title: 'Obscure' })).toMatch(/No catalogue entry/);
        });

        it('reports a failure rather than throwing into the loop', async () => {
                const tool = createAnimeApiTool(async () => {
                        throw new Error('down');
                });
                expect(await tool.run({ title: 'Bleach' })).toMatch(/Could not look up/);
        });

        it('handles a missing argument', async () => {
                const tool = createAnimeApiTool(async () => 'x');
                expect(await tool.run({})).toBe('No title given.');
        });
});

describe('web search tool', () => {
        it('is absent unless a search function is supplied', () => {
                expect(createWebSearchTool(null)).toBeNull();
        });

        it('discloses that the query leaves the device', () => {
                const tool = createWebSearchTool(async () => 'results')!;
                expect(tool.description).toMatch(/sent to the configured search provider/i);
        });

        it('returns results and tolerates failure', async () => {
                const ok = createWebSearchTool(async (query) => `found ${query}`)!;
                expect(await ok.run({ query: 'x' })).toBe('found x');
                const bad = createWebSearchTool(async () => {
                        throw new Error('no');
                })!;
                expect(await bad.run({ query: 'x' })).toBe('Search failed.');
        });
});

describe('describeCatalogueEntry', () => {
        it('formats the useful fields', () => {
                const text = describeCatalogueEntry({
                        title: 'Bleach',
                        genres: ['Action', 'Supernatural'],
                        score: '8.2',
                        totalEpisodes: 366,
                        overview: 'A  teenager  becomes  a  soul reaper.',
                });
                expect(text).toContain('Title: Bleach');
                expect(text).toContain('Genres: Action, Supernatural');
                expect(text).toContain('Episodes: 366');
                expect(text).toContain('A teenager becomes a soul reaper.');
        });

        it('truncates a very long synopsis', () => {
                const text = describeCatalogueEntry({ overview: 'x'.repeat(1000) });
                expect(text.length).toBeLessThan(500);
        });

        it('copes with an empty entry', () => {
                expect(describeCatalogueEntry({})).toBe('');
        });
});

describe('LlmClient', () => {
  const http = (responses: unknown[]) => {
    const calls: Array<{url: string; body: any; headers: any}> = [];
    let i = 0;
    return {
      calls,
      postJson: async (url: string, body: any, headers: any) => {
        calls.push({url, body, headers});
        return responses[Math.min(i++, responses.length - 1)];
      },
    };
  };

  it('returns the assistant text on a plain reply', async () => {
    const h = http([{ choices: [{ message: { role: 'assistant', content: '{"picks":["A"]}' } }] }]);
    const client = new LlmClient(h, { baseUrl: 'http://localhost:11434/v1', model: 'lfm2.5' });
    const out = await client.complete([{ role: 'user', content: 'hi' }], []);
    expect(out).toBe('{"picks":["A"]}');
    expect(h.calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('strips a trailing slash from the base URL', async () => {
    const h = http([{ choices: [{ message: { content: 'x' } }] }]);
    const client = new LlmClient(h, { baseUrl: 'http://localhost:11434/v1/', model: 'm' });
    await client.complete([{ role: 'user', content: 'hi' }], []);
    expect(h.calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('sends a bearer token only when one is set', async () => {
    const h = http([{ choices: [{ message: { content: 'x' } }] }]);
    await new LlmClient(h, { baseUrl: 'http://h/v1', model: 'm' }).complete([], []);
    expect(h.calls[0].headers.Authorization).toBeUndefined();
    const h2 = http([{ choices: [{ message: { content: 'x' } }] }]);
    await new LlmClient(h2, { baseUrl: 'http://h/v1', model: 'm', apiKey: 'sk-1' }).complete([], []);
    expect(h2.calls[0].headers.Authorization).toBe('Bearer sk-1');
  });

  it('runs a tool call and feeds the result back', async () => {
    const h = http([
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'anime_lookup', arguments: '{"title":"Bleach"}' } },
      ] } }] },
      { choices: [{ message: { role: 'assistant', content: '{"picks":["Bleach"]}' } }] },
    ]);
    const seen: string[] = [];
    const tool = { name: 'anime_lookup', description: 'd', parameters: {},
      run: async (a: any) => { seen.push(a.title); return 'Title: Bleach'; } };
    const client = new LlmClient(h, { baseUrl: 'http://h/v1', model: 'm' });
    const out = await client.complete([{ role: 'user', content: 'hi' }], [tool]);
    expect(seen).toEqual(['Bleach']);
    expect(out).toBe('{"picks":["Bleach"]}');
    // The tool result must be echoed back in the second request.
    const second = h.calls[1].body.messages;
    expect(second.some((m: any) => m.role === 'tool' && m.content === 'Title: Bleach')).toBe(true);
  });

  it('advertises the tools to the model', async () => {
    const h = http([{ choices: [{ message: { content: 'x' } }] }]);
    const tool = { name: 'anime_lookup', description: 'looks up', parameters: { type: 'object' }, run: async () => '' };
    await new LlmClient(h, { baseUrl: 'http://h/v1', model: 'm' }).complete([], [tool]);
    expect(h.calls[0].body.tools[0].function.name).toBe('anime_lookup');
    expect(h.calls[0].body.tool_choice).toBe('auto');
  });

  it('stops a model that calls tools forever', async () => {
    const looping = { choices: [{ message: { content: null, tool_calls: [
      { id: 'c', type: 'function', function: { name: 'anime_lookup', arguments: '{}' } },
    ] } }] };
    const h = http([looping]);
    const tool = { name: 'anime_lookup', description: 'd', parameters: {}, run: async () => 'again' };
    const client = new LlmClient(h, { baseUrl: 'http://h/v1', model: 'm', maxToolRounds: 2 });
    await client.complete([], [tool]);
    expect(h.calls.length).toBeLessThanOrEqual(4);
  });

  it('tolerates an unknown tool and malformed arguments', async () => {
    const h = http([
      { choices: [{ message: { content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'nope', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'anime_lookup', arguments: 'not json' } },
      ] } }] },
      { choices: [{ message: { content: '{"picks":[]}' } }] },
    ]);
    const tool = { name: 'anime_lookup', description: 'd', parameters: {}, run: async () => 'ok' };
    const out = await new LlmClient(h, { baseUrl: 'http://h/v1', model: 'm' }).complete([], [tool]);
    expect(out).toBe('{"picks":[]}');
  });

  it('throws when the model returns no message', async () => {
    const h = http([{}]);
    const client = new LlmClient(h, { baseUrl: 'http://h/v1', model: 'm' });
    await expect(client.complete([], [])).rejects.toThrow();
  });
});

describe('probeServer', () => {
  it('reports the model as found', async () => {
    const http = { postJson: async () => ({ data: [{ id: 'lfm2.5:latest' }] }) };
    const r = await probeServer(http, 'http://localhost:11434/v1', 'lfm2.5:latest');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Found/);
  });

  it('names what is available when the model is missing', async () => {
    const http = { postJson: async () => ({ data: [{ id: 'llama3' }] }) };
    const r = await probeServer(http, 'http://localhost:11434/v1', 'lfm2.5');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/llama3/);
  });

  it('reports an unreachable server instead of throwing', async () => {
    const http = { postJson: async () => { throw new Error('ECONNREFUSED'); } };
    const r = await probeServer(http, 'http://localhost:11434/v1', 'lfm2.5');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Could not reach/);
  });

  it('rejects an empty URL', async () => {
    const http = { postJson: async () => ({}) };
    expect((await probeServer(http, '   ', 'm')).ok).toBe(false);
  });
});

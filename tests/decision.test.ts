import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildDecisionState, JevRanker, MAX_STATE_TOKENS, TinyDecideRanker, type DecisionDeps,
} from '../src/decision';

// The real weights, when they are present locally. CI has no copy, so the
// model-backed cases are skipped rather than faked.
const META = '/tmp/td/meta.json';
const BIN = '/tmp/td/model.bin';
let haveWeights = true;
try { readFileSync(META); readFileSync(BIN); } catch { haveWeights = false; }

function realDeps(): DecisionDeps {
  return {
    readModel: async () => {
      const b = readFileSync(BIN);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    readMeta: async () => {
      const b = readFileSync(META);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

describe('buildDecisionState', () => {
  it('lists the candidates after the profile', () => {
    expect(buildDecisionState('Likes Naruto.', ['Boruto'])).toBe('Likes Naruto. Candidates: Boruto.');
  });
  it('keeps the state inside the model token budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => `Some Very Long Candidate Title Number ${i}`);
    const state = buildDecisionState('Likes Naruto.', many);
    expect(state.split(/\s+/).length).toBeLessThan(MAX_STATE_TOKENS);
  });
  it('never truncates the profile away entirely', () => {
    const state = buildDecisionState('Likes Naruto and Bleach.', []);
    expect(state).toBe('Likes Naruto and Bleach.');
  });
});

describe('TinyDecideRanker (no weights available)', () => {
  it('reports failure instead of pretending to have scores', async () => {
    const ranker = new TinyDecideRanker({});
    expect(await ranker.ensureLoaded()).toBe(false);
    expect(ranker.ready).toBe(false);
    expect(ranker.score('profile', ['A']).size).toBe(0);
  });
  it('survives a download that throws', async () => {
    const ranker = new TinyDecideRanker({ download: async () => { throw new Error('offline'); } });
    expect(await ranker.ensureLoaded()).toBe(false);
  });
});

describe('JevRanker', () => {
  it('sends the profile and maps answers back onto titles', async () => {
    let seen: any = null;
    const ranker = new JevRanker({
      postJson: async (url, body, headers) => {
        seen = { url, body, headers };
        return { answers: { candidate_0: { noul: 0.9 }, candidate_1: { noul: 0.1 } } };
      },
    });
    const scores = await ranker.score('Likes Naruto.', ['Boruto', 'Bocchi'], 'key-123');
    expect(scores.get('Boruto')).toBe(0.9);
    expect(scores.get('Bocchi')).toBe(0.1);
    expect(seen.url).toContain('typesafe.ai');
    expect(seen.headers.Authorization).toBe('Bearer key-123');
    expect(seen.body.state).toContain('Likes Naruto.');
  });
  it('returns nothing without a key, so no request is made', async () => {
    let called = false;
    const ranker = new JevRanker({ postJson: async () => { called = true; return {}; } });
    expect((await ranker.score('p', ['A'], '')).size).toBe(0);
    expect(called).toBe(false);
  });
  it('returns nothing when the request fails', async () => {
    const ranker = new JevRanker({ postJson: async () => { throw new Error('503'); } });
    expect((await ranker.score('p', ['A'], 'k')).size).toBe(0);
  });
});

describe.runIf(haveWeights)('TinyDecideRanker (real weights)', () => {
  it('loads and scores every candidate', async () => {
    const ranker = new TinyDecideRanker(realDeps());
    expect(await ranker.ensureLoaded()).toBe(true);
    expect(ranker.ready).toBe(true);
    const titles = ['Jujutsu Kaisen', 'Bocchi the Rock', 'Kaguya-sama Love is War'];
    const scores = ranker.score('User likes Naruto, Bleach: Action, Adventure, Shounen.', titles);
    expect(scores.size).toBe(titles.length);
    for (const value of scores.values()) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // The shounen action title should outrank the slice-of-life comedy for a
    // shounen action profile.
    expect(scores.get('Jujutsu Kaisen')!).toBeGreaterThan(scores.get('Bocchi the Rock')!);
  }, 120_000);

  it('caches the weights so the second load does not refetch', async () => {
    let downloads = 0;
    const store = new Map<string, ArrayBuffer>();
    const deps: DecisionDeps = {
      download: async (url) => {
        downloads++;
        const file = url.endsWith('meta.json') ? META : BIN;
        const b = readFileSync(file);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      readModel: async () => store.get('model') ?? null,
      writeModel: async (d) => { store.set('model', d); },
      readMeta: async () => store.get('meta') ?? null,
      writeMeta: async (d) => { store.set('meta', d); },
    };
    const first = new TinyDecideRanker(deps);
    expect(await first.ensureLoaded()).toBe(true);
    expect(downloads).toBe(2);
    const second = new TinyDecideRanker(deps);
    expect(await second.ensureLoaded()).toBe(true);
    expect(downloads).toBe(2);
  }, 120_000);
});

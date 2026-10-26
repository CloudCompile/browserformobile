import { describe, expect, it } from 'vitest';
import { buildTasteProfile, rankRecommendations, tokenize, bm25Scores, blendModelScores, dampEngagement, diversify } from './src/recommend';

describe('tokenize', () => {
  it('drops stop words and single chars', () => {
    expect(tokenize('The Future of Naruto: Shippuuden')).toEqual(['future','naruto','shippuuden']);
  });
  it('keeps CJK runs whole', () => {
    expect(tokenize('進撃の巨人')).toEqual(['進撃の巨人']);
  });
});

describe('buildTasteProfile', () => {
  it('weights watched higher than downloaded and sorts desc', () => {
    const p = buildTasteProfile([{series:'Naruto'},{series:'Naruto'},{series:'Bleach'}],[{series:'Naruto',watched:true}]);
    // Naruto accrues 2 downloads + a completed watch = 4 raw, damped to 3.32.
    expect(p[0]).toEqual({series:'Naruto',weight:3.32});
    expect(p[1]).toEqual({series:'Bleach',weight:2});
    expect(p[0].weight).toBeGreaterThan(p[1].weight);
  });
});

describe('rankRecommendations', () => {
  const seeds = [{series:'Naruto',weight:10},{series:'Bleach',weight:2}];
  it('removes titles already downloaded', () => {
    const r = rankRecommendations(seeds, [{id:1,title:'Naruto',votes:5},{id:2,title:'Jujutsu Kaisen',votes:5}], ['Naruto']);
    expect(r.map(x=>x.title)).not.toContain('Naruto');
  });
  it('prefers the candidate from the stronger seed', () => {
    const r = rankRecommendations(seeds, [
      {id:1,title:'Boruto',votes:100,fromSeed:'Naruto'},
      {id:2,title:'Bleach Movie',votes:100,fromSeed:'Bleach'},
    ]);
    expect(r[0].title).toBe('Boruto');
  });
  it('merges candidates from several seeds and records why', () => {
    const r = rankRecommendations(seeds, [
      {id:1,title:'Jujutsu Kaisen',votes:10,fromSeed:'Naruto'},
      {id:1,title:'Jujutsu Kaisen',votes:10,fromSeed:'Bleach'},
    ]);
    expect(r.length).toBe(1);
    expect(r[0].because.sort()).toEqual(['Bleach','Naruto']);
  });
  it('ranks an on-genre title above an off-genre one with equal votes', () => {
    const r = rankRecommendations([{series:'Naruto',weight:5}], [
      {id:1,title:'Bocchi the Rock!',tags:['Comedy','Music'],votes:50,fromSeed:'Naruto'},
      {id:2,title:'Naruto Shippuuden',tags:['Action','Adventure','Shounen'],votes:50,fromSeed:'Naruto'},
    ]);
    expect(r[0].title).toBe('Naruto Shippuuden');
  });
  it('is deterministic', () => {
    const args = [seeds, [{id:1,title:'A',votes:1},{id:2,title:'B',votes:1}]] as const;
    expect(rankRecommendations(...(args as any))).toEqual(rankRecommendations(...(args as any)));
  });
});

describe('rankRecommendations images', () => {
  it('carries the poster through to the ranked output', () => {
    const r = rankRecommendations([{series:'Naruto',weight:1}], [
      {id:1,title:'Boruto',image:'https://img/boruto.jpg',votes:5,fromSeed:'Naruto'},
    ]);
    expect(r[0].image).toBe('https://img/boruto.jpg');
  });
  it('keeps the first poster when several seeds point at one title', () => {
    const r = rankRecommendations([{series:'Naruto',weight:1},{series:'Bleach',weight:1}], [
      {id:1,title:'Boruto',image:'https://img/a.jpg',votes:5,fromSeed:'Naruto'},
      {id:1,title:'Boruto',image:'https://img/b.jpg',votes:5,fromSeed:'Bleach'},
    ]);
    expect(r[0].image).toBe('https://img/a.jpg');
  });
  it('fills in a poster when the first candidate for a title had none', () => {
    const r = rankRecommendations([{series:'Naruto',weight:1},{series:'Bleach',weight:1}], [
      {id:1,title:'Boruto',votes:5,fromSeed:'Naruto'},
      {id:1,title:'Boruto',image:'https://img/b.jpg',votes:5,fromSeed:'Bleach'},
    ]);
    expect(r[0].image).toBe('https://img/b.jpg');
  });
});

describe('bm25Scores', () => {
  it('scores all-zero when nothing matches', () => {
    expect(bm25Scores('naruto', [{id:1,title:'Cooking Show'}])).toEqual([0]);
  });
});

describe('blendModelScores', () => {
  it('leaves order alone when the model is neutral', () => {
    const ranked = rankRecommendations([{series:'Naruto',weight:1}], [{id:1,title:'A',votes:10},{id:2,title:'B',votes:1}]);
    const out = blendModelScores(ranked, new Map([['A',0.5],['B',0.5]]));
    expect(out.map(x=>x.title)).toEqual(ranked.map(x=>x.title));
  });
  it('promotes a candidate the model strongly likes', () => {
    const ranked = rankRecommendations([{series:'Naruto',weight:1}], [{id:1,title:'A',votes:10},{id:2,title:'B',votes:1}]);
    const out = blendModelScores(ranked, new Map([['A',0.0],['B',1.0]]), 1.0);
    expect(out[0].title).toBe('B');
  });
});

describe('dampEngagement', () => {
  it('keeps a single download meaningful', () => {
    expect(dampEngagement(1)).toBe(2);
  });
  it('grows with engagement but far slower than linearly', () => {
    const one = dampEngagement(1);
    const twentyFive = dampEngagement(25);
    expect(twentyFive).toBeGreaterThan(one);
    expect(twentyFive / one).toBeLessThan(4); // raw ratio is 25x
  });
  it('is monotonic', () => {
    const values = [1, 2, 5, 12, 25, 60, 200].map(dampEngagement);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i-1]);
  });
  it('treats zero and nonsense as zero engagement', () => {
    expect(dampEngagement(0)).toBe(1);
    expect(dampEngagement(-5)).toBe(1);
    expect(dampEngagement(Number.NaN)).toBe(1);
  });
});

describe('buildTasteProfile damping', () => {
  it('stops one binge-watched series from dominating the profile', () => {
    const runs = [
      ...Array.from({length: 25}, () => ({series: 'Haikyuu!!'})),
      {series: 'Bleach'}, {series: 'Naruto'}, {series: 'One Piece'},
    ];
    const profile = buildTasteProfile(runs, []);
    const haikyuu = profile.find(p => p.series === 'Haikyuu!!')!;
    const bleach = profile.find(p => p.series === 'Bleach')!;
    expect(haikyuu.weight / bleach.weight).toBeLessThan(3); // was 25
    expect(profile[0].series).toBe('Haikyuu!!'); // still the strongest
  });
});

describe('diversify', () => {
  const rec = (title: string, score: number, because: string[]) => ({
    id: null, title, score, because, votes: 0, image: null,
  });

  it('stops one seed from filling the list when other seeds can supply titles', () => {
    // The real case: one binge-watched series contributes far more candidates
    // than any other, but there are plenty of other seeds to draw on.
    const ranked = [
      ...Array.from({length: 10}, (_, i) => rec(`Haikyuu pick ${i}`, 10 - i * 0.1, ['Haikyuu!!'])),
      ...['Bleach','Naruto','One Piece','Bebop'].flatMap((seed) =>
        Array.from({length: 4}, (_, i) => rec(`${seed} pick ${i}`, 5 - i * 0.1, [seed]))),
    ];
    const out = diversify(ranked, { limit: 8, maxPerSeed: 2 });
    const credited = out.filter(r => r.because[0] === 'Haikyuu!!');
    expect(credited.length).toBeLessThanOrEqual(2);
    expect(new Set(out.map(r => r.because[0])).size).toBeGreaterThan(2);
  });

  it('backfills rather than returning a short list when the pool is too small for the cap', () => {
    // Two seeds, room for eight, cap of two: the cap cannot be met, and a full
    // page beats an almost-empty one. The tail still alternates rather than
    // stacking on the higher-scoring seed.
    const ranked = [
      ...Array.from({length: 10}, (_, i) => rec(`Haikyuu pick ${i}`, 10 - i * 0.1, ['Haikyuu!!'])),
      ...Array.from({length: 10}, (_, i) => rec(`Bleach pick ${i}`, 5 - i * 0.1, ['Bleach'])),
    ];
    const out = diversify(ranked, { limit: 8, maxPerSeed: 2 });
    expect(out).toHaveLength(8);
    const haikyuu = out.filter(r => r.because[0] === 'Haikyuu!!').length;
    expect(haikyuu).toBeLessThanOrEqual(5); // spread, not 8-0
    expect(out[0].title).toBe('Haikyuu pick 0'); // strongest still first
  });

  it('returns a short list rather than inventing candidates', () => {
    const out = diversify([rec('A', 2, ['S'])], { limit: 6 });
    expect(out).toHaveLength(1);
  });

  it('credits a candidate to its least-represented seed', () => {
    const ranked = [
      rec('A', 5, ['Haikyuu!!']),
      rec('B', 4, ['Haikyuu!!']),
      rec('C', 3, ['Haikyuu!!', 'Bleach']), // Bleach is unrepresented
    ];
    const out = diversify(ranked, { limit: 3, maxPerSeed: 2 });
    const c = out.find(r => r.title === 'C')!;
    expect(c.because[0]).toBe('Bleach');
  });

  it('leaves a single-seed history alone', () => {
    const ranked = [rec('A', 3, ['Only']), rec('B', 2, ['Only']), rec('C', 1, ['Only'])];
    const out = diversify(ranked, { limit: 3, maxPerSeed: 3 });
    expect(out.map(r => r.title)).toEqual(['A', 'B', 'C']);
  });

  it('keeps the list ordered by score', () => {
    const ranked = [
      rec('A', 9, ['S1']), rec('B', 8, ['S2']), rec('C', 7, ['S1']),
      rec('D', 6, ['S2']), rec('E', 5, ['S3']),
    ];
    const out = diversify(ranked, { limit: 5, maxPerSeed: 1 });
    for (let i = 1; i < out.length; i++) expect(out[i-1].score).toBeGreaterThanOrEqual(out[i].score);
  });

  it('handles candidates with no provenance', () => {
    const out = diversify([rec('A', 2, [])], { limit: 5 });
    expect(out).toHaveLength(1);
  });
});

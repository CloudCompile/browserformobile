import { describe, expect, it } from 'vitest';
import { buildTasteProfile, rankRecommendations, tokenize, bm25Scores, blendModelScores } from './src/recommend';

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
    expect(p[0]).toEqual({series:'Naruto',weight:4});
    expect(p[1]).toEqual({series:'Bleach',weight:1});
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

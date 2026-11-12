import { describe, it, expect } from 'vitest';
import {
	MAX_METADATA_BYTES,
	MAX_METADATA_ENTRIES,
	MetadataStore,
	parseMetadata,
	pruneMetadata,
	type SeriesMetadata,
} from '../src/metadataStore';

/** A details answer shaped like the API's preview payload. */
function preview(title: string, poster = 'https://cdn.example/poster.jpg'): unknown {
	return {
		source: 'jikan',
		malId: 1,
		detail: {
			id: 1,
			title,
			image: poster,
			synopsis: `Synopsis of ${title}, long enough to have some weight in the byte total.`,
			episodes: 12,
			score: 7.5,
			genres: ['Adventure'],
		},
		characters: [],
		staff: [],
		// The real field name: the catalogue's own recommendation list.
		recommended: [
			{ id: 9, title: 'Companion Piece', image: 'https://cdn.example/other.jpg', votes: 42 },
			{ id: null, title: '', image: null, votes: null },
		],
		themes: [],
	};
}
function entry(title: string, savedAt: number, bytes = 100): SeriesMetadata {
	return { key: title.toLowerCase(), title, poster: null, payload: {}, savedAt, bytes };
}

describe('MetadataStore', () => {
	it('keeps a details answer and reads it back by key or title', () => {
		const store = new MetadataStore();
		store.set('Naruto ', preview('Naruto'));
		const got = store.get('naruto');
		expect(got?.title).toBe('Naruto');
		expect(got?.poster).toBe('https://cdn.example/poster.jpg');
		// The payload is kept verbatim for stale-while-revalidate rendering.
		expect((got?.payload as { detail: { title: string } }).detail.title).toBe('Naruto');
		expect(store.posterFor('NARUTO')).toBe('https://cdn.example/poster.jpg');
	});

	it('returns null for anything never browsed', () => {
		const store = new MetadataStore();
		expect(store.get('Fate')).toBeNull();
		expect(store.posterFor('Fate')).toBeNull();
		expect(store.recommendationsFor('Fate')).toEqual([]);
	});

	it('replaces a series and refreshes its eviction age', () => {
		const store = new MetadataStore();
		store.set('Naruto', preview('Naruto'));
		const first = store.get('naruto');
		// A re-browse writes again: same key, newer payload.
		store.set('Naruto', preview('Naruto', 'https://cdn.example/new.jpg'));
		expect(store.get('naruto')?.poster).toBe('https://cdn.example/new.jpg');
		expect(store.get('naruto')?.savedAt).toBeGreaterThanOrEqual(first?.savedAt ?? 0);
	});

	it('rejects an empty key or a non-object payload', () => {
		const store = new MetadataStore();
		expect(store.set('   ', preview('X'))).toBeNull();
		expect(store.set('X', 'a string')).toBeNull();
		expect(store.get('x')).toBeNull();
	});

	it('survives a persistence round-trip, dropping unusable records', () => {
		const store = new MetadataStore();
		store.set('Naruto', preview('Naruto'));
		const restored = new MetadataStore();
		restored.load({ naruto: store.toJSON()['naruto'], broken: { no: 'payload' }, junk: 4 });
		expect(restored.get('naruto')?.title).toBe('Naruto');
		expect(restored.get('broken')).toBeNull();
	});

	it('maps the kept recommended block into the offline fallback', () => {
		const store = new MetadataStore();
		store.set('Naruto', preview('Naruto'));
		const items = store.recommendationsFor('naruto');
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toBe('Companion Piece');
		expect(items[0]?.votes).toBe(42);
		expect(items[0]?.image).toBe('https://cdn.example/other.jpg');
		expect(items[0]?.because).toEqual(['Naruto']);
	});
});

describe('pruneMetadata', () => {
	it('evicts the oldest-saved entries over the entry cap', () => {
		const entries = new Map<string, SeriesMetadata>();
		for (let index = 0; index < MAX_METADATA_ENTRIES + 10; index++) {
			const item = entry(`Series ${index}`, 1_000 + index);
			entries.set(item.key, item);
		}
		pruneMetadata(entries);
		expect(entries.size).toBe(MAX_METADATA_ENTRIES);
		// The ten oldest (lowest savedAt) are the ones gone.
		expect(entries.has('series 0')).toBe(false);
		expect(entries.has('series 9')).toBe(false);
		expect(entries.has('series 10')).toBe(true);
		expect(entries.has(`series ${MAX_METADATA_ENTRIES + 9}`)).toBe(true);
	});

	it('evicts by bytes, oldest first, however few entries', () => {
		const entries = new Map<string, SeriesMetadata>([
			['big-old', { ...entry('Big old', 1, 900_000) }],
			['small-old', entry('Small old', 2, 900_000)],
			['new', entry('New', 3, 100_000)],
		]);
		pruneMetadata(entries, MAX_METADATA_ENTRIES, MAX_METADATA_BYTES);
		// Two megabytes of cap: the two 0.9 MB entries fit together, but with
		// the third the oldest goes first.
		expect(entries.has('new')).toBe(true);
		expect(entries.size).toBeLessThanOrEqual(3);
	});

	it('keeps everything under both caps', () => {
		const entries = new Map<string, SeriesMetadata>([
			['a', entry('a', 1, 500)],
			['b', entry('b', 2, 500)],
		]);
		pruneMetadata(entries, MAX_METADATA_ENTRIES, MAX_METADATA_BYTES);
		expect(entries.size).toBe(2);
	});
});

describe('parseMetadata', () => {
	it('fills defaults for a record missing its numbers', () => {
		const parsed = parseMetadata({ key: 'Naruto', payload: { detail: {} } });
		expect(parsed?.title).toBe('Naruto');
		expect(parsed?.savedAt).toBe(0);
		expect(parsed?.bytes).toBeGreaterThan(0);
	});

	it('rejects a record with no key or no payload', () => {
		expect(parseMetadata({ payload: {} })).toBeNull();
		expect(parseMetadata({ key: 'x' })).toBeNull();
		expect(parseMetadata(null)).toBeNull();
		expect(parseMetadata('nope')).toBeNull();
	});
});

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
	Mp4Error,
	ProgressiveMp4Builder,
	convertFragmented,
	encodeIndexHeader,
	encodeIndexRecord,
	mdatHeader,
	parseFragments,
	readIndex,
	type ParsedFragment,
} from '../src/mp4';
import { inspectDurationEnhanced, needsRepair, repairDuration } from '../src/doctor';
import { TransmuxStream } from '../src/transmux';

/**
 * The module is tested against synthetic fragments rather than mux.js output,
 * because the interesting cases — a re-emitted sample, an overlap, a gap — are
 * ones a real stream produces only at flush seams. The end of the file drives
 * the real transmuxer over the mux.js fixture, which is the only way to know
 * the parser agrees with the shape mux.js actually emits.
 */

// ---------------------------------------------------------------------------
// Building boxes
// ---------------------------------------------------------------------------

function box(type: string, ...children: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(8 + children.reduce((sum, child) => sum + child.byteLength, 0));
	new DataView(out.buffer).setUint32(0, out.byteLength);
	for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
	let at = 8;
	for (const child of children) {
		out.set(child, at);
		at += child.byteLength;
	}
	return out;
}

function fullBox(type: string, version: number, flags: number, ...children: Uint8Array[]): Uint8Array {
	const head = new Uint8Array(4);
	new DataView(head.buffer).setUint32(0, ((version << 24) | flags) >>> 0);
	return box(type, head, ...children);
}

function u32(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0);
	return out;
}

function zeros(count: number): Uint8Array {
	return new Uint8Array(count);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

const MOVIE_TIMESCALE = 90000;

interface TrackSpec {
	id: number;
	timescale: number;
	handler: 'vide' | 'soun';
}

/** A minimal init segment carrying everything the builder reads off one. */
function initSegment(tracks: TrackSpec[]): Uint8Array {
	const ftyp = box('ftyp', new TextEncoder().encode('isom'), u32(512), new TextEncoder().encode('isomiso2'));
	const mvhd = fullBox(
		'mvhd',
		0,
		0,
		u32(0),
		u32(0),
		u32(MOVIE_TIMESCALE),
		u32(0),
		u32(0x00010000),
		zeros(2 + 2 + 8 + 36 + 24 + 4),
	);
	const traks = tracks.map((track) => {
		const tkhd = fullBox('tkhd', 0, 0, u32(0), u32(0), u32(track.id), u32(0), u32(0), zeros(60));
		const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(0), zeros(4));
		const hdlr = fullBox(
			'hdlr',
			0,
			0,
			u32(0),
			new TextEncoder().encode(track.handler),
			zeros(12),
			new TextEncoder().encode('test\0'),
		);
		const mediaHeader = track.handler === 'vide' ? fullBox('vmhd', 0, 1, u32(0), zeros(8)) : fullBox('smhd', 0, 0, u32(0), zeros(4));
		const stsd = fullBox('stsd', 0, 0, u32(1), box(track.handler === 'vide' ? 'avc1' : 'mp4a', zeros(8)));
		const stbl = box('stbl', stsd);
		return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mediaHeader, stbl)));
	});
	return concat(ftyp, box('moov', mvhd, ...traks));
}

interface SampleSpec {
	duration: number;
	size: number;
	nonSync?: boolean;
	cts?: number;
}

/**
 * One `moof`/`mdat` pair in the shape mux.js writes: `tfhd` with
 * `default-base-is-moof`, an explicit `tfdt`, and a `trun` carrying every
 * per-sample field. The payload is filled with a marker so a chunk offset can
 * be checked against the bytes it points at.
 */
function makeFragment(trackId: number, baseDecodeTime: number, samples: SampleSpec[]): Uint8Array {
	const tfhd = fullBox('tfhd', 0, 0x020000, u32(trackId));
	const tfdt = fullBox('tfdt', 0, 0, u32(baseDecodeTime));
	const trun = (dataOffset: number): Uint8Array => {
		const body = new Uint8Array(8 + samples.length * 16);
		const view = new DataView(body.buffer);
		view.setUint32(0, samples.length);
		view.setInt32(4, dataOffset);
		samples.forEach((sample, index) => {
			view.setUint32(8 + index * 16, sample.duration);
			view.setUint32(12 + index * 16, sample.size);
			view.setUint32(16 + index * 16, sample.nonSync ? 0x00010000 : 0x02000000);
			view.setInt32(20 + index * 16, sample.cts ?? 0);
		});
		return fullBox('trun', 0, 0x000f01, body);
	};
	// `data_offset` is relative to the moof, and the mdat header follows it, so
	// the length has to be known before the box can be built.
	const moofLength = 8 + box('traf', tfhd, tfdt, trun(0)).byteLength;
	const moof = box('traf', tfhd, tfdt, trun(moofLength + 8));
	const payload = samples.reduce((sum, sample) => sum + sample.size, 0);
	const mdat = mdatHeader(payload);
	const media = new Uint8Array(payload).fill(0xab);
	return concat(box('moof', moof), mdat, media);
}

// ---------------------------------------------------------------------------
// Reading boxes back
// ---------------------------------------------------------------------------

interface Found {
	type: string;
	start: number;
	end: number;
	content: number;
}

function walk(data: Uint8Array, start = 0, end = data.byteLength): Found[] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const found: Found[] = [];
	let at = start;
	while (at + 8 <= end) {
		const size = view.getUint32(at);
		if (size < 8 || at + size > end) break;
		found.push({ type: typeAt(data, at + 4), start: at, end: at + size, content: at + 8 });
		at += size;
	}
	return found;
}

function typeAt(data: Uint8Array, at: number): string {
	return String.fromCharCode(data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 0);
}

function child(data: Uint8Array, parent: Found, type: string): Found | null {
	return walk(data, parent.content, parent.end).find((entry) => entry.type === type) ?? null;
}

function path(data: Uint8Array, root: Found, ...names: string[]): Found | null {
	let node: Found | null = root;
	for (const name of names) {
		if (!node) return null;
		node = child(data, node, name);
	}
	return node;
}

interface TrackTables {
	id: number;
	timescale: number;
	tkhdDuration: number;
	mdhdDuration: number;
	runs: { count: number; delta: number }[];
	sizes: number[];
	sync: number[];
	offsets: number[];
	chunkRuns: { first: number; count: number }[];
	ctts: { count: number; offset: number }[] | null;
}

function trackIdOf(data: Uint8Array, tkhd: Found): number {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const version = view.getUint8(tkhd.content);
	const offset = tkhd.content + (version === 1 ? 20 : 12);
	return view.getUint32(offset);
}

function durationOf(data: Uint8Array, boxFound: Found): number {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const version = view.getUint8(boxFound.content);
	const isTkhd = boxFound.type === 'tkhd';
	if (version === 1) return Number(view.getBigUint64(boxFound.content + (isTkhd ? 28 : 24)));
	return view.getUint32(boxFound.content + (isTkhd ? 20 : 16));
}

function timescaleOf(data: Uint8Array, boxFound: Found): number {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const version = view.getUint8(boxFound.content);
	return view.getUint32(boxFound.content + (version === 1 ? 20 : 12));
}

/** Every table a player reads, per track, out of a finished `moov`. */
function readMovie(data: Uint8Array): { tracks: TrackTables[]; mvhdDuration: number; hasMvex: boolean } {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const moov = walk(data).find((entry) => entry.type === 'moov');
	if (!moov) throw new Error('no moov');
	const mvhd = child(data, moov, 'mvhd');
	if (!mvhd) throw new Error('no mvhd');
	const tracks = walk(data, moov.content, moov.end)
		.filter((entry) => entry.type === 'trak')
		.map((trak) => {
			const tkhd = path(data, trak, 'tkhd');
			const mdhd = path(data, trak, 'mdia', 'mdhd');
			const stbl = path(data, trak, 'mdia', 'minf', 'stbl');
			if (!tkhd || !mdhd || !stbl) throw new Error('incomplete trak');
			const stts = child(data, stbl, 'stts');
			const stsz = child(data, stbl, 'stsz');
			const stss = child(data, stbl, 'stss');
			const stco = child(data, stbl, 'stco');
			const stsc = child(data, stbl, 'stsc');
			const ctts = child(data, stbl, 'ctts');
			if (!stts || !stsz || !stco || !stsc) throw new Error('incomplete stbl');
			const runs: { count: number; delta: number }[] = [];
			const runCount = view.getUint32(stts.content + 4);
			for (let index = 0; index < runCount; index++) {
				runs.push({
					count: view.getUint32(stts.content + 8 + index * 8),
					delta: view.getUint32(stts.content + 12 + index * 8),
				});
			}
			const sizes: number[] = [];
			const sampleCount = view.getUint32(stsz.content + 8);
			for (let index = 0; index < sampleCount; index++) {
				sizes.push(view.getUint32(stsz.content + 12 + index * 4));
			}
			const sync: number[] = [];
			if (stss) {
				const syncCount = view.getUint32(stss.content + 4);
				for (let index = 0; index < syncCount; index++) sync.push(view.getUint32(stss.content + 8 + index * 4));
			}
			const offsets: number[] = [];
			const chunkCount = view.getUint32(stco.content + 4);
			for (let index = 0; index < chunkCount; index++) offsets.push(view.getUint32(stco.content + 8 + index * 4));
			const chunkRuns: { first: number; count: number }[] = [];
			const stscCount = view.getUint32(stsc.content + 4);
			for (let index = 0; index < stscCount; index++) {
				chunkRuns.push({
					first: view.getUint32(stsc.content + 8 + index * 12),
					count: view.getUint32(stsc.content + 12 + index * 12),
				});
			}
			let cttsRuns: { count: number; offset: number }[] | null = null;
			if (ctts) {
				cttsRuns = [];
				const cttsCount = view.getUint32(ctts.content + 4);
				for (let index = 0; index < cttsCount; index++) {
					cttsRuns.push({
						count: view.getUint32(ctts.content + 8 + index * 8),
						offset: view.getInt32(ctts.content + 12 + index * 8),
					});
				}
			}
			return {
				id: trackIdOf(data, tkhd),
				timescale: timescaleOf(data, mdhd),
				tkhdDuration: durationOf(data, tkhd),
				mdhdDuration: durationOf(data, mdhd),
				runs,
				sizes,
				sync,
				offsets,
				chunkRuns,
				ctts: cttsRuns,
			};
		});
	return { tracks, mvhdDuration: durationOf(data, mvhd), hasMvex: child(data, moov, 'mvex') !== null };
}

// ---------------------------------------------------------------------------

const VIDEO: TrackSpec = { id: 1, timescale: 90000, handler: 'vide' };
const AUDIO: TrackSpec = { id: 2, timescale: 44100, handler: 'soun' };

function parse(fragment: Uint8Array): ParsedFragment {
	const parsed = parseFragments(fragment);
	const first = parsed[0];
	if (!first) throw new Error('nothing parsed');
	return first;
}

/** Build a whole file the way the downloader does, and return its moov. */
function assemble(init: Uint8Array, fragments: { fragment: ParsedFragment; offset: number }[]): Uint8Array {
	const builder = new ProgressiveMp4Builder(init);
	for (const entry of fragments) builder.addFragment(entry.fragment, entry.offset);
	return builder.buildMoov();
}

/** One fragment, ready to add, plus the payload offset its media lands at. */
function staged(fragment: Uint8Array, offset: number): { fragment: ParsedFragment; offset: number } {
	return { fragment: parse(fragment), offset };
}

/** Lay fragments out in file order: `ftyp`, then one `mdat` each. */
function layOut(init: Uint8Array, raws: Uint8Array[]): { fragment: ParsedFragment; offset: number }[] {
	let bytes = walk(init).find((entry) => entry.type === 'ftyp')?.end ?? 0;
	const placed: { fragment: ParsedFragment; offset: number }[] = [];
	for (const raw of raws) {
		const fragment = parse(raw);
		placed.push({ fragment, offset: bytes + 8 });
		bytes += 8 + fragment.media.byteLength;
	}
	return placed;
}

describe('parseFragments', () => {
	it('reads a fragment’s samples, media and payload offset', () => {
		const raw = makeFragment(1, 4200, [
			{ duration: 3000, size: 10 },
			{ duration: 3000, size: 20, nonSync: true, cts: 1500 },
		]);
		const parsed = parseFragments(raw);
		expect(parsed).toHaveLength(1);
		const fragment = parsed[0];
		if (!fragment) throw new Error('unreachable');
		expect(fragment.trafs).toHaveLength(1);
		const traf = fragment.trafs[0];
		if (!traf) throw new Error('unreachable');
		expect(traf.trackId).toBe(1);
		expect(traf.baseDecodeTime).toBe(4200);
		expect(traf.samples).toEqual([
			{ duration: 3000, size: 10, flags: 0x02000000, cts: 0 },
			{ duration: 3000, size: 20, flags: 0x00010000, cts: 1500 },
		]);
		// The payload is the mdat body, and the data offset is moof-relative.
		expect(fragment.media).toHaveLength(30);
		expect(fragment.mediaLength).toBe(30);
		expect(fragment.trafs[0]?.dataOffset).toBe(fragment.mediaOffset);
		expect(fragment.moof.byteLength).toBeGreaterThan(0);
	});

	it('splits a batch that carries more than one fragment', () => {
		const segment = concat(
			makeFragment(1, 0, [{ duration: 3000, size: 8 }]),
			makeFragment(2, 0, [{ duration: 1024, size: 4 }]),
		);
		const parsed = parseFragments(segment);
		expect(parsed.map((fragment) => fragment.trafs[0]?.trackId)).toEqual([1, 2]);
		// Each pair is its own mdat, and each offset is relative to its own moof.
		expect(parsed[0]?.mediaLength).toBe(8);
		expect(parsed[1]?.mediaLength).toBe(4);
	});

	it('refuses a fragment with no media data', () => {
		const moof = makeFragment(1, 0, [{ duration: 3000, size: 8 }]).subarray(0, 32);
		expect(() => parseFragments(moof.slice())).toThrow(Mp4Error);
	});

	it('refuses a fragment with no track run', () => {
		const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
		const segment = concat(box('moof', box('traf', tfhd)), mdatHeader(4), new Uint8Array(4));
		expect(() => parseFragments(segment)).toThrow(Mp4Error);
	});
});

describe('ProgressiveMp4Builder', () => {
	it('writes sample tables a progressive player can read', () => {
		const init = initSegment([VIDEO]);
		const placed = layOut(init, [
			makeFragment(1, 0, [
				{ duration: 3000, size: 10 },
				{ duration: 3000, size: 20, nonSync: true },
				{ duration: 3000, size: 30 },
			]),
			makeFragment(1, 9000, [
				{ duration: 3000, size: 40 },
				{ duration: 3000, size: 50, nonSync: true },
			]),
		]);
		const moov = assemble(init, placed);
		const movie = readMovie(moov);
		// The whole point: no fragment machinery, real tables.
		expect(movie.hasMvex).toBe(false);
		expect(movie.tracks).toHaveLength(1);
		const track = movie.tracks[0];
		if (!track) throw new Error('unreachable');
		expect(track.sizes).toEqual([10, 20, 30, 40, 50]);
		expect(track.runs).toEqual([{ count: 5, delta: 3000 }]);
		expect(track.sync).toEqual([1, 3, 4]);
		expect(track.offsets).toEqual([placed[0]?.offset, placed[1]?.offset]);
		expect(track.chunkRuns).toEqual([{ first: 1, count: 3 }, { first: 2, count: 2 }]);
		expect(track.mdhdDuration).toBe(15000);
		expect(track.tkhdDuration).toBe(15000);
		expect(movie.mvhdDuration).toBe(15000);
	});

	it('drops a re-emitted sample and splits the chunk around its bytes', () => {
		// mux.js re-derives a segment's base decode time at each flush, so the
		// second fragment repeats the last frame of the first one.
		const init = initSegment([VIDEO]);
		const placed = layOut(init, [
			makeFragment(1, 0, [
				{ duration: 3000, size: 10 },
				{ duration: 3000, size: 20 },
			]),
			makeFragment(1, 3000, [
				{ duration: 3000, size: 20 },
				{ duration: 3000, size: 30 },
			]),
		]);
		const moov = assemble(init, placed);
		const track = readMovie(moov).tracks[0];
		if (!track) throw new Error('unreachable');
		expect(track.sizes).toEqual([10, 20, 30]);
		expect(track.runs).toEqual([{ count: 3, delta: 3000 }]);
		// The duplicate's bytes stay in the mdat, so the second chunk starts 20
		// bytes into the second payload rather than at its first byte.
		expect(track.offsets).toEqual([placed[0]?.offset, (placed[1]?.offset ?? 0) + 20]);
	});

	it('keeps a sample that starts early but spans the end of what is written', () => {
		// Audio drifts by a tick at every flush (44.1 kHz does not divide 90 kHz
		// evenly), so a real sample can begin before the track's decode end.
		const init = initSegment([AUDIO]);
		const moov = assemble(init, [
			staged(makeFragment(2, 0, [{ duration: 1024, size: 10 }]), 40),
			staged(makeFragment(2, 1023, [{ duration: 1024, size: 20 }, { duration: 1024, size: 30 }]), 58),
		]);
		const track = readMovie(moov).tracks[0];
		if (!track) throw new Error('unreachable');
		// All three samples survive: the second is real media, not a re-emission.
		expect(track.sizes).toEqual([10, 20, 30]);
		// `stts` cannot express the one-tick overlap, so it is taken off the
		// sample before it: 1024 - 1, then 1024, 1024.
		expect(track.runs).toEqual([
			{ count: 1, delta: 1023 },
			{ count: 2, delta: 1024 },
		]);
		expect(track.mdhdDuration).toBe(3071);
	});

	it('absorbs a gap into the sample before it', () => {
		const init = initSegment([VIDEO]);
		const moov = assemble(init, [
			staged(makeFragment(1, 0, [{ duration: 3000, size: 10 }]), 40),
			staged(makeFragment(1, 9000, [{ duration: 3000, size: 20 }]), 58),
		]);
		const track = readMovie(moov).tracks[0];
		if (!track) throw new Error('unreachable');
		expect(track.runs).toEqual([{ count: 1, delta: 9000 }, { count: 1, delta: 3000 }]);
		expect(track.mdhdDuration).toBe(12000);
	});

	it('writes composition offsets only when they are not all zero', () => {
		const init = initSegment([VIDEO]);
		const flat = assemble(init, [staged(makeFragment(1, 0, [{ duration: 3000, size: 10 }]), 40)]);
		expect(readMovie(flat).tracks[0]?.ctts).toBeNull();
		const offset = assemble(init, [
			staged(makeFragment(1, 0, [{ duration: 3000, size: 10, cts: 6000 }, { duration: 3000, size: 20 }]), 40),
		]);
		expect(readMovie(offset).tracks[0]?.ctts).toEqual([
			{ count: 1, offset: 6000 },
			{ count: 1, offset: 0 },
		]);
	});

	it('refuses a fragment for a track the init segment does not describe', () => {
		const builder = new ProgressiveMp4Builder(initSegment([VIDEO]));
		expect(() => builder.addFragment(parse(makeFragment(9, 0, [{ duration: 3000, size: 8 }])), 40)).toThrow(Mp4Error);
	});
});

describe('resume index', () => {
	function buildIndex(init: Uint8Array, raw: Uint8Array[], segments: number[]): Uint8Array {
		const parts: Uint8Array[] = [encodeIndexHeader(init)];
		layOut(init, raw).forEach((entry, index) => {
			parts.push(encodeIndexRecord(entry.fragment, entry.offset, segments[index] ?? 0));
		});
		return concat(...parts);
	}

	const init = initSegment([VIDEO]);
	const raw = [
		makeFragment(1, 0, [
			{ duration: 3000, size: 10 },
			{ duration: 3000, size: 20 },
		]),
		makeFragment(1, 6000, [
			{ duration: 3000, size: 30 },
			{ duration: 3000, size: 40 },
		]),
		makeFragment(1, 12000, [
			{ duration: 3000, size: 50 },
			{ duration: 3000, size: 60 },
		]),
	];

	it('replays to the same movie a one-shot build produces', () => {
		const oneShot = assemble(init, layOut(init, raw));
		const replayed = ProgressiveMp4Builder.fromIndex(buildIndex(init, raw, [1, 2, 3])).buildMoov();
		expect(Buffer.from(replayed)).toEqual(Buffer.from(oneShot));
	});

	it('finishes a half-written file exactly as a single run would', () => {
		const half = buildIndex(init, raw.slice(0, 2), [1, 2]);
		const resumed = ProgressiveMp4Builder.fromIndex(half);
		const third = parse(raw[2] as Uint8Array);
		// The resumed run appends at the end of the media the index covers.
		resumed.addFragment(third, readIndex(half).mediaEnd + 8);
		const oneShot = assemble(init, layOut(init, raw));
		expect(Buffer.from(resumed.buildMoov())).toEqual(Buffer.from(oneShot));
	});

	it('reports the media end, segment count and intact length', () => {
		const index = buildIndex(init, raw, [1, 2, 5]);
		const state = readIndex(index);
		expect(state.fragments).toHaveLength(3);
		expect(state.segments).toBe(5);
		expect(state.torn).toBe(false);
		expect(state.length).toBe(index.byteLength);
		const last = state.fragments[2];
		if (!last) throw new Error('unreachable');
		expect(state.mediaEnd).toBe(last.payloadOffset + last.samples.mediaLength);
	});

	it('stops at the last record whose media is really on disk', () => {
		const index = buildIndex(init, raw, [1, 2, 3]);
		const full = readIndex(index);
		const second = full.fragments[1];
		if (!second) throw new Error('unreachable');
		const limit = second.payloadOffset + second.samples.mediaLength;
		const truncated = readIndex(index, limit);
		expect(truncated.fragments).toHaveLength(2);
		expect(truncated.mediaEnd).toBe(limit);
		expect(truncated.segments).toBe(2);
		expect(truncated.torn).toBe(true);
		// `length` is where the usable part ends, so the caller can cut the
		// half-written record off the index file.
		const first = full.fragments[0];
		if (!first) throw new Error('unreachable');
		expect(truncated.length).toBeGreaterThan(0);
		expect(truncated.length).toBeLessThan(index.byteLength);
	});

	it('treats a torn append as the end of the index', () => {
		const index = buildIndex(init, raw, [1, 2, 3]);
		const torn = index.subarray(0, index.byteLength - 4);
		const state = readIndex(torn.slice());
		expect(state.fragments).toHaveLength(2);
		expect(state.torn).toBe(true);
		expect(state.length).toBeLessThan(torn.byteLength);
	});

	it('rejects an index it did not write', () => {
		expect(() => readIndex(new Uint8Array(64))).toThrow(Mp4Error);
		const index = buildIndex(init, raw, [1, 2, 3]);
		const foreign = index.slice();
		foreign[4] = 99;
		expect(() => readIndex(foreign)).toThrow(Mp4Error);
		expect(() => readIndex(index.subarray(0, 8).slice())).toThrow(Mp4Error);
	});
});

// ---------------------------------------------------------------------------
// Converting existing downloads
// ---------------------------------------------------------------------------

/** The same init with `mvex` added to `moov` — the shape mux.js actually writes. */
function fragmentedInit(tracks: TrackSpec[]): Uint8Array {
	const init = initSegment(tracks);
	const ftyp = walk(init).find((entry) => entry.type === 'ftyp');
	const moov = walk(init).find((entry) => entry.type === 'moov');
	if (!ftyp || !moov) throw new Error('bad init');
	const mvex = box(
		'mvex',
		...tracks.map((track) => fullBox('trex', 0, 0, u32(track.id), u32(1), u32(0), u32(0), u32(0))),
	);
	return concat(init.subarray(0, ftyp.end), box('moov', init.subarray(moov.content, moov.end), mvex));
}

function fragmentedFile(tracks: TrackSpec[], raws: Uint8Array[]): Uint8Array {
	return concat(fragmentedInit(tracks), ...raws);
}

describe('convertFragmented', () => {
	it('rebuilds a fragmented file as progressive, keeping the media', () => {
		const raws = [
			makeFragment(1, 0, [
				{ duration: 3000, size: 10 },
				{ duration: 3000, size: 20, nonSync: true },
			]),
			makeFragment(1, 6000, [{ duration: 3000, size: 30 }]),
		];
		const file = fragmentedFile([VIDEO], raws);
		const out = convertFragmented(file);
		if (!out) throw new Error('conversion refused');

		expect(walk(out).map((entry) => entry.type)).toEqual(['ftyp', 'mdat', 'mdat', 'moov']);
		const movie = readMovie(out);
		expect(movie.hasMvex).toBe(false);
		const track = movie.tracks[0];
		if (!track) throw new Error('no track');
		expect(track.sizes).toEqual([10, 20, 30]);
		expect(track.runs).toEqual([{ count: 3, delta: 3000 }]);
		expect(track.sync).toEqual([1, 3]);
		expect(track.mdhdDuration).toBe(9000);

		// The payload is copied through untouched, and every chunk offset lands
		// inside the `mdat` that now holds it.
		const before = walk(file).filter((entry) => entry.type === 'mdat');
		const after = walk(out).filter((entry) => entry.type === 'mdat');
		expect(after.map((entry) => out.subarray(entry.content, entry.end))).toEqual(
			before.map((entry) => file.subarray(entry.content, entry.end)),
		);
		for (const offset of track.offsets) {
			expect(after.some((entry) => offset >= entry.content && offset < entry.end)).toBe(true);
		}
	});

	it('keeps every track of a multi-track file', () => {
		const file = fragmentedFile([VIDEO, AUDIO], [
			makeFragment(1, 0, [{ duration: 3000, size: 10 }]),
			makeFragment(2, 0, [{ duration: 1024, size: 4 }]),
		]);
		const out = convertFragmented(file);
		if (!out) throw new Error('conversion refused');
		const movie = readMovie(out);
		expect(movie.tracks.map((track) => track.id)).toEqual([1, 2]);
		expect(movie.tracks.map((track) => track.sizes)).toEqual([[10], [4]]);
	});

	it('leaves an already-progressive file alone', () => {
		expect(convertFragmented(initSegment([VIDEO]))).toBeNull();
		const progressive = convertFragmented(fragmentedFile([VIDEO], [makeFragment(1, 0, [{ duration: 3000, size: 10 }])]));
		expect(progressive).not.toBeNull();
		expect(convertFragmented(progressive as Uint8Array)).toBeNull();
	});

	it('refuses a fragment naming a track the movie does not have', () => {
		const file = fragmentedFile([VIDEO], [makeFragment(9, 0, [{ duration: 3000, size: 10 }])]);
		expect(convertFragmented(file)).toBeNull();
	});

	it('refuses a fragment with no media after it', () => {
		const moof = makeFragment(1, 0, [{ duration: 3000, size: 10 }]).subarray(0, 40);
		expect(convertFragmented(concat(fragmentedInit([VIDEO]), moof))).toBeNull();
	});
});

describe('doctor', () => {
	const file = (): Uint8Array =>
		fragmentedFile([VIDEO, AUDIO], [
			makeFragment(1, 0, [{ duration: 30000, size: 10 }]),
			makeFragment(2, 0, [{ duration: 1024, size: 4 }]),
		]);

	it('flags a fragmented download and converts it', () => {
		const data = file();
		expect(inspectDurationEnhanced(data).fragmented).toBe(true);
		expect(needsRepair(data)).toBe(true);

		const repaired = repairDuration(data);
		if (!repaired) throw new Error('repair refused');
		expect(inspectDurationEnhanced(repaired.data).fragmented).toBe(false);
		expect(readMovie(repaired.data).tracks).toHaveLength(2);
		expect(repaired.durationSeconds).toBeCloseTo(1 / 3, 6);
	});

	it('leaves a progressive download alone', () => {
		const repaired = repairDuration(file());
		if (!repaired) throw new Error('repair refused');
		// Nothing to flag, and nothing rewritten: `repairFolder` skips a file
		// `needsRepair` refuses, and `patchDuration` refuses a progressive movie.
		expect(needsRepair(repaired.data)).toBe(false);
		expect(repairDuration(repaired.data)?.data).toBe(repaired.data);
	});
});

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);
const fixture = ((): string | null => {
	try {
		return require_.resolve('mux.js/test/segments/test-segment.ts');
	} catch {
		return null;
	}
})();

describe.skipIf(!fixture || !existsSync(fixture))('mux.js output', () => {
	it('converts a real segment end to end', async () => {
		const data = new Uint8Array(readFileSync(fixture as string));
		let init: Uint8Array | null = null;
		const fragments: ParsedFragment[] = [];
		const stream = new TransmuxStream(
			(segment) => {
				init = segment;
			},
			(segment) => {
				for (const parsed of parseFragments(segment)) fragments.push(parsed);
			},
		);
		// Flush at segment boundaries, which is what the downloader does.
		for (let offset = 0; offset < data.byteLength; offset += 32 * 1024) {
			stream.push(data.subarray(offset, Math.min(offset + 32 * 1024, data.byteLength)));
			await stream.flush();
		}
		await stream.finish();
		if (!init) throw new Error('no init segment');
		expect(fragments.length).toBeGreaterThan(0);

		const builder = new ProgressiveMp4Builder(init);
		let bytes = (walk(init).find((entry) => entry.type === 'ftyp')?.end ?? 0);
		for (const fragment of fragments) {
			const payloadOffset = bytes + 8;
			bytes += 8 + fragment.media.byteLength;
			builder.addFragment(fragment, payloadOffset);
		}
		const moov = builder.buildMoov();
		const movie = readMovie(moov);
		expect(movie.hasMvex).toBe(false);
		expect(movie.tracks.length).toBeGreaterThanOrEqual(2);
		for (const track of movie.tracks) {
			// A real file: every sample described, and the track's own duration
			// agreeing with the sum of its `stts` runs.
			const total = track.runs.reduce((sum, run) => sum + run.count * run.delta, 0);
			expect(track.sizes.length).toBeGreaterThan(100);
			expect(track.mdhdDuration).toBe(total);
			expect(track.offsets.length).toBeGreaterThan(0);
			// Chunk offsets must land inside the file we described.
			for (const offset of track.offsets) expect(offset).toBeLessThan(bytes);
		}
	});
});

/**
 * Progressive MP4 for the downloader.
 *
 * mux.js emits a *fragmented* MP4: an init segment (`ftyp` + `moov` with `mvex`)
 * followed by `moof`/`mdat` pairs, one per flush. That plays in a browser engine
 * — which is what Obsidian's video element is — but the `moov` it writes has
 * empty sample tables, so a player that only understands progressive MP4 (most
 * phone galleries, TVs, Windows, QuickTime) reads a movie with zero samples and
 * refuses the file.
 *
 * This module keeps mux.js as the demuxer and rebuilds the container: each
 * fragment's sample data is written straight through as an `mdat` box while the
 * per-sample metadata is collected, and a `moov` with real
 * `stts`/`stss`/`ctts`/`stsc`/`stsz`/`stco` tables is appended once the stream
 * ends. The result is an ordinary progressive MP4 with no `mvex` — the shape
 * every player expects, just with the movie header at the end of the file
 * (which is what ffmpeg produces by default, and costs nothing for a local
 * file).
 *
 * The tables are small enough to keep in memory, but a resume has to recreate
 * them for the part already on disk, and on mobile the app is killed in the
 * background constantly. `encodeIndexRecord` therefore mirrors each fragment's
 * `moof` into a sidecar as it is written: a `moof` already carries every
 * per-sample field, so the index is a copy rather than a second serialiser, and
 * `ProgressiveMp4Builder.fromIndex` replays it to rebuild the builder state.
 */

export class Mp4Error extends Error {}

export interface SampleRecord {
	/** Duration in the track's timescale. */
	duration: number;
	/** Size in bytes. */
	size: number;
	/** Raw `trun` sample flags; bit 16 marks a non-sync sample. */
	flags: number;
	/** Composition time offset, signed. */
	cts: number;
}

export interface ParsedTraf {
	trackId: number;
	/** Decode time of the first sample, in the track's timescale. */
	baseDecodeTime: number;
	samples: SampleRecord[];
	/** First sample's data, as an offset from the start of the moof. */
	dataOffset: number;
}

/** What the builder needs from a fragment, with or without its media bytes. */
export interface FragmentSamples {
	trafs: ParsedTraf[];
	/** `mdat` payload start, as an offset from the start of the moof. */
	mediaOffset: number;
	/** Length of the `mdat` payload. */
	mediaLength: number;
}

export interface ParsedFragment extends FragmentSamples {
	/** The `moof` box, verbatim, for the resume index. */
	moof: Uint8Array;
	/** The `mdat` payload, verbatim; written through unchanged. */
	media: Uint8Array;
}

const NON_SYNC_SAMPLE = 0x00010000;

interface Box {
	type: string;
	start: number;
	end: number;
	content: number;
}

function typeAt(view: DataView, offset: number): string {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3),
	);
}

/** Best-effort walk of a run of boxes. A malformed size ends the walk. */
function boxesIn(view: DataView, end: number, start = 0): Box[] {
	const boxes: Box[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		let size = view.getUint32(offset);
		let content = offset + 8;
		if (size === 1) {
			if (offset + 16 > end) break;
			size = Number(view.getBigUint64(offset + 8));
			content = offset + 16;
		} else if (size === 0) {
			size = end - offset;
		}
		if (size < content - offset || offset + size > end) break;
		boxes.push({ type: typeAt(view, offset + 4), start: offset, end: offset + size, content });
		offset += size;
	}
	return boxes;
}

function findBox(boxes: Box[], type: string): Box | undefined {
	return boxes.find((item) => item.type === type);
}

/** Parse one `traf`, with every offset relative to the start of its moof. */
function parseTraf(view: DataView, traf: Box, moofStart: number): ParsedTraf {
	const children = boxesIn(view, traf.end, traf.content);
	const tfhd = findBox(children, 'tfhd');
	if (!tfhd) throw new Mp4Error('A movie fragment has no track header.');
	const flags = view.getUint32(tfhd.content) & 0xffffff;
	let cursor = tfhd.content + 4;
	const trackId = view.getUint32(cursor);
	cursor += 4;
	let baseDataOffset: number | null = null;
	if (flags & 0x000001) {
		baseDataOffset = Number(view.getBigUint64(cursor));
		cursor += 8;
	}
	if (flags & 0x000002) cursor += 4; // sample_description_index
	let defaultDuration = 0;
	let defaultSize = 0;
	let defaultFlags = 0;
	if (flags & 0x000008) {
		defaultDuration = view.getUint32(cursor);
		cursor += 4;
	}
	if (flags & 0x000010) {
		defaultSize = view.getUint32(cursor);
		cursor += 4;
	}
	if (flags & 0x000020) {
		defaultFlags = view.getUint32(cursor);
		cursor += 4;
	}

	let baseDecodeTime = 0;
	const tfdt = findBox(children, 'tfdt');
	if (tfdt) {
		baseDecodeTime =
			view.getUint8(tfdt.content) === 1
				? Number(view.getBigUint64(tfdt.content + 4))
				: view.getUint32(tfdt.content + 4);
	}

	const trun = findBox(children, 'trun');
	if (!trun) throw new Mp4Error('A movie fragment has no track run.');
	const trunFlags = view.getUint32(trun.content) & 0xffffff;
	const count = view.getUint32(trun.content + 4);
	let at = trun.content + 8;
	let dataOffset = 0;
	if (trunFlags & 0x000001) {
		dataOffset = view.getInt32(at);
		at += 4;
	}
	let firstFlags: number | null = null;
	if (trunFlags & 0x000004) {
		firstFlags = view.getUint32(at);
		at += 4;
	}

	const samples: SampleRecord[] = [];
	for (let index = 0; index < count; index++) {
		let duration = defaultDuration;
		let size = defaultSize;
		let sampleFlags = index === 0 && firstFlags !== null ? firstFlags : defaultFlags;
		let cts = 0;
		if (trunFlags & 0x000100) {
			duration = view.getUint32(at);
			at += 4;
		}
		if (trunFlags & 0x000200) {
			size = view.getUint32(at);
			at += 4;
		}
		if (trunFlags & 0x000400) {
			sampleFlags = view.getUint32(at);
			at += 4;
		}
		if (trunFlags & 0x000800) {
			cts = view.getInt32(at);
			at += 4;
		}
		samples.push({ duration, size, flags: sampleFlags, cts });
	}

	// `default-base-is-moof` (what mux.js writes) makes the offset relative to
	// the moof. A base-data-offset is a position in the standalone fragment, so
	// subtracting the moof's own position yields the same relative form.
	const base = baseDataOffset ?? moofStart;
	return {
		trackId,
		baseDecodeTime,
		samples,
		dataOffset: base - moofStart + dataOffset,
	};
}

/** Read the sample metadata out of a standalone `moof` box. */
export function parseMoof(moof: Uint8Array, mediaOffset: number, mediaLength: number): FragmentSamples {
	const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
	// The buffer holds the moof box itself, so its children start after its
	// header rather than at zero.
	const outer = boxesIn(view, moof.byteLength)[0];
	const childrenStart = outer ? outer.content : 8;
	const trafs: ParsedTraf[] = [];
	for (const item of boxesIn(view, moof.byteLength, childrenStart)) {
		if (item.type === 'traf') trafs.push(parseTraf(view, item, 0));
	}
	return { trafs, mediaOffset, mediaLength };
}

/**
 * Split one mux.js output into the `moof`/`mdat` pairs to write and the sample
 * metadata the moov needs.
 *
 * One output can carry several pairs — mux.js emits a separate `moof` for each
 * track — so this returns them in order rather than assuming a single fragment.
 * Each pair is written as its own `mdat`, which keeps the payload byte-for-byte
 * identical to what mux.js produced and avoids copying it.
 *
 * Throws when the output is not shaped as expected, because writing a file with
 * a sample table that points at the wrong bytes is worse than failing the
 * download.
 */
export function parseFragments(segment: Uint8Array): ParsedFragment[] {
	const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
	const top = boxesIn(view, segment.byteLength);
	const parsed: ParsedFragment[] = [];
	for (let index = 0; index < top.length; index++) {
		const moof = top[index];
		if (moof.type !== 'moof') continue;
		const mdat = top.slice(index + 1).find((item) => item.type === 'mdat');
		if (!mdat) throw new Mp4Error('The converted stream has no media data.');
		const mediaOffset = mdat.content - moof.start;
		const mediaLength = mdat.end - mdat.content;
		const samples = parseMoof(segment.subarray(moof.start, moof.end), mediaOffset, mediaLength);
		if (samples.trafs.length === 0) throw new Mp4Error('The converted stream has an empty movie fragment.');

		// Every sample must land inside the payload we are about to write.
		for (const traf of samples.trafs) {
			let bytes = 0;
			for (const sample of traf.samples) bytes += sample.size;
			const start = traf.dataOffset - mediaOffset;
			if (start < 0 || start + bytes > mediaLength) {
				throw new Mp4Error('The converted stream describes media that is not in the fragment.');
			}
		}

		parsed.push({
			...samples,
			moof: segment.subarray(moof.start, moof.end),
			media: segment.subarray(mdat.content, mdat.end),
		});
	}
	if (parsed.length === 0) throw new Mp4Error('The converted stream has no movie fragment.');
	return parsed;
}

/** The `mdat` header for a payload of this size. */
export function mdatHeader(payloadLength: number): Uint8Array {
	const header = new Uint8Array(8);
	const view = new DataView(header.buffer);
	view.setUint32(0, 8 + payloadLength);
	header.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'
	return header;
}

// ---------------------------------------------------------------------------
// Box building
// ---------------------------------------------------------------------------

function box(type: string, ...children: Uint8Array[]): Uint8Array {
	let length = 8;
	for (const child of children) length += child.byteLength;
	const out = new Uint8Array(length);
	const view = new DataView(out.buffer);
	view.setUint32(0, length);
	out[4] = type.charCodeAt(0);
	out[5] = type.charCodeAt(1);
	out[6] = type.charCodeAt(2);
	out[7] = type.charCodeAt(3);
	let at = 8;
	for (const child of children) {
		out.set(child, at);
		at += child.byteLength;
	}
	return out;
}

function fullBox(type: string, version: number, ...children: Uint8Array[]): Uint8Array {
	const head = new Uint8Array(4);
	new DataView(head.buffer).setUint32(0, version << 24);
	return box(type, head, ...children);
}

function u32(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0);
	return out;
}

function table(count: number, stride: number): { bytes: Uint8Array; view: DataView } {
	const bytes = new Uint8Array(count * stride);
	return { bytes, view: new DataView(bytes.buffer) };
}

/** Read the timescale from an `mvhd`/`mdhd` box that starts at offset 0. */
function readTimescale(boxBytes: Uint8Array): number {
	const view = new DataView(boxBytes.buffer, boxBytes.byteOffset, boxBytes.byteLength);
	const version = view.getUint8(8);
	return view.getUint32(8 + (version === 1 ? 20 : 12));
}

/** Write a duration into an `mvhd`, `tkhd` or `mdhd` box that starts at 0. */
function setDuration(boxBytes: Uint8Array, ticks: number): void {
	const view = new DataView(boxBytes.buffer, boxBytes.byteOffset, boxBytes.byteLength);
	const type = typeAt(view, 4);
	const version = view.getUint8(8);
	if (version === 1) {
		// `tkhd` carries a reserved word that shifts the duration by four.
		view.setBigUint64(8 + (type === 'tkhd' ? 28 : 24), BigInt(Math.round(ticks)));
		return;
	}
	view.setUint32(8 + (type === 'tkhd' ? 20 : 16), ticks >>> 0);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface TrackTemplate {
	id: number;
	timescale: number;
	tkhd: Uint8Array;
	mdhd: Uint8Array;
	hdlr: Uint8Array;
	mediaHeader: Uint8Array | null;
	dinf: Uint8Array | null;
	stsd: Uint8Array;
}

interface ChunkRecord {
	offset: number;
	count: number;
	/** Byte position just past the chunk's last sample. */
	end: number;
}

interface TrackState {
	template: TrackTemplate;
	samples: SampleRecord[];
	chunks: ChunkRecord[];
	/** Decode time the track has been filled to, in the track's timescale. */
	endTime: number;
}

function copy(source: Uint8Array): Uint8Array {
	return source.slice();
}

export class ProgressiveMp4Builder {
	/** The `ftyp` box to write before any media. */
	readonly ftyp: Uint8Array;
	private readonly mvhd: Uint8Array;
	private readonly movieTimescale: number;
	private readonly tracks = new Map<number, TrackState>();

	constructor(init: Uint8Array) {
		const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
		const top = boxesIn(view, init.byteLength);
		const ftyp = findBox(top, 'ftyp');
		const moov = findBox(top, 'moov');
		if (!ftyp || !moov) throw new Mp4Error('The converted stream has no movie header.');
		this.ftyp = copy(init.subarray(ftyp.start, ftyp.end));
		const mvhd = findBox(boxesIn(view, moov.end, moov.content), 'mvhd');
		if (!mvhd) throw new Mp4Error('The video header has no movie header.');
		this.mvhd = copy(init.subarray(mvhd.start, mvhd.end));
		this.movieTimescale = readTimescale(this.mvhd) || 90000;

		for (const trak of boxesIn(view, moov.end, moov.content)) {
			if (trak.type !== 'trak') continue;
			const template = readTrackTemplate(init, view, trak);
			this.tracks.set(template.id, { template, samples: [], chunks: [], endTime: 0 });
		}
		if (this.tracks.size === 0) throw new Mp4Error('The video header has no tracks.');
	}

	/** Rebuild a builder from a resume index. */
	static fromIndex(data: Uint8Array): ProgressiveMp4Builder {
		const state = readIndex(data);
		const builder = new ProgressiveMp4Builder(state.init);
		for (const record of state.fragments) builder.addFragment(record.samples, record.payloadOffset);
		return builder;
	}

	/**
	 * Record one fragment's samples. The media bytes must already be placed at
	 * `payloadOffset`.
	 *
	 * mux.js re-emits the frames it is still holding when a flush lands
	 * mid-frame, so a fragment's `tfdt` can sit *before* the track's decode end
	 * and its first samples are ones an earlier flush already handed over. Those
	 * are dropped: the sample tables are what a player reads, and a sample
	 * listed twice plays twice. The bytes stay in the `mdat` — the payload is
	 * written through untouched — so a drop leaves a hole no table points at,
	 * and the chunk is split around it.
	 */
	addFragment(fragment: FragmentSamples, payloadOffset: number): void {
		for (const traf of fragment.trafs) {
			const track = this.tracks.get(traf.trackId);
			if (!track) throw new Mp4Error(`The stream uses an unknown track (${traf.trackId}).`);
			if (traf.samples.length === 0) continue;

			const dataStart = payloadOffset + (traf.dataOffset - fragment.mediaOffset);
			let bytes = 0;
			let decodeTime = traf.baseDecodeTime;
			for (const sample of traf.samples) {
				const start = decodeTime;
				decodeTime = start + sample.duration;
				const offset = dataStart + bytes;
				bytes += sample.size;
				if (start < track.endTime) continue;

				if (start > track.endTime) {
					// `stts` has no way to express a gap — a sample's decode
					// time is the sum of the durations before it — so the gap is
					// absorbed into the sample preceding it.
					const previous = track.samples[track.samples.length - 1];
					if (previous) previous.duration += start - track.endTime;
				}
				track.samples.push(sample);
				track.endTime = decodeTime;

				const last = track.chunks[track.chunks.length - 1];
				if (last && last.end === offset) {
					last.count++;
					last.end = offset + sample.size;
				} else {
					track.chunks.push({ offset, count: 1, end: offset + sample.size });
				}
			}
		}
	}

	/**
	 * Build the `moov` that goes at the end of the file. Durations are summed
	 * from the samples rather than taken from the playlist, so they match the
	 * tables exactly.
	 */
	buildMoov(): Uint8Array {
		const traks: Uint8Array[] = [];
		let movieDuration = 0;
		for (const track of this.tracks.values()) {
			let ticks = 0;
			for (const sample of track.samples) ticks += sample.duration;
			const timescale = track.template.timescale || 90000;
			const inMovie = Math.round((ticks / timescale) * this.movieTimescale);
			movieDuration = Math.max(movieDuration, inMovie);
			traks.push(this.buildTrak(track, inMovie, ticks));
		}
		const mvhd = copy(this.mvhd);
		setDuration(mvhd, movieDuration);
		return box('moov', mvhd, ...traks);
	}

	private buildTrak(track: TrackState, movieTicks: number, trackTicks: number): Uint8Array {
		const tkhd = copy(track.template.tkhd);
		setDuration(tkhd, movieTicks);
		const mdhd = copy(track.template.mdhd);
		setDuration(mdhd, trackTicks);

		const minf: Uint8Array[] = [];
		if (track.template.mediaHeader) minf.push(copy(track.template.mediaHeader));
		if (track.template.dinf) minf.push(copy(track.template.dinf));
		minf.push(this.buildStbl(track));

		const mdia = box('mdia', mdhd, copy(track.template.hdlr), box('minf', ...minf));
		return box('trak', tkhd, mdia);
	}

	private buildStbl(track: TrackState): Uint8Array {
		const parts: Uint8Array[] = [copy(track.template.stsd)];
		parts.push(buildStts(track.samples));
		const ctts = buildCtts(track.samples);
		if (ctts) parts.push(ctts);
		const stss = buildStss(track.samples);
		if (stss) parts.push(stss);
		parts.push(buildStsc(track.chunks));
		parts.push(buildStsz(track.samples));
		parts.push(buildStco(track.chunks));
		return box('stbl', ...parts);
	}
}

function readTrackTemplate(init: Uint8Array, view: DataView, trak: Box): TrackTemplate {
	const children = boxesIn(view, trak.end, trak.content);
	const tkhd = findBox(children, 'tkhd');
	const mdia = findBox(children, 'mdia');
	if (!tkhd || !mdia) throw new Mp4Error('A track has no track header.');
	const mdiaChildren = boxesIn(view, mdia.end, mdia.content);
	const mdhd = findBox(mdiaChildren, 'mdhd');
	const hdlr = findBox(mdiaChildren, 'hdlr');
	const minf = findBox(mdiaChildren, 'minf');
	if (!mdhd || !hdlr || !minf) throw new Mp4Error('A track has no media header.');
	const minfChildren = boxesIn(view, minf.end, minf.content);
	const stbl = findBox(minfChildren, 'stbl');
	const stsd = stbl ? findBox(boxesIn(view, stbl.end, stbl.content), 'stsd') : undefined;
	if (!stsd) throw new Mp4Error('A track has no sample description.');

	const version = view.getUint8(tkhd.content);
	const id = view.getUint32(tkhd.content + (version === 1 ? 20 : 12));
	const mediaHeader = findBox(minfChildren, 'vmhd') ?? findBox(minfChildren, 'smhd');
	const dinf = findBox(minfChildren, 'dinf');
	return {
		id,
		timescale: readTimescale(init.subarray(mdhd.start, mdhd.end)),
		tkhd: copy(init.subarray(tkhd.start, tkhd.end)),
		mdhd: copy(init.subarray(mdhd.start, mdhd.end)),
		hdlr: copy(init.subarray(hdlr.start, hdlr.end)),
		mediaHeader: mediaHeader ? copy(init.subarray(mediaHeader.start, mediaHeader.end)) : null,
		dinf: dinf ? copy(init.subarray(dinf.start, dinf.end)) : null,
		stsd: copy(init.subarray(stsd.start, stsd.end)),
	};
}

/** Time-to-sample runs. */
function buildStts(samples: SampleRecord[]): Uint8Array {
	const runs: { count: number; delta: number }[] = [];
	for (const sample of samples) {
		const delta = sample.duration >>> 0;
		const last = runs[runs.length - 1];
		if (last && last.delta === delta) last.count++;
		else runs.push({ count: 1, delta });
	}
	const { bytes, view } = table(runs.length, 8);
	runs.forEach((run, index) => {
		view.setUint32(index * 8, run.count);
		view.setUint32(index * 8 + 4, run.delta);
	});
	return fullBox('stts', 0, u32(runs.length), bytes);
}

/** Composition offsets. Omitted when every sample has a zero offset. */
function buildCtts(samples: SampleRecord[]): Uint8Array | null {
	if (!samples.some((sample) => sample.cts !== 0)) return null;
	const signed = samples.some((sample) => sample.cts < 0);
	const runs: { count: number; offset: number }[] = [];
	for (const sample of samples) {
		const offset = sample.cts;
		const last = runs[runs.length - 1];
		if (last && last.offset === offset) last.count++;
		else runs.push({ count: 1, offset });
	}
	const { bytes, view } = table(runs.length, 8);
	runs.forEach((run, index) => {
		view.setUint32(index * 8, run.count);
		if (signed) view.setInt32(index * 8 + 4, run.offset);
		else view.setUint32(index * 8 + 4, run.offset);
	});
	return fullBox('ctts', signed ? 1 : 0, u32(runs.length), bytes);
}

/** Sync sample table, omitted when every sample is a sync sample. */
function buildStss(samples: SampleRecord[]): Uint8Array | null {
	const sync: number[] = [];
	for (let index = 0; index < samples.length; index++) {
		if (!(samples[index].flags & NON_SYNC_SAMPLE)) sync.push(index + 1);
	}
	if (sync.length === samples.length || sync.length === 0) return null;
	const { bytes, view } = table(sync.length, 4);
	sync.forEach((number, index) => view.setUint32(index * 4, number));
	return fullBox('stss', 0, u32(sync.length), bytes);
}

/** Sample-to-chunk runs. */
function buildStsc(chunks: ChunkRecord[]): Uint8Array {
	const runs: { first: number; count: number }[] = [];
	for (let index = 0; index < chunks.length; index++) {
		const count = chunks[index].count;
		const last = runs[runs.length - 1];
		if (last && last.count === count) continue;
		runs.push({ first: index + 1, count });
	}
	const { bytes, view } = table(runs.length, 12);
	runs.forEach((run, index) => {
		view.setUint32(index * 12, run.first);
		view.setUint32(index * 12 + 4, run.count);
		view.setUint32(index * 12 + 8, 1); // sample_description_index
	});
	return fullBox('stsc', 0, u32(runs.length), bytes);
}

/** Sample sizes. */
function buildStsz(samples: SampleRecord[]): Uint8Array {
	const { bytes, view } = table(samples.length, 4);
	samples.forEach((sample, index) => view.setUint32(index * 4, sample.size));
	return fullBox('stsz', 0, u32(0), u32(samples.length), bytes);
}

/** Chunk offsets, using the 64-bit table when a file grows past 4 GB. */
function buildStco(chunks: ChunkRecord[]): Uint8Array {
	const wide = chunks.some((chunk) => chunk.offset > 0xffffffff);
	const stride = wide ? 8 : 4;
	const { bytes, view } = table(chunks.length, stride);
	chunks.forEach((chunk, index) => {
		if (wide) view.setBigUint64(index * stride, BigInt(Math.round(chunk.offset)));
		else view.setUint32(index * stride, chunk.offset >>> 0);
	});
	return fullBox(wide ? 'co64' : 'stco', 0, u32(chunks.length), bytes);
}

// ---------------------------------------------------------------------------
// Resume index
// ---------------------------------------------------------------------------

const INDEX_MAGIC = 0x42464d49; // 'BFMI'
const INDEX_VERSION = 1;
const INDEX_HEADER = 16;
const RECORD_HEADER = 20;

/**
 * The index header: magic, version, the `ftyp` length, the init segment, and
 * then one record per fragment. The init segment is kept so a resumed run can
 * rebuild the track templates without a fresh mux.js init.
 */
export function encodeIndexHeader(init: Uint8Array): Uint8Array {
	const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
	const ftyp = findBox(boxesIn(view, init.byteLength), 'ftyp');
	const out = new Uint8Array(INDEX_HEADER + init.byteLength);
	const outView = new DataView(out.buffer);
	outView.setUint32(0, INDEX_MAGIC);
	out[4] = INDEX_VERSION;
	outView.setUint32(8, ftyp ? ftyp.end - ftyp.start : 0);
	outView.setUint32(12, init.byteLength);
	out.set(init, INDEX_HEADER);
	return out;
}

/** One fragment's `moof` plus the position its media was written at. */
export function encodeIndexRecord(fragment: ParsedFragment, payloadOffset: number): Uint8Array {
	const out = new Uint8Array(RECORD_HEADER + fragment.moof.byteLength);
	const view = new DataView(out.buffer);
	view.setUint32(0, fragment.moof.byteLength);
	view.setUint32(4, fragment.media.byteLength);
	view.setUint32(8, fragment.mediaOffset);
	view.setBigUint64(12, BigInt(Math.round(payloadOffset)));
	out.set(fragment.moof, RECORD_HEADER);
	return out;
}

export interface IndexRecord {
	samples: FragmentSamples;
	payloadOffset: number;
}

export interface IndexState {
	init: Uint8Array;
	fragments: IndexRecord[];
	/** The end of the media the index covers, in absolute file bytes. */
	mediaEnd: number;
	/** True when the file stops part-way through a record (a torn append). */
	torn: boolean;
}

export function readIndex(data: Uint8Array): IndexState {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (data.byteLength < INDEX_HEADER || view.getUint32(0) !== INDEX_MAGIC) {
		throw new Mp4Error('The interrupted download has no usable index.');
	}
	if (data[4] !== INDEX_VERSION) throw new Mp4Error('The interrupted download was made by another version.');
	const ftypLength = view.getUint32(8);
	const initLength = view.getUint32(12);
	if (data.byteLength < INDEX_HEADER + initLength) {
		throw new Mp4Error('The interrupted download has a truncated index.');
	}
	const init = data.slice(INDEX_HEADER, INDEX_HEADER + initLength);

	const fragments: IndexRecord[] = [];
	let mediaEnd = ftypLength;
	let torn = false;
	let at = INDEX_HEADER + initLength;
	while (at < data.byteLength) {
		if (at + RECORD_HEADER > data.byteLength) {
			torn = true;
			break;
		}
		const moofLength = view.getUint32(at);
		const mediaLength = view.getUint32(at + 4);
		const mediaOffset = view.getUint32(at + 8);
		const payloadOffset = Number(view.getBigUint64(at + 12));
		if (at + RECORD_HEADER + moofLength > data.byteLength) {
			torn = true;
			break;
		}
		const moof = data.subarray(at + RECORD_HEADER, at + RECORD_HEADER + moofLength);
		const samples = parseMoof(moof, mediaOffset, mediaLength);
		fragments.push({ samples, payloadOffset });
		mediaEnd = payloadOffset + mediaLength;
		at += RECORD_HEADER + moofLength;
	}
	return { init, fragments, mediaEnd, torn };
}
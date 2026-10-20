import muxjs from 'mux.js';

/**
 * MPEG-TS to fragmented MP4 transmuxing via mux.js.
 *
 * mux.js only emits output when `flush()` is called, so a full episode has to
 * be buffered before it can be muxed. That is fine on desktop; on mobile the
 * caller should prefer the raw `.ts` output, which can be appended segment by
 * segment without holding the whole episode in memory.
 */

export interface TransmuxResult {
        /** The `moov`/`ftyp` init segment, or null when no track was found. */
        init: Uint8Array | null;
        /** Media fragments (`moof`+`mdat`) in playback order. */
        fragments: Uint8Array[];
}

export class TransmuxError extends Error {}

export function transmux(segments: Uint8Array[]): TransmuxResult {
        const transmuxer = new muxjs.mp4.Transmuxer();
        const fragments: Uint8Array[] = [];
        let init: Uint8Array | null = null;
        transmuxer.on('data', (segment: { initSegment?: Uint8Array; data: Uint8Array }) => {
                if (segment.initSegment && !init) init = segment.initSegment;
                fragments.push(segment.data);
        });
        for (const segment of segments) transmuxer.push(segment);
        transmuxer.flush();
        if (!init || fragments.length === 0) {
                throw new TransmuxError('The stream could not be converted to MP4.');
        }
        return { init, fragments };
}

interface Box {
        start: number;
        end: number;
}

/**
 * Write the real duration into the MP4 so players can seek and report length.
 *
 * mux.js builds the movie header before it knows the length, so it writes the
 * "unknown duration" sentinel (`0xffffffff`) into `mvhd`, the same sentinel into
 * every `tkhd` and `mdhd`, and emits no `mehd`. A player that reads the movie
 * header (VLC, browsers) copes, but one that reads the track headers — Samsung
 * Gallery among them — shows the sentinel: at a 90 kHz timescale `0xffffffff`
 * is 47721s, which players clamp to 1:35:15, so every file looks the same
 * length. The HLS playlist knows the true length, so write it into all four.
 */
export function patchDuration(input: Uint8Array, durationSeconds: number): Uint8Array {
        if (!(durationSeconds > 0)) return input;
        const view = new DataView(input.buffer, input.byteOffset, input.byteLength);

        const moov = findBox(view, 0, input.byteLength, 'moov');
        if (!moov) return input;

        // Collect the children before mutating so the edits do not disturb the walk.
        let mvhd: Box | null = null;
        let mvex: Box | null = null;
        const traks: Box[] = [];
        let child = moov.start + 8;
        while (child + 8 <= moov.end) {
                const size = view.getUint32(child);
                if (size < 8) break;
                const type = readType(view, child + 4);
                if (type === 'mvhd') mvhd = { start: child, end: child + size };
                else if (type === 'mvex') mvex = { start: child, end: child + size };
                else if (type === 'trak') traks.push({ start: child, end: child + size });
                child += size;
        }
        if (!mvhd) return input;

        // The movie header runs on a fixed 90 kHz clock.
        const movieTicks = Math.round(durationSeconds * (readTimescale(view, mvhd) || 90000));
        writeDuration(view, mvhd, movieTicks);

        // Each track header and media header has its own timescale (90 kHz for
        // video, the sample rate for audio), so each needs its own scaling.
        for (const trak of traks) {
                const tkhd = findChild(view, trak, 'tkhd');
                if (tkhd) writeDuration(view, tkhd, Math.round(durationSeconds * 1000));
                const mdia = findChild(view, trak, 'mdia');
                const mdhd = mdia ? findChild(view, mdia, 'mdhd') : null;
                if (mdhd) {
                        writeDuration(view, mdhd, Math.round(durationSeconds * (readTimescale(view, mdhd) || 1000)));
                }
        }

        if (!mvex) return input;

        // A file that has already been patched (a repair pass over an existing
        // download) carries a `mehd`; update it rather than adding a second.
        const existingMehd = findChild(view, mvex, 'mehd');
        if (existingMehd) {
                writeDuration(view, existingMehd, movieTicks);
                return input;
        }

        // Insert a version 1 `mehd` as the first child of `mvex`.
        const mehd = new Uint8Array(20);
        const mehdView = new DataView(mehd.buffer);
        mehdView.setUint32(0, 20);
        mehd.set([0x6d, 0x65, 0x68, 0x64], 4); // 'mehd'
        mehdView.setUint8(8, 1);
        mehdView.setUint32(9, 0);
        mehdView.setBigUint64(12, BigInt(movieTicks));

        const output = new Uint8Array(input.byteLength + mehd.byteLength);
        output.set(input.subarray(0, mvex.start + 8), 0);
        output.set(mehd, mvex.start + 8);
        output.set(input.subarray(mvex.start + 8), mvex.start + 8 + mehd.byteLength);

        const outView = new DataView(output.buffer, output.byteOffset, output.byteLength);
        outView.setUint32(moov.start, moov.end - moov.start + mehd.byteLength);
        outView.setUint32(mvex.start, mvex.end - mvex.start + mehd.byteLength);
        return output;
}

/** Read the timescale from an `mvhd` or `mdhd` box. */
function readTimescale(view: DataView, box: Box): number {
        const body = box.start + 8;
        const version = view.getUint8(body);
        return view.getUint32(body + (version === 1 ? 20 : 12));
}

/**
 * Write a duration into an `mvhd`, `tkhd` or `mdhd`. The field is 32-bit in
 * version 0 and 64-bit in version 1, and `tkhd` carries an extra `reserved`
 * field that shifts it by four bytes.
 */
function writeDuration(view: DataView, box: Box, ticks: number): void {
        const isTkhd = readType(view, box.start + 4) === 'tkhd';
        const body = box.start + 8;
        const version = view.getUint8(body);
        if (version === 1) {
                view.setBigUint64(body + (isTkhd ? 28 : 24), BigInt(Math.round(ticks)));
                return;
        }
        view.setUint32(body + (isTkhd ? 20 : 16), ticks >>> 0);
}

/** Find a direct child box by type. */
function findChild(view: DataView, parent: Box, type: string): Box | null {
        let offset = parent.start + 8;
        while (offset + 8 <= parent.end) {
                const size = view.getUint32(offset);
                if (size < 8) return null;
                if (readType(view, offset + 4) === type) {
                        return { start: offset, end: offset + size };
                }
                offset += size;
        }
        return null;
}

function findBox(view: DataView, start: number, end: number, type: string): Box | null {
        let offset = start;
        while (offset + 8 <= end) {
                const size = view.getUint32(offset);
                if (size < 8 || offset + size > end) return null;
                if (readType(view, offset + 4) === type) {
                        return { start: offset, end: offset + size };
                }
                offset += size;
        }
        return null;
}

function readType(view: DataView, offset: number): string {
        return String.fromCharCode(
                view.getUint8(offset),
                view.getUint8(offset + 1),
                view.getUint8(offset + 2),
                view.getUint8(offset + 3),
        );
}



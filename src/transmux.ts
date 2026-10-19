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

/**
 * Write the real duration into the MP4 so players can seek. mux.js hardcodes
 * the "unknown duration" sentinel in `mvhd` and emits no `mehd`, which makes
 * some players refuse to seek; the HLS playlist knows the true length.
 */
export function patchDuration(input: Uint8Array, durationSeconds: number): Uint8Array {
        if (!(durationSeconds > 0)) return input;
        const buffer = toBuffer(input);
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

        const moov = findBox(view, 0, buffer.byteLength, 'moov');
        if (!moov) return input;

        let mvhd: Box | null = null;
        let mvex: Box | null = null;
        let child = moov.start + 8;
        while (child + 8 <= moov.end) {
                const size = view.getUint32(child);
                if (size < 8) break;
                const type = readType(view, child + 4);
                if (type === 'mvhd') mvhd = { start: child, end: child + size };
                else if (type === 'mvex') mvex = { start: child, end: child + size };
                child += size;
        }
        if (!mvhd) return input;

        const version = view.getUint8(mvhd.start + 8);
        const timescale =
                version === 1
                        ? view.getUint32(mvhd.start + 28)
                        : view.getUint32(mvhd.start + 20);
        const ticks = Math.round(durationSeconds * (timescale || 1000));

        // Patch mvhd's duration in place.
        if (version === 1) view.setBigUint64(mvhd.start + 32, BigInt(ticks));
        else view.setUint32(mvhd.start + 24, ticks >>> 0);

        if (!mvex) return input;

        // Insert a version 1 `mehd` as the first child of `mvex`.
        const mehd = new Uint8Array(20);
        const mehdView = new DataView(mehd.buffer);
        mehdView.setUint32(0, 20);
        mehd.set([0x6d, 0x65, 0x68, 0x64], 4); // 'mehd'
        mehdView.setUint8(8, 1);
        mehdView.setUint32(9, 0);
        mehdView.setBigUint64(12, BigInt(ticks));

        const output = new Uint8Array(buffer.byteLength + mehd.byteLength);
        output.set(buffer.subarray(0, mvex.start + 8), 0);
        output.set(mehd, mvex.start + 8);
        output.set(buffer.subarray(mvex.start + 8), mvex.start + 8 + mehd.byteLength);

        const outView = new DataView(output.buffer);
        outView.setUint32(moov.start, moov.end - moov.start + mehd.byteLength);
        outView.setUint32(mvex.start, mvex.end - mvex.start + mehd.byteLength);
        return output;
}

interface Box {
        start: number;
        end: number;
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

function toBuffer(data: Uint8Array): Uint8Array {
        return data;
}

/** Join the init segment and fragments into a single MP4 file. */
export function assembleMp4(result: TransmuxResult, durationSeconds: number): Uint8Array {
        const total =
                (result.init?.byteLength ?? 0) +
                result.fragments.reduce((sum, fragment) => sum + fragment.byteLength, 0);
        const output = new Uint8Array(total);
        let offset = 0;
        if (result.init) {
                output.set(result.init, offset);
                offset += result.init.byteLength;
        }
        for (const fragment of result.fragments) {
                output.set(fragment, offset);
                offset += fragment.byteLength;
        }
        return patchDuration(output, durationSeconds);
}

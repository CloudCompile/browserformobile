import { convertFragmented } from './mp4';
import { patchDuration } from './transmux';
import { collectFiles } from './utils';

/**
 * Repairs already-downloaded MP4s.
 *
 * Files written before 1.1.1 carry mux.js's "unknown duration" sentinel
 * (`0xffffffff`) in `tkhd` and `mdhd`, so players that read the track headers
 * — Samsung Gallery, notably — show every file as the same length (47721s,
 * clamped to 1:35:15). The true length is still in `mvhd` and `mehd`, so the
 * file can be repaired in place without re-downloading it.
 *
 * Files written before the progressive writer are also *fragmented*: empty
 * sample tables and `moof`/`mdat` fragments, which a browser's `<video>` reads
 * and a phone gallery, a TV, QuickTime or Windows does not. Those are converted
 * to progressive MP4 here, for the same reason — the media is already on disk,
 * so a repair beats asking the user to re-download every episode.
 */

const SENTINEL = 0xffffffff;

export interface DurationPatch {
        /** Seconds recovered from the file, or null when none could be read. */
        durationSeconds: number | null;
        /** Track header durations that were left at the sentinel. */
        staleTrackHeaders: number;
}

interface Box {
        start: number;
        end: number;
}

function boxes(view: DataView, start: number, end: number): { type: string; box: Box }[] {
        const found: { type: string; box: Box }[] = [];
        let offset = start;
        while (offset + 8 <= end) {
                const size = view.getUint32(offset);
                if (size < 8 || offset + size > end) break;
                found.push({ type: readType(view, offset + 4), box: { start: offset, end: offset + size } });
                offset += size;
        }
        return found;
}

function readType(view: DataView, offset: number): string {
        return String.fromCharCode(
                view.getUint8(offset),
                view.getUint8(offset + 1),
                view.getUint8(offset + 2),
                view.getUint8(offset + 3),
        );
}

function readDuration(view: DataView, box: Box): number {
        const body = box.start + 8;
        const version = view.getUint8(body);
        const isTkhd = readType(view, box.start + 4) === 'tkhd';
        if (version === 1) {
                return Number(view.getBigUint64(body + (isTkhd ? 28 : 24)));
        }
        return view.getUint32(body + (isTkhd ? 20 : 16));
}

function readTimescale(view: DataView, box: Box): number {
        const body = box.start + 8;
        const version = view.getUint8(body);
        return view.getUint32(body + (version === 1 ? 20 : 12));
}

/**
 * Inspect an MP4 and report the duration that can be recovered plus how many
 * track headers are still at the sentinel.
 */
export function inspectDuration(data: Uint8Array): DurationPatch {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const top = boxes(view, 0, data.byteLength);
        const moov = top.find((entry) => entry.type === 'moov');
        if (!moov) return { durationSeconds: null, staleTrackHeaders: 0 };

        const children = boxes(view, moov.box.start + 8, moov.box.end);
        const mvhd = children.find((entry) => entry.type === 'mvhd');
        const mvex = children.find((entry) => entry.type === 'mvex');

        let durationSeconds: number | null = null;
        if (mvhd) {
                const ticks = readDuration(view, mvhd.box);
                const timescale = readTimescale(view, mvhd.box) || 90000;
                if (ticks !== SENTINEL && ticks > 0) durationSeconds = ticks / timescale;
        }
        if (durationSeconds === null && mvex) {
                const mehd = boxes(view, mvex.box.start + 8, mvex.box.end).find((entry) => entry.type === 'mehd');
                if (mehd) {
                        const ticks = readDuration(view, mehd.box);
                        if (ticks !== SENTINEL && ticks > 0) {
                                durationSeconds = ticks / (mvhd ? readTimescale(view, mvhd.box) || 90000 : 90000);
                        }
                }
        }

        let staleTrackHeaders = 0;
        for (const entry of children) {
                if (entry.type !== 'trak') continue;
                const parts = boxes(view, entry.box.start + 8, entry.box.end);
                const tkhd = parts.find((part) => part.type === 'tkhd');
                if (tkhd && readDuration(view, tkhd.box) === SENTINEL) staleTrackHeaders++;
                const mdia = parts.find((part) => part.type === 'mdia');
                if (mdia) {
                        const mdhd = boxes(view, mdia.box.start + 8, mdia.box.end).find((part) => part.type === 'mdhd');
                        if (mdhd && readDuration(view, mdhd.box) === SENTINEL) staleTrackHeaders++;
                }
        }

        return { durationSeconds, staleTrackHeaders };
}

export interface FileInspection extends DurationPatch {
        /** Track headers whose duration does not match the recovered one. */
        mismatchedTrackHeaders: number;
        /** The movie is fragmented (`moov` carries `mvex`), so most players
         *  outside a browser cannot read it. */
        fragmented: boolean;
}

/** True when the file is a fragmented MP4 — the shape every download written
 *  before the progressive writer has. */
export function isFragmented(data: Uint8Array): boolean {
        if (data.byteLength < 16) return false;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const moov = boxes(view, 0, data.byteLength).find((entry) => entry.type === 'moov');
        return Boolean(moov && boxes(view, moov.box.start + 8, moov.box.end).some((entry) => entry.type === 'mvex'));
}

/** True when the file looks like an MP4 this plugin should rewrite.
 *
 *  Covers the original 1.1.0 sentinel case (`0xffffffff`), the "wrong scaling"
 *  case where the track duration was written in milliseconds even though the
 *  movie runs on its 90 kHz clock, and every fragmented movie. The first two
 *  play at the right length in header-aware players (VLC, browsers) but show up
 *  as a few seconds in Google Photos / Samsung Gallery; a fragmented file plays
 *  only in those header-aware players at all.
 */
export function needsRepair(data: Uint8Array): boolean {
        if (data.byteLength < 16 || readType(new DataView(data.buffer, data.byteOffset, data.byteLength), 4) !== 'ftyp') {
                return false;
        }
        const patch = inspectDurationEnhanced(data);
        return patch.fragmented || (patch.durationSeconds !== null && (patch.staleTrackHeaders > 0 || patch.mismatchedTrackHeaders > 0));
}

/** Inspect an MP4, count track headers whose duration is not the recovered
 *  (correctly scaled) one, and report whether it is fragmented.
 *
 *  The header comparison only applies to a *fragmented* movie. Those are the
 *  files mux.js wrote with empty sample tables, where a header is the only
 *  place a duration appears — and the only shape the bug ever produced. A
 *  progressive file's headers are computed from its own sample tables, so its
 *  tracks legitimately end at slightly different times (the audio track is
 *  generally a frame short of the video one) and every healthy download would
 *  be flagged. */
export function inspectDurationEnhanced(data: Uint8Array): FileInspection {
        const base = inspectDuration(data);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const moov = boxes(view, 0, data.byteLength).find((entry) => entry.type === 'moov');
        const children = moov ? boxes(view, moov.box.start + 8, moov.box.end) : [];
        const fragmented = children.some((entry) => entry.type === 'mvex');
        let mismatchedTrackHeaders = 0;
        if (fragmented && base.durationSeconds !== null) {
                const mvhd = children.find((e) => e.type === 'mvhd');
                if (mvhd) {
                        const mvTimescale = readTimescale(view, mvhd.box) || 90000;
                        const movieTicks = Math.round(base.durationSeconds * mvTimescale);
                        for (const entry of children) {
                                if (entry.type !== 'trak') continue;
                                const parts = boxes(view, entry.box.start + 8, entry.box.end);
                                const tkhd = parts.find((p) => p.type === 'tkhd');
                                if (tkhd) {
                                        const actual = readDuration(view, tkhd.box);
                                        if (Math.abs(actual - movieTicks) > 2) mismatchedTrackHeaders++;
                                }
                                const mdia = parts.find((p) => p.type === 'mdia');
                                if (mdia) {
                                        const mdhd = boxes(view, mdia.box.start + 8, mdia.box.end).find((m) => m.type === 'mdhd');
                                        if (mdhd) {
                                                const mdTimescale = readTimescale(view, mdhd.box) || 1000;
                                                const expected = Math.round(base.durationSeconds * mdTimescale);
                                                const actual = readDuration(view, mdhd.box);
                                                if (Math.abs(actual - expected) > 2) mismatchedTrackHeaders++;
                                        }
                                }
                        }
                }
        }
        return { ...base, mismatchedTrackHeaders, fragmented };
}

/** Return a repaired copy, or null when nothing can be done.
 *
 *  A fragmented movie is rebuilt as progressive; the builder derives the real
 *  durations from the samples, so the old header patch is not applied first. A
 *  progressive movie only ever needed that patch, and is copied through it. */
export function repairDuration(data: Uint8Array): { data: Uint8Array; durationSeconds: number } | null {
        if (isFragmented(data)) {
                const converted = convertFragmented(data);
                if (!converted) return null;
                return { data: converted, durationSeconds: inspectDuration(converted).durationSeconds ?? 0 };
        }
        const patch = inspectDuration(data);
        if (patch.durationSeconds === null) return null;
        return { data: patchDuration(data, patch.durationSeconds), durationSeconds: patch.durationSeconds };
}

/** A copy with no shared backing buffer, for handing to an ArrayBuffer API. */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export interface RepairResult {
        /** Files examined. */
        scanned: number;
        /** Files rewritten. */
        repaired: number;
        /** Seconds of duration recovered, per file. */
        fixed: { path: string; durationSeconds: number }[];
        /** Files that could not be read or written. */
        failed: { path: string; message: string }[];
}

interface VaultAdapter {
        readBinary(path: string): Promise<ArrayBuffer>;
        writeBinary(path: string, data: ArrayBuffer): Promise<void>;
        list(path: string): Promise<{ files: string[]; folders: string[] }>;
        exists(path: string): Promise<boolean>;
}

/**
 * Walk the download folder and repair every MP4 whose track durations are
 * still at the sentinel. Only files that need it are rewritten, and each is
 * rewritten in place.
 */
export async function repairFolder(
        adapter: VaultAdapter,
        folder: string,
        onProgress?: (path: string, done: number, total: number) => void,
): Promise<RepairResult> {
        const result: RepairResult = { scanned: 0, repaired: 0, fixed: [], failed: [] };
        const files = await collectMp4(adapter, folder);
        let done = 0;
        for (const path of files) {
                onProgress?.(path, done++, files.length);
                result.scanned++;
                try {
                        const buffer = await adapter.readBinary(path);
                        const data = new Uint8Array(buffer);
                        if (!needsRepair(data)) continue;
                        const repaired = repairDuration(data);
                        if (!repaired) continue;
                        await adapter.writeBinary(path, toArrayBuffer(repaired.data));
                        result.repaired++;
                        result.fixed.push({ path, durationSeconds: repaired.durationSeconds });
                } catch (error) {
                        result.failed.push({
                                path,
                                message: error instanceof Error ? error.message : String(error),
                        });
                }
        }
        return result;
}

async function collectMp4(adapter: VaultAdapter, folder: string): Promise<string[]> {
	return collectFiles(adapter, folder, (path) => /\.mp4$/i.test(path));
}

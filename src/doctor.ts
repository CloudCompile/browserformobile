import { patchDuration } from './transmux';

/**
 * Repairs already-downloaded MP4s.
 *
 * Files written before 1.1.1 carry mux.js's "unknown duration" sentinel
 * (`0xffffffff`) in `tkhd` and `mdhd`, so players that read the track headers
 * — Samsung Gallery, notably — show every file as the same length (47721s,
 * clamped to 1:35:15). The true length is still in `mvhd` and `mehd`, so the
 * file can be repaired in place without re-downloading it.
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

/** True when the file looks like an MP4 with stale track durations. */
export function needsRepair(data: Uint8Array): boolean {
        if (data.byteLength < 16 || readType(new DataView(data.buffer, data.byteOffset, data.byteLength), 4) !== 'ftyp') {
                return false;
        }
        const patch = inspectDuration(data);
        return patch.staleTrackHeaders > 0 && patch.durationSeconds !== null;
}

/** Return a repaired copy, or null when nothing can be done. */
export function repairDuration(data: Uint8Array): { data: Uint8Array; durationSeconds: number } | null {
        const patch = inspectDuration(data);
        if (patch.durationSeconds === null || patch.staleTrackHeaders === 0) return null;
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
        const found: string[] = [];
        const walk = async (current: string): Promise<void> => {
                let listing: { files: string[]; folders: string[] };
                try {
                        listing = await adapter.list(current);
                } catch {
                        return;
                }
                for (const file of listing.files) {
                        if (/\.mp4$/i.test(file)) found.push(current ? `${current}/${file}` : file);
                }
                for (const child of listing.folders) {
                        await walk(current ? `${current}/${child}` : child);
                }
        };
        if (await adapter.exists(folder)) await walk(folder);
        return found;
}

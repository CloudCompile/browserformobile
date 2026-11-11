import { convertFragmented } from './mp4';
import { patchDuration } from './transmux';
import { collectFiles, mapWithConcurrency } from './utils';

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

/**
 * An `ArrayBuffer` holding exactly this view's bytes, for an API that wants one.
 *
 * A view that already spans its whole buffer is handed over as-is. Slicing it
 * would allocate a second copy of the file — for a full episode that is another
 * hundred-odd megabytes on top of the input and the repaired output, which is
 * the difference between a repair finishing and the phone killing the app.
 */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
        if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
                return data.buffer as ArrayBuffer;
        }
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export interface RepairResult {
        /** Files examined. */
        scanned: number;
        /** Files rewritten. */
        repaired: number;
        /** Files skipped without being read, because a previous pass cleared them. */
        skipped: number;
        /** Seconds of duration recovered, per file. */
        fixed: { path: string; durationSeconds: number }[];
        /** Files that could not be read or written. */
        failed: { path: string; message: string }[];
}

export interface VaultAdapter extends AtomicWriter {
        readBinary(path: string): Promise<ArrayBuffer>;
        list(path: string): Promise<{ files: string[]; folders: string[] }>;
        exists(path: string): Promise<boolean>;
        /** File metadata, when the adapter can report it. Used to bound the batch. */
        stat?(path: string): Promise<{ size: number; mtime?: number } | null>;
}

/**
 * Files a previous pass already cleared, so a later pass can skip them.
 *
 * The repair cannot look at part of a file: the adapter reads whole files, and
 * `moov` may sit at either end. So every file costs a full read — and for a
 * folder of episodes that is the whole collection, re-read on every run, only to
 * find that the great majority were fine the first time. A file that is already
 * progressive never changes unless something rewrites it, and Obsidian reports
 * that as a new size and mtime. Recording the pair a pass left behind lets the
 * next pass trust it and read nothing.
 *
 * A file is only trusted while its size *and* mtime both match the record, so an
 * edit, a re-download or a sync that replaces it invalidates the entry by
 * itself. The ledger is only ever written for files this plugin has verified or
 * written, both of which are correct, so skipping them cannot hide a bad file.
 */
export class RepairLedger {
        private entries: Record<string, string>;

        constructor(records?: unknown) {
                this.entries = {};
                if (records && typeof records === 'object') {
                        for (const [path, stamp] of Object.entries(records as Record<string, unknown>)) {
                                if (typeof stamp === 'string') this.entries[path] = stamp;
                        }
                }
        }

        /** True when `path` is unchanged since the pass that cleared it. */
        isClean(path: string, size: number, mtime: number): boolean {
                return this.entries[path] === `${size}:${mtime}`;
        }

        markClean(path: string, size: number, mtime: number): void {
                this.entries[path] = `${size}:${mtime}`;
        }

        forget(path: string): void {
                delete this.entries[path];
        }

        /**
         * Adopt the download manager's scan verdicts.
         *
         * The scan reads every file once to decide what needs repair, and stores
         * each verdict under a `mtime|size` key. That is the same evidence a repair
         * pass records, so taking it over lets the first repair after a scan read
         * only the files the scan flagged — instead of reading the whole
         * collection a second time to reach the same conclusion. Only verdicts the
         * scan reached without error (`needsRepair: false`) are adopted.
         */
        seedFromScanCache(records: unknown): void {
                if (!records || typeof records !== 'object') return;
                const entries = Object.entries(records as Record<string, { key?: unknown; status?: { needsRepair?: unknown } }>);
                for (const [path, entry] of entries) {
                        if (entry?.status?.needsRepair !== false) continue;
                        if (typeof entry.key !== 'string') continue;
                        const [mtimeText, sizeText] = entry.key.split('|');
                        const mtime = Number(mtimeText);
                        const size = Number(sizeText);
                        // A stamp that cannot change is no evidence the file is unchanged.
                        if (!Number.isFinite(mtime) || !Number.isFinite(size) || mtime <= 0) continue;
                        this.markClean(path, size, mtime);
                }
        }

        toJSON(): Record<string, string> {
                return this.entries;
        }
}

/** The write surface an atomic replace needs, and nothing more. */
export interface AtomicWriter {
        writeBinary(path: string, data: ArrayBuffer): Promise<void>;
        rename(from: string, to: string): Promise<void>;
        remove(path: string): Promise<void>;
}

/**
 * Replace a file's contents without a window where a failure loses it.
 *
 * Writing the repaired bytes straight back over the original is unsafe: Obsidian
 * truncates the target first, so an interruption (the Android app is reclaimed in
 * the background, the disk fills) leaves a half-written file where a playable
 * video used to be — the repair destroys exactly what it set out to fix. The
 * repaired bytes go to a sibling temp file, which is swapped in with a rename
 * only once it is fully on disk. A failure before the rename leaves the original
 * untouched.
 */
export async function writeAtomically(adapter: AtomicWriter, path: string, data: Uint8Array): Promise<void> {
        const temp = `${path}.bfm-repair`;
        let originalRemoved = false;
        try {
                await adapter.writeBinary(temp, toArrayBuffer(data));
                // Obsidian's rename refuses an existing target, so the original is
                // cleared immediately before the swap. The repaired copy is already
                // fully written at this point.
                await adapter.remove(path);
                originalRemoved = true;
                await adapter.rename(temp, path);
        } catch (error) {
                // Only discard the temp while the original is still in place. Once
                // the original has been removed the temp holds the only copy, so
                // losing it would lose the video.
                if (!originalRemoved) await adapter.remove(temp).catch(() => undefined);
                throw error;
        }
}

/** How many files may be repaired at once. */
const REPAIR_IN_FLIGHT = 4;

/**
 * Bytes of video the batch may hold at once.
 *
 * A file is repaired with its own bytes and the rebuilt copy in memory together,
 * so the working set is about twice the file. The whole batch is kept inside a
 * quarter of the device's RAM: Obsidian, the vault index and the rest of the app
 * need the remainder, and a phone that runs out kills the process outright rather
 * than paging. `navigator.deviceMemory` reports an approximate RAM size in GB on
 * the platforms Obsidian mobile uses; when it is absent a modest 2 GB is assumed.
 */
export function repairByteBudget(): number {
        const memory = typeof navigator !== 'undefined'
                ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
                : undefined;
        const gb = typeof memory === 'number' && Number.isFinite(memory) && memory > 0 ? memory : 2;
        return Math.max(64 * 1024 * 1024, Math.min((gb * 1024 ** 3) / 4, 384 * 1024 * 1024));
}

/**
 * The size and mtime of `files`, where the adapter can report them. A file that
 * cannot be stat-ed is left out, and is then treated as taking the whole budget
 * and as never clean.
 */
async function fileStamps(adapter: VaultAdapter, files: string[]): Promise<Map<string, { size: number; mtime: number }>> {
        const stamps = new Map<string, { size: number; mtime: number }>();
        const stat = adapter.stat?.bind(adapter);
        if (!stat) return stamps;
        await mapWithConcurrency(files, 8, async (path) => {
                try {
                        const info = await stat(path);
                        if (info) stamps.set(path, { size: info.size, mtime: info.mtime ?? 0 });
                } catch {
                        /* A file that vanished mid-scan is reported by the repair itself. */
                }
        });
        return stamps;
}

/**
 * Walk the download folder and repair every MP4 whose track durations are
 * still at the sentinel. Only files that need it are rewritten, and each is
 * replaced through a temp file so a failed write cannot lose the original.
 *
 * Files are repaired several at a time so one file's read overlaps the next
 * file's conversion instead of the disk being waited on serially. The batch is
 * bounded by `repairByteBudget` — and a file whose size is unknown runs on its
 * own — so a run on a phone stays inside its memory rather than being killed
 * partway through.
 *
 * When a `ledger` is supplied, a file a previous pass already cleared is trusted
 * from its size and mtime alone and is never read. Repairing a folder costs a
 * full read of every file it holds, so on a collection of episodes that is the
 * difference between scanning everything again and scanning only what changed.
 */
export async function repairFolder(
        adapter: VaultAdapter,
        folder: string,
        onProgress?: (path: string, done: number, total: number) => void,
        options: {
                byteBudget?: number;
                maxInFlight?: number;
                /** Refuse a single conversion that cannot fit safely in memory. */
                maxFileBytes?: number;
                ledger?: RepairLedger;
        } = {},
): Promise<RepairResult> {
        const result: RepairResult = { scanned: 0, repaired: 0, skipped: 0, fixed: [], failed: [] };
        const files = await collectMp4(adapter, folder);
        const budget = options.byteBudget ?? repairByteBudget();
        const maxInFlight = Math.max(1, options.maxInFlight ?? REPAIR_IN_FLIGHT);
        const stamps = await fileStamps(adapter, files);
        const known = stamps.size > 0;
        // The ledger is only meaningful when the adapter can report an mtime; a
        // stamp that cannot change is no evidence that a file is unchanged.
        const ledger = known && [...stamps.values()].some((s) => s.mtime > 0) ? options.ledger : undefined;

        let started = 0;
        let inFlightBytes = 0;
        const pending = new Set<Promise<void>>();

        const repairOne = async (path: string): Promise<void> => {
                onProgress?.(path, started++, files.length);
                result.scanned++;
                try {
                        const buffer = await adapter.readBinary(path);
                        const data = new Uint8Array(buffer);
                        if (!needsRepair(data)) {
                                // Verified good; remember it so the next pass reads nothing.
                                const stamp = stamps.get(path);
                                if (ledger && stamp) ledger.markClean(path, stamp.size, stamp.mtime);
                                return;
                        }
                        const repaired = repairDuration(data);
                        if (!repaired) return;
                        await writeAtomically(adapter, path, repaired.data);
                        result.repaired++;
                        result.fixed.push({ path, durationSeconds: repaired.durationSeconds });
                        // The swap changed the file; record what it is now.
                        const after = ledger && adapter.stat ? await adapter.stat(path).catch(() => null) : null;
                        if (ledger && after) ledger.markClean(path, after.size, after.mtime ?? 0);
                } catch (error) {
                        ledger?.forget(path);
                        result.failed.push({
                                path,
                                message: error instanceof Error ? error.message : String(error),
                        });
                }
        };

        for (const path of files) {
                const stamp = stamps.get(path);
                // A file a previous pass cleared, and that has not changed since, needs
                // no read at all.
                if (ledger && stamp && stamp.mtime > 0 && ledger.isClean(path, stamp.size, stamp.mtime)) {
                        onProgress?.(path, started++, files.length);
                        result.scanned++;
                        result.skipped++;
                        continue;
                }
                if (options.maxFileBytes !== undefined && stamp && stamp.size > options.maxFileBytes) {
                        onProgress?.(path, started++, files.length);
                        result.scanned++;
                        ledger?.forget(path);
                        result.failed.push({
                                path,
                                message: `Skipped ${Math.round(stamp.size / (1024 * 1024))} MB file: repair is limited to ${Math.round(options.maxFileBytes / (1024 * 1024))} MB on this device to prevent an out-of-memory restart.`,
                        });
                        continue;
                }
                // An unknown size is assumed to fill the budget so that file runs alone;
                // without a size there is no way to know what it costs.
                const weight = known ? 2 * (stamps.get(path)?.size ?? budget) : 2 * budget;
                while (pending.size >= maxInFlight || (pending.size > 0 && inFlightBytes + weight > budget)) {
                        await Promise.race(pending);
                }
                inFlightBytes += weight;
                let task!: Promise<void>;
                task = repairOne(path).finally(() => {
                        inFlightBytes -= weight;
                        pending.delete(task);
                });
                pending.add(task);
        }
        await Promise.all(pending);
        return result;
}

async function collectMp4(adapter: VaultAdapter, folder: string): Promise<string[]> {
	return collectFiles(adapter, folder, (path) => /\.mp4$/i.test(path));
}

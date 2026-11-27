import { describe, expect, it } from 'vitest';
import { RepairLedger, repairFolder, type VaultAdapter } from '../src/doctor';
import { VideoLibrary } from '../src/library';

/**
 * The 1.11.x–1.12.x line bought back a 676-file library with a persistent scan
 * cache, single-pass inspection, stat batching, and a throttled render — and
 * nothing guarded those wins. This suite does, on a synthetic 700-file
 * library, by asserting the invariants that regress quietly rather than
 * absolute times: how many adapter reads a scan and a repair cost, and that
 * rendering touches the adapter never. Wall-clock is asserted too, with a
 * ceiling generous enough that a slow CI runner cannot flake it.
 */

const LIBRARY_SIZE = 700;
const FOLDER = 'Anime';
/** The downloader's own template, so every synthetic file parses. */
const TEMPLATE = '{series} - {ep:02} - {title}.{ext}';
/** Seconds; a ceiling a skipped optimisation blows past long before CI does. */
const WALL_CLOCK_BUDGET_MS = 5_000;

/** Minimal pieces for hand-built boxes. */
function writeU32(target: Uint8Array, offset: number, value: number): void {
	new DataView(target.buffer).setUint32(offset, value);
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
	const body = 8 + payload.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(body);
	writeU32(out, 0, body);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	let cursor = 8;
	for (const part of payload) {
		out.set(part, cursor);
		cursor += part.byteLength;
	}
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let cursor = 0;
	for (const part of parts) {
		out.set(part, cursor);
		cursor += part.byteLength;
	}
	return out;
}

/**
 * A healthy progressive MP4: `ftyp`, then a `moov` whose `mvhd`, `tkhd` and
 * `mdhd` all carry the same real duration and none of which is at the
 * sentinel. `needsRepair` answers false for it — exactly what a completed
 * modern download looks like to the repair scan.
 */
function healthyMp4(): Uint8Array {
	const timescale = 90_000;
	const duration = 90_000; // one second; the value is irrelevant to the budgets
	const word = (value: number): Uint8Array => {
		const out = new Uint8Array(4);
		writeU32(out, 0, value);
		return out;
	};
	return concat(
		box('ftyp', word(0x69736f6d), word(0)), // 'isom', minor 0
		box(
			'moov',
			// version+flags, ctime, mtime, timescale, duration
			box('mvhd', word(0), word(0), word(0), word(timescale), word(duration)),
			box(
				'trak',
				// version+flags, ctime, mtime, track id, reserved, duration
				box('tkhd', word(0), word(0), word(0), word(1), word(0), word(duration)),
				box(
					'mdia',
					// version+flags, ctime, mtime, timescale, duration
					box('mdhd', word(0), word(0), word(0), word(timescale), word(duration)),
				),
			),
		),
	);
}

/** An in-memory vault with read/stat counters — the budgets are the counts. */
class CountingVault implements VaultAdapter {
	files = new Map<string, { data: Uint8Array; mtime: number }>();
	stats = 0;
	reads = 0;

	add(path: string, data: Uint8Array): void {
		this.files.set(path, { data, mtime: 1_700_000_000_000 + this.files.size });
	}

	async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = folder ? `${folder}/` : '';
		return {
			files: [...this.files.keys()].filter((path) => path.startsWith(prefix)),
			folders: [],
		};
	}

	async exists(path: string): Promise<boolean> {
		return path === FOLDER || [...this.files.keys()].some((file) => file.startsWith(`${path}/`));
	}

	async stat(path: string): Promise<{ size: number; mtime: number } | null> {
		this.stats++;
		const file = this.files.get(path);
		return file ? { size: file.data.byteLength, mtime: file.mtime } : null;
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		this.reads++;
		const file = this.files.get(path);
		if (!file) throw new Error(`missing: ${path}`);
		return file.data.slice().buffer as ArrayBuffer;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.files.set(path, { data: new Uint8Array(data), mtime: Date.now() });
	}

	async rename(from: string, to: string): Promise<void> {
		const file = this.files.get(from);
		if (!file) throw new Error(`missing: ${from}`);
		this.files.delete(from);
		this.files.set(to, file);
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}
}

/** A library of healthy downloads, one episode per file. */
function populatedVault(): CountingVault {
	const vault = new CountingVault();
	const mp4 = healthyMp4();
	for (let ep = 1; ep <= LIBRARY_SIZE; ep++) {
		vault.add(`${FOLDER}/Naruto - ${String(ep).padStart(2, '0')} - Episode ${ep}.mp4`, mp4);
	}
	return vault;
}

describe('performance budgets (700-file library)', () => {
	it('a library scan stats every file and reads none', async () => {
		const vault = populatedVault();
		const library = new VideoLibrary();

		const started = performance.now();
		const { complete } = await library.refresh(vault, FOLDER, TEMPLATE);
		const elapsed = performance.now() - started;

		expect(complete, 'scan must see the whole folder').toBe(true);
		expect(library.items(), 'every file becomes an entry').toHaveLength(LIBRARY_SIZE);
		expect(vault.reads, 'budget broken: a scan must never read file contents').toBe(0);
		expect(vault.stats, 'budget broken: one stat per file').toBe(LIBRARY_SIZE);
		expect(elapsed, `budget broken: scan wall clock (${Math.round(elapsed)} ms)`).toBeLessThan(
			WALL_CLOCK_BUDGET_MS,
		);
	});

	it('rendering the list never touches the adapter', async () => {
		const vault = populatedVault();
		const library = new VideoLibrary();
		await library.refresh(vault, FOLDER, TEMPLATE);

		const readsBefore = vault.reads;
		const statsBefore = vault.stats;
		// What a render consumes, twice — the second call is the re-render a
		// progress tick or a filter change triggers.
		library.items();
		library.items();
		expect(vault.reads - readsBefore, 'budget broken: render must not read files').toBe(0);
		expect(vault.stats - statsBefore, 'budget broken: render must not re-stat the folder').toBe(0);
	});

	it('a repaired scan reads nothing on its second pass', async () => {
		const vault = populatedVault();

		// First pass: every file must be read to be verified, and the ledger
		// records what each verified file looked like.
		const ledger = new RepairLedger();
		const first = await repairFolder(vault, FOLDER, undefined, { ledger });
		expect(first.repaired, 'synthetic library is all healthy').toBe(0);
		expect(first.failed, 'no file may fail verification').toHaveLength(0);
		expect(vault.reads, 'budget broken: the first pass verifies every file').toBe(LIBRARY_SIZE);

		// Second pass over files that have not changed: no reads at all.
		const readsBefore = vault.reads;
		const second = await repairFolder(vault, FOLDER, undefined, { ledger });
		expect(second.scanned).toBe(LIBRARY_SIZE);
		expect(second.skipped, 'every verified file is skipped by stamp').toBe(LIBRARY_SIZE);
		expect(vault.reads - readsBefore, 'budget broken: a seeded repair re-read the library').toBe(0);
	});

	it('a repair without a ledger still reads, and seeding it from scratch reads all', async () => {
		// The control for the test above: without the ledger there is no
		// shortcut, which is the regression shape — someone dropping the seed
		// or the stamp comparison brings this count back.
		const vault = populatedVault();
		const result = await repairFolder(vault, FOLDER);
		expect(result.scanned).toBe(LIBRARY_SIZE);
		expect(vault.reads, 'budget broken: an unseeded repair reads every file (expected)').toBe(
			LIBRARY_SIZE,
		);
	});
});

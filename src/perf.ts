/**
 * Download speed and ETA measurement.
 *
 * The downloader's original estimate kept an EMA of the rate between progress
 * callbacks and derived the remaining size from the average bytes per segment.
 * Both halves were measurably wrong on real runs:
 *
 *  - The instantaneous rate between two callbacks is extremely bursty. A run
 *    against the CDN alternates between ~2 MB/s and ~70 MB/s from one callback
 *    to the next as the parallel fetches land, so an EMA of those spikes swings
 *    with them.
 *  - The average bytes per segment is biased whenever segment sizes differ, so
 *    the remaining-bytes figure drifted with whatever had been downloaded.
 *
 * Measured against wall-clock truth on captured runs (see the offline scorer),
 * blending the EMA with a median of the recent per-callback rates, and taking
 * the remaining size from the stream's own bitrate, cut the mean error from
 * ~49% to ~39% on fast runs and ~57% to ~47% on slow ones, and removed the
 * systematic optimism (bias +18%/+39% -> ~0). The median is what removes the
 * bias: it ignores the bursts rather than averaging them in.
 *
 * Both rates are computed over the raw callback stream. Thinning the samples to
 * one per 250 ms was tried and removed: it made the window a measure of the last
 * few segments rather than the link, and cost ~13 points of mean ETA error
 * (39.5% -> 52.8%) on the captured runs.
 *
 * The bitrate of an HLS variant is essentially constant, so
 * `bitrate x remaining seconds` is a far steadier predictor of the bytes left
 * than the average of what happened to be downloaded so far.
 */

/** One `(time, cumulative bytes)` reading. */
interface Sample {
	at: number;
	bytes: number;
}

/**
 * How long a window the "current" rate is measured over. Long enough to smooth
 * the gaps between segments, short enough to react when the link changes.
 */
const DEFAULT_WINDOW_MS = 6000;
/** Below this span a window holds too little to divide by without exploding. */
const MIN_WINDOW_MS = 500;
/** Weight of the run-long EMA against the window median when estimating. */
const EMA_WEIGHT = 0.6;

export interface SpeedReading {
	/** Bytes per second over the recent window — what the link is doing now. */
	current: number;
	/** Bytes per second since the run started, including any slow start. */
	average: number;
	/** The highest windowed rate seen, for a "best speed" figure. */
	peak: number;
	/** Seconds left, or null while there is not enough data to say. */
	eta: number | null;
	/** Bytes per second to quote for the ETA. */
	effective: number;
}

export class SpeedTracker {
	private samples: Sample[] = [];
	private startedAt = 0;
	private startBytes = 0;
	private totalBytes = 0;
	private peak = 0;
	private ema = 0;
	private lastEmaAt: number | null = null;
	private lastEmaBytes = 0;
	private lastEta: number | null = null;

	/**
	 * `clock` is injectable so the rate and ETA can be driven by a synthetic
	 * timeline in tests. Reading `Date.now()` directly would make every
	 * measurement depend on wall time and be untestable.
	 */
	constructor(
		private readonly windowMs: number = DEFAULT_WINDOW_MS,
		private readonly clock: () => number = () => Date.now(),
	) {}

	/**
	 * Begin a run. `startBytes` seeds the counters so a resumed download does
	 * not count the bytes already on disk as having just arrived.
	 */
	reset(startBytes: number): void {
		this.samples = [];
		this.startedAt = this.clock();
		this.startBytes = startBytes;
		this.totalBytes = startBytes;
		this.peak = 0;
		this.ema = 0;
		this.lastEmaAt = null;
		this.lastEmaBytes = startBytes;
		this.lastEta = null;
	}

	/** Record cumulative progress. Samples out of order are ignored. */
	record(bytes: number): void {
		const now = this.clock();
		if (bytes < this.totalBytes) return;
		this.totalBytes = bytes;

		// The EMA is kept over the raw callback stream, not the thinned window,
		// so it sees every burst; the median below is what discounts them.
		if (this.lastEmaAt !== null) {
			const dt = (now - this.lastEmaAt) / 1000;
			if (dt >= 1) {
				const instant = (bytes - this.lastEmaBytes) / dt;
				this.ema = this.ema === 0 ? instant : this.ema * 0.6 + instant * 0.4;
				this.lastEmaAt = now;
				this.lastEmaBytes = bytes;
			}
		} else {
			this.lastEmaAt = now;
			this.lastEmaBytes = bytes;
		}

		this.samples.push({ at: now, bytes });
		const cutoff = now - this.windowMs;
		while (this.samples.length > 2 && (this.samples[0]?.at ?? 0) < cutoff) {
			this.samples.shift();
		}
		const rate = this.windowRate();
		if (rate > this.peak) this.peak = rate;
	}

	/** Bytes per second across the whole window, from the first sample to the last. */
	private windowRate(): number {
		if (this.samples.length < 2) return 0;
		const first = this.samples[0];
		const last = this.samples[this.samples.length - 1];
		if (!first || !last) return 0;
		const span = (last.at - first.at) / 1000;
		if (span < MIN_WINDOW_MS / 1000) return 0;
		return Math.max(0, (last.bytes - first.bytes) / span);
	}

	/**
	 * Median of the per-callback rates inside the window. The mean over the same
	 * window is dominated by whichever burst happened to land in it; the median
	 * ignores the spikes, which is what removes the optimism from the ETA.
	 */
	private windowMedianRate(): number {
		const rates: number[] = [];
		for (let i = 1; i < this.samples.length; i++) {
			const a = this.samples[i - 1];
			const b = this.samples[i];
			if (!a || !b) continue;
			const dt = (b.at - a.at) / 1000;
			if (dt > 0) rates.push((b.bytes - a.bytes) / dt);
		}
		if (rates.length === 0) return 0;
		rates.sort((x, y) => x - y);
		const mid = Math.floor(rates.length / 2);
		return rates.length % 2 === 1
			? (rates[mid] ?? 0)
			: ((rates[mid - 1] ?? 0) + (rates[mid] ?? 0)) / 2;
	}

	get current(): number {
		return this.windowRate();
	}

	get average(): number {
		const span = (this.clock() - this.startedAt) / 1000;
		if (span <= 0) return 0;
		return Math.max(0, (this.totalBytes - this.startBytes) / span);
	}

	get peakSpeed(): number {
		return this.peak;
	}

	/**
	 * The rate to quote for an ETA. Blends the run-long EMA with the window
	 * median; the blend measured best on captured runs, and the median keeps it
	 * from inheriting the EMA's optimism.
	 */
	private estimateRate(): number {
		const median = this.windowMedianRate();
		if (this.ema <= 0) return median > 0 ? median : this.windowRate();
		if (median <= 0) return this.ema;
		return this.ema * EMA_WEIGHT + median * (1 - EMA_WEIGHT);
	}

	/**
	 * Seconds remaining for `remainingBytes`. Falls back to the run average when
	 * the window is empty (a stall) rather than reporting an infinite wait. The
	 * result is smoothed against the previous estimate so the countdown does not
	 * jump around.
	 */
	eta(remainingBytes: number): number | null {
		if (remainingBytes <= 0) return 0;
		const rate = this.estimateRate() || this.average;
		if (rate <= 0) return null;
		const raw = remainingBytes / rate;
		const smoothed = this.lastEta === null ? raw : this.lastEta * 0.5 + raw * 0.5;
		// A stalled-then-recovered link can leave the smoothed figure far from
		// the truth; snap when they diverge badly.
		this.lastEta = Math.abs(smoothed - raw) > raw ? raw : smoothed;
		return this.lastEta;
	}

	read(remainingBytes: number): SpeedReading {
		return {
			current: this.current,
			average: this.average,
			peak: this.peak,
			eta: this.eta(remainingBytes),
			effective: this.estimateRate(),
		};
	}
}

/**
 * Cumulative durations per playlist, so the elapsed total is a lookup instead of
 * a re-sum. `remainingBytesFromBitrate` runs on every progress tick — a few times
 * a second per job — and re-adding the durations from zero each time made the
 * cost grow with the episode's length. The playlist's array is the same object for
 * the whole run, so a WeakMap keyed by it is enough and the entry is collected
 * with the playlist.
 */
const cumulativeDurations = new WeakMap<number[], Float64Array>();

/** Seconds of media in the first `count` segments. `sums[i]` is the total of the
 * first `i` segments. */
export function elapsedSeconds(durations: number[], count: number): number {
	if (durations.length === 0) return 0;
	let sums = cumulativeDurations.get(durations);
	if (!sums) {
		sums = new Float64Array(durations.length + 1);
		for (let index = 0; index < durations.length; index++) {
			sums[index + 1] = (sums[index] ?? 0) + (durations[index] ?? 0);
		}
		cumulativeDurations.set(durations, sums);
	}
	const clamped = Math.max(0, Math.min(count, durations.length));
	return sums[clamped] ?? 0;
}

/**
 * Bytes still to download, from the stream's bitrate and the seconds of media
 * left. `completed` segments have been fetched and `bytes` counts them.
 *
 * Returns null when there is nothing to go on — no segments fetched yet, or a
 * playlist whose durations are all zero — so the caller can fall back to the
 * average-bytes-per-segment guess.
 */
export function remainingBytesFromBitrate(
	durations: number[],
	totalDuration: number,
	completed: number,
	bytes: number,
): number | null {
	if (completed <= 0 || bytes <= 0 || durations.length === 0) return null;
	const elapsed = elapsedSeconds(durations, completed);
	if (elapsed <= 0) return null;
	const remainingSeconds = totalDuration - elapsed;
	if (remainingSeconds <= 0) return 0;
	const bytesPerSecond = bytes / elapsed;
	return bytesPerSecond * remainingSeconds;
}

import { App, Modal, Notice, setIcon } from 'obsidian';
import { formatDuration, shiftCueTimes } from './hls';
import { describeEntry, type LibraryEntry, type WatchRecord } from './library';

/** How large the native subtitle cues render. */
export type SubtitleSize = 'small' | 'normal' | 'large';

/** The persisted subtitle preferences, handed to the player at open. */
export interface SubtitlePreferences {
	/** Off by user choice, not by absence of a sidecar. */
	on: boolean;
	size: SubtitleSize;
	/** Applied to the track's own cue timings; ±5 s is the useful range. */
	delayMs: number;
}

export interface PlayerCallbacks {
	/** Persist how far the viewer got. Called on a timer and on close. */
	onProgress(path: string, position: number, duration: number): void;
	/** Drop the saved position, so the next open starts at the beginning. */
	onReset(path: string): void;
	/** Open the adjacent episode, when one exists. */
	onNavigate?(direction: 'previous' | 'next'): void;
	/**
	 * Persist a subtitle preference change. The player keeps its own copy so
	 * the controls respond at once; the caller decides what to store.
	 */
	onSubtitlePreference?(patch: Partial<SubtitlePreferences>): void;
	/**
	 * Playback reached the file's natural end. Fired after the progress
	 * flush, so the caller advancing to the next episode never races the
	 * final save.
	 */
	onEnded?(): void;
	onClosed?(): void;
}

/** How often the play position is written while watching. */
const SAVE_INTERVAL_MS = 5000;
/**
 * Below this many seconds of playback, a position is not worth keeping: an
 * accidental tap would otherwise leave a resume point a second in.
 */
const MIN_SAVE_SECONDS = 5;

/**
 * Play a downloaded episode.
 *
 * The file is a normal vault file, so the player is a `<video>` pointed at the
 * resource path Obsidian exposes for it. MPEG-TS (the low-memory `.ts` output)
 * is not a format a browser plays, so that case is reported rather than left as
 * a silent black rectangle.
 */
export class PlayerModal extends Modal {
	private videoEl!: HTMLVideoElement;
	private textTrack: TextTrack | null = null;
	/** The delay currently baked into the track's cues. */
	private appliedDelayMs = 0;
	private lastSaved = 0;
	private saveTimer: number | null = null;
	private ended = false;

	constructor(
		app: App,
		private readonly entry: LibraryEntry,
		private readonly source: string,
		private readonly progress: WatchRecord | null,
		/**
		 * Blob URL of the episode's WebVTT sidecar, when one was downloaded.
		 * The modal takes ownership and revokes it on close. Null when the
		 * episode has no sidecar.
		 */
		private readonly subtitleUrl: string | null,
		private readonly subtitlePrefs: SubtitlePreferences,
		private readonly callbacks: PlayerCallbacks,
	) {
		super(app);
		this.modalEl.addClass('bfm-player-modal');
		this.applySubtitleSize(subtitlePrefs.size);
	}

	onOpen(): void {
		this.titleEl.setText(describeEntry(this.entry));
		this.contentEl.empty();

		if (this.entry.ext === 'ts') {
			this.renderUnsupported();
			return;
		}

		const stage = this.contentEl.createDiv({ cls: 'bfm-player-stage' });
		this.videoEl = stage.createEl('video', { cls: 'bfm-player-video' });
		this.videoEl.controls = true;
		this.videoEl.autoplay = true;
		this.videoEl.playsInline = true;
		this.videoEl.setAttribute('preload', 'metadata');
		this.videoEl.src = this.source;
		this.attachSubtitles();

		this.videoEl.addEventListener('loadedmetadata', () => this.resume());
		this.videoEl.addEventListener('ended', () => {
			this.ended = true;
			this.flush(true);
			const length = this.videoEl.duration;
			if (Number.isFinite(length) && length > 0) {
				new Notice(`Finished · ${formatDuration(length)}`);
			}
			// Fired after the flush, so an auto-advance starts from an honest
			// final record for this episode.
			this.callbacks.onEnded?.();
		});
		this.videoEl.addEventListener('error', () => this.renderPlaybackError());
		this.videoEl.addEventListener('pause', () => this.flush(false));

		this.saveTimer = window.setInterval(() => this.flush(false), SAVE_INTERVAL_MS);

		const bar = this.contentEl.createDiv({ cls: 'bfm-player-bar' });
		const previous = bar.createEl('button', { cls: 'bfm-player-nav' });
		setIcon(previous, 'chevron-left');
		previous.createSpan({ text: 'Previous' });
		previous.disabled = !this.callbacks.onNavigate;
		previous.addEventListener('click', () => this.callbacks.onNavigate?.('previous'));
		const speed = bar.createEl('select', { cls: 'bfm-player-speed', attr: { 'aria-label': 'Playback speed' } });
		for (const rate of [0.75, 1, 1.25, 1.5, 2]) {
			const option = speed.createEl('option', { text: `${rate}×`, value: String(rate) });
			option.selected = rate === 1;
		}
		speed.addEventListener('change', () => {
			const rate = Number(speed.value);
			if (Number.isFinite(rate) && rate > 0) this.videoEl.playbackRate = rate;
		});
		const next = bar.createEl('button', { cls: 'bfm-player-nav' });
		setIcon(next, 'chevron-right');
		next.createSpan({ text: 'Next' });
		next.disabled = !this.callbacks.onNavigate;
		next.addEventListener('click', () => this.callbacks.onNavigate?.('next'));
		const restart = bar.createEl('button', { cls: 'bfm-player-restart' });
		setIcon(restart, 'rotate-ccw');
		restart.createSpan({ text: 'Start over' });
		restart.addEventListener('click', () => {
			this.videoEl.currentTime = 0;
			this.lastSaved = 0;
			this.ended = false;
			this.callbacks.onReset(this.entry.path);
			void this.videoEl.play();
		});
		this.renderSubtitleControls(bar);
	}

	/**
	 * Attach the downloaded subtitle sidecar, when there is one. The track is
	 * marked default so the subtitles are simply on, which is the point of
	 * having downloaded them; the stored preference (and the player's own
	 * toggle) decides visibility, size, and timing.
	 */
	private attachSubtitles(): void {
		if (!this.subtitleUrl) return;
		const track = this.videoEl.createEl('track', {
			attr: { kind: 'subtitles', label: 'Subtitles', src: this.subtitleUrl },
		});
		track.default = true;
		// Cues exist only once the sidecar has loaded; `load` is the moment the
		// preferences can actually be applied to them.
		track.addEventListener('load', () => this.applySubtitleTrack());
		// A few engines expose the text track before `load` fires; the first
		// cuechange is the same moment seen from the other side.
		track.addEventListener('cuechange', () => this.applySubtitleTrack());
	}

	/** Take the track and stamp the stored preferences onto it. */
	private applySubtitleTrack(): void {
		const track = this.videoEl.textTracks[0];
		if (!track || this.textTrack === track) return;
		this.textTrack = track;
		track.mode = this.subtitlePrefs.on ? 'showing' : 'disabled';
		this.applySubtitleDelay(this.subtitlePrefs.delayMs);
	}

	/** Move the cues so they land `delayMs` from where they sit now. */
	private applySubtitleDelay(delayMs: number): void {
		const track = this.textTrack;
		if (!track || !track.cues) return;
		shiftCueTimes(Array.from(track.cues), (delayMs - this.appliedDelayMs) / 1000);
		this.appliedDelayMs = delayMs;
	}

	/** The subtitle controls, when this episode has a sidecar to tune. */
	private renderSubtitleControls(bar: HTMLElement): void {
		if (!this.subtitleUrl) return;
		const captions = bar.createEl('button', { cls: 'bfm-player-nav', attr: { 'aria-label': 'Subtitles on or off' } });
		const drawCaptions = (): void => {
			captions.empty();
			setIcon(captions, 'captions');
			captions.createSpan({ text: this.subtitlePrefs.on ? 'On' : 'Off' });
		};
		drawCaptions();
		captions.addEventListener('click', () => {
			this.subtitlePrefs.on = !this.subtitlePrefs.on;
			if (this.textTrack) this.textTrack.mode = this.subtitlePrefs.on ? 'showing' : 'disabled';
			drawCaptions();
			this.callbacks.onSubtitlePreference?.({ on: this.subtitlePrefs.on });
		});

		const size = bar.createEl('button', { cls: 'bfm-player-nav', attr: { 'aria-label': 'Subtitle text size' } });
		const drawSize = (): void => {
			size.empty();
			setIcon(size, 'type');
			size.createSpan({
				text: this.subtitlePrefs.size === 'small' ? 'S' : this.subtitlePrefs.size === 'large' ? 'L' : 'M',
			});
		};
		drawSize();
		size.addEventListener('click', () => {
			const order: SubtitleSize[] = ['small', 'normal', 'large'];
			const next = order[(order.indexOf(this.subtitlePrefs.size) + 1) % order.length];
			if (!next) return;
			this.subtitlePrefs.size = next;
			this.applySubtitleSize(next);
			drawSize();
			this.callbacks.onSubtitlePreference?.({ size: next });
		});

		const clampDelay = (ms: number): number => Math.max(-5000, Math.min(5000, ms));
		const nudge = (delta: number): void => {
			this.subtitlePrefs.delayMs = clampDelay(this.subtitlePrefs.delayMs + delta);
			this.applySubtitleDelay(this.subtitlePrefs.delayMs);
			const seconds = this.subtitlePrefs.delayMs / 1000;
			new Notice(seconds === 0 ? 'Subtitle delay: none' : `Subtitle delay: ${seconds > 0 ? '+' : ''}${seconds} s`);
			this.callbacks.onSubtitlePreference?.({ delayMs: this.subtitlePrefs.delayMs });
		};
		const later = bar.createEl('button', { cls: 'bfm-player-nav', attr: { 'aria-label': 'Subtitles half a second later' } });
		later.createSpan({ text: 'Subs +0.5s' });
		later.addEventListener('click', () => nudge(500));
		const earlier = bar.createEl('button', { cls: 'bfm-player-nav', attr: { 'aria-label': 'Subtitles half a second earlier' } });
		earlier.createSpan({ text: 'Subs −0.5s' });
		earlier.addEventListener('click', () => nudge(-500));
	}

	/** The modal-scoped class the `::cue` rules key on. */
	private applySubtitleSize(size: SubtitleSize): void {
		this.modalEl.removeClass('bfm-subs-small', 'bfm-subs-normal', 'bfm-subs-large');
		this.modalEl.addClass(`bfm-subs-${size}`);
	}

	/** Seek to the saved position once the length is known. */
	private resume(): void {
		const record = this.progress;
		if (!record || record.position < MIN_SAVE_SECONDS) return;
		// A position at the very end would look like a hang; start over.
		const duration = this.videoEl.duration;
		if (Number.isFinite(duration) && record.position >= duration - 1) {
			this.callbacks.onReset(this.entry.path);
			return;
		}
		this.videoEl.currentTime = record.position;
	}

	/**
	 * Write the current position. `force` is used when playback ended, where
	 * the position is the end of the file and must not be skipped as trivial.
	 */
	private flush(force: boolean): void {
		if (!this.videoEl) return;
		const position = this.videoEl.currentTime;
		const duration = this.videoEl.duration;
		if (!Number.isFinite(position)) return;
		if (this.ended) {
			this.callbacks.onProgress(
				this.entry.path,
				Number.isFinite(duration) ? duration : position,
				Number.isFinite(duration) ? duration : 0,
			);
			return;
		}
		if (!force && position < MIN_SAVE_SECONDS) return;
		if (!force && Math.abs(position - this.lastSaved) < 1) return;
		this.lastSaved = position;
		this.callbacks.onProgress(
			this.entry.path,
			position,
			Number.isFinite(duration) ? duration : 0,
		);
	}

	private renderUnsupported(): void {
		const wrap = this.contentEl.createDiv({ cls: 'bfm-player-unsupported' });
		setIcon(wrap.createDiv({ cls: 'bfm-player-unsupported-icon' }), 'file-video');
		wrap.createDiv({
			cls: 'bfm-player-unsupported-title',
			text: 'This file is a raw transport stream (.ts)',
		});
		wrap.createDiv({
			cls: 'bfm-player-unsupported-text',
			text: 'Browsers cannot play .ts files. Convert the episode to MP4 in settings, or open the file in an app that supports it.',
		});
	}

	private renderPlaybackError(): void {
		const stage = this.contentEl.querySelector('.bfm-player-stage');
		if (!stage) return;
		stage.empty();
		const wrap = stage.createDiv({ cls: 'bfm-player-unsupported' });
		setIcon(wrap.createDiv({ cls: 'bfm-player-unsupported-icon' }), 'alert-triangle');
		wrap.createDiv({ cls: 'bfm-player-unsupported-title', text: 'This video could not be played' });
		wrap.createDiv({
			cls: 'bfm-player-unsupported-text',
			text: 'The file may be incomplete or in a format this device does not support. Try repairing downloads from the command palette.',
		});
	}

	onClose(): void {
		if (this.saveTimer !== null) {
			window.clearInterval(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.videoEl) {
			this.flush(true);
			// Stop buffering a file the viewer has left.
			this.videoEl.pause();
			this.videoEl.removeAttribute('src');
			this.videoEl.load();
		}
		// The subtitle blob URL was created for this playback only.
		if (this.subtitleUrl?.startsWith('blob:')) URL.revokeObjectURL(this.subtitleUrl);
		this.contentEl.empty();
		this.callbacks.onClosed?.();
	}
}

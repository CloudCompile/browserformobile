import { App, Modal, Notice, setIcon } from 'obsidian';
import { formatDuration } from './hls';
import { describeEntry, type LibraryEntry, type WatchRecord } from './library';

export interface PlayerCallbacks {
	/** Persist how far the viewer got. Called on a timer and on close. */
	onProgress(path: string, position: number, duration: number): void;
	/** Drop the saved position, so the next open starts at the beginning. */
	onReset(path: string): void;
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
	private lastSaved = 0;
	private saveTimer: number | null = null;
	private ended = false;

	constructor(
		app: App,
		private readonly entry: LibraryEntry,
		private readonly source: string,
		private readonly progress: WatchRecord | null,
		private readonly callbacks: PlayerCallbacks,
	) {
		super(app);
		this.modalEl.addClass('bfm-player-modal');
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

		this.videoEl.addEventListener('loadedmetadata', () => this.resume());
		this.videoEl.addEventListener('ended', () => {
			this.ended = true;
			this.flush(true);
			const length = this.videoEl.duration;
			if (Number.isFinite(length) && length > 0) {
				new Notice(`Finished · ${formatDuration(length)}`);
			}
		});
		this.videoEl.addEventListener('error', () => this.renderPlaybackError());
		this.videoEl.addEventListener('pause', () => this.flush(false));

		this.saveTimer = window.setInterval(() => this.flush(false), SAVE_INTERVAL_MS);

		const bar = this.contentEl.createDiv({ cls: 'bfm-player-bar' });
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
		this.contentEl.empty();
		this.callbacks.onClosed?.();
	}
}

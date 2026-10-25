import { App, Modal, Notice, setIcon } from 'obsidian';
import {
	describeEntry,
	describeEntryMeta,
	watchFraction,
	type LibraryItem,
	type VideoLibrary,
} from './library';
import { ConfirmModal } from './modals';

export interface LibraryCallbacks {
	/** Play an item, resuming from its saved position. */
	onPlay(item: LibraryItem): void;
	/** Delete the file behind an item and forget its progress. */
	onDelete(item: LibraryItem): Promise<void>;
	/** Re-scan the folder; the modal re-renders when it resolves. */
	onRefresh(): Promise<unknown>;
	/** Show the full details page for a series. */
	onDetails?(series: string): void;
	onClosed?(): void;
	/** Shown in place of the empty state, e.g. when files live outside the vault. */
	emptyHint?: string;
}

type Filter = 'all' | 'unwatched' | 'in-progress';

/**
 * Browse the downloaded episodes.
 *
 * The list is a scan of the download folder, so it needs no index to stay
 * correct when files are added outside the plugin. Search covers the series,
 * episode number, and title, and the filter narrows to what is not finished.
 */
export class LibraryModal extends Modal {
	private query = '';
	private filter: Filter = 'all';
	private busy = false;
	private bodyEl!: HTMLElement;

	constructor(
		app: App,
		private readonly library: VideoLibrary,
		private readonly callbacks: LibraryCallbacks,
	) {
		super(app);
		this.modalEl.addClass('bfm-library-modal');
	}

	onOpen(): void {
		this.titleEl.setText('Video library');
		this.contentEl.empty();
		this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-library-body' });
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		this.callbacks.onClosed?.();
	}

	/** Re-scan, then re-render. Used after a delete and on open. */
	async refresh(): Promise<void> {
		await this.callbacks.onRefresh();
		this.render();
	}

	private matches(item: LibraryItem): boolean {
		if (this.filter === 'unwatched' && item.watched) return false;
		if (this.filter === 'in-progress' && (!item.progress || item.watched)) return false;
		const needle = this.query.trim().toLowerCase();
		if (!needle) return true;
		const haystack = `${item.series} ${item.title} ${item.name} ${item.episode}`.toLowerCase();
		return haystack.includes(needle);
	}

	private render(): void {
		this.bodyEl.empty();
		const items = this.library.items();
		const visible = items.filter((item) => this.matches(item));

		const bar = this.bodyEl.createDiv({ cls: 'bfm-library-bar' });
		const search = bar.createEl('input', {
			cls: 'bfm-library-search',
			attr: { type: 'search', placeholder: 'Search videos' },
		});
		search.value = this.query;
		search.addEventListener('input', () => {
			this.query = search.value;
			this.renderList(this.library.items().filter((item) => this.matches(item)));
		});

		const filters = bar.createDiv({ cls: 'bfm-library-filters' });
		const choices: { value: Filter; label: string }[] = [
			{ value: 'all', label: 'All' },
			{ value: 'unwatched', label: 'Unwatched' },
			{ value: 'in-progress', label: 'In progress' },
		];
		for (const choice of choices) {
			const button = filters.createEl('button', {
				cls: 'bfm-library-filter',
				text: choice.label,
			});
			button.toggleClass('is-active', this.filter === choice.value);
			button.addEventListener('click', () => {
				this.filter = choice.value;
				this.render();
			});
		}

		this.renderList(visible);
	}

	private renderList(items: LibraryItem[]): void {
		let list = this.bodyEl.querySelector('.bfm-library-list');
		if (!list) {
			list = this.bodyEl.createDiv({ cls: 'bfm-library-list' });
		} else {
			list.empty();
		}
		if (items.length === 0) {
			const empty = list.createDiv({ cls: 'bfm-library-empty' });
			setIcon(empty.createDiv({ cls: 'bfm-library-empty-icon' }), 'film');
			empty.createDiv({
				cls: 'bfm-library-empty-text',
				text: this.library.entries.length === 0
					? (this.callbacks.emptyHint || 'No downloaded videos yet. Download an episode to see it here.')
					: 'Nothing matches this search.',
			});
			return;
		}

		for (const item of items) {
			const row = list.createDiv({ cls: 'bfm-library-item' });
			if (item.watched) row.addClass('is-watched');

			const main = row.createDiv({ cls: 'bfm-library-item-main' });
			main.createDiv({ cls: 'bfm-library-item-title', text: describeEntry(item) });
			main.createDiv({ cls: 'bfm-library-item-meta', text: describeEntryMeta(item) });

			const fraction = watchFraction(item);
			if (fraction > 0) {
				const track = main.createDiv({ cls: 'bfm-library-progress' });
				track.createDiv({ cls: 'bfm-library-progress-fill' }).setCssProps({
					width: `${Math.round(fraction * 100)}%`,
				});
			}

			let infoButton: HTMLElement | null = null;
			if (this.callbacks.onDetails && item.series) {
				infoButton = row.createEl('button', { cls: 'bfm-library-item-info' });
				setIcon(infoButton, 'info');
				infoButton.setAttribute('aria-label', `Details for ${item.series}`);
				infoButton.addEventListener('click', () => this.callbacks.onDetails?.(item.series));
			}

			const play = row.createEl('button', { cls: 'bfm-library-item-play' });
			setIcon(play, 'play');
			play.setAttribute('aria-label', `Play ${describeEntry(item)}`);
			play.addEventListener('click', () => this.callbacks.onPlay(item));

			const remove = row.createEl('button', { cls: 'bfm-library-item-delete' });
			setIcon(remove, 'trash-2');
			remove.setAttribute('aria-label', `Delete ${item.name}`);
			remove.addEventListener('click', () => this.confirmDelete(item));

			row.addEventListener('click', (event) => {
				if (event.target === play || play.contains(event.target as Node)) return;
				if (event.target === remove || remove.contains(event.target as Node)) return;
				if (infoButton && (event.target === infoButton || infoButton.contains(event.target as Node))) return;
				this.callbacks.onPlay(item);
			});
		}
	}

	private confirmDelete(item: LibraryItem): void {
		if (this.busy) return;
		const run = async (): Promise<void> => {
			this.busy = true;
			try {
				await this.callbacks.onDelete(item);
				await this.refresh();
				new Notice(`Deleted ${item.name}`);
			} catch (error) {
				new Notice(
					error instanceof Error ? error.message : 'The file could not be deleted.',
				);
			} finally {
				this.busy = false;
			}
		};
		new ConfirmModal(
			this.app,
			`Delete ${item.name}? The file is removed from your vault. This cannot be undone.`,
			() => void run(),
		).open();
	}
}

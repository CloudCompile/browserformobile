import { App, Modal, Notice, setIcon } from 'obsidian';
import { formatDuration } from './hls';
import {
	describeEntry,
	describeEntryMeta,
	watchFraction,
	inferSeason,
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
	/**
	 * Poster URLs by lowercased series name, mined from the cached catalogue.
	 * Only consulted in grid mode; a series with no entry gets a fallback card.
	 */
	posters?(): Map<string, string>;
	/** The view mode saved from the last session. */
	initialView?: 'list' | 'grid';
	/** Persist the view mode when the user toggles it. */
	onViewChange?(view: 'list' | 'grid'): void;
	onClosed?(): void;
	/** Shown in place of the empty state, e.g. when files live outside the vault. */
	emptyHint?: string;
}

type Filter = 'all' | 'unwatched' | 'in-progress';
type Sort = 'added' | 'title' | 'episode';
type View = 'list' | 'grid';

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
	private sort: Sort = 'added';
	private view: View;
	private busy = false;
	private bodyEl!: HTMLElement;

	constructor(
		app: App,
		private readonly library: VideoLibrary,
		private readonly callbacks: LibraryCallbacks,
	) {
		super(app);
		this.view = callbacks.initialView ?? 'list';
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
			const visible = this.sorted(this.library.items().filter((item) => this.matches(item)));
			if (this.view === 'grid') this.renderGrid(visible);
			else this.renderList(visible);
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

		const sort = bar.createEl('select', { cls: 'bfm-library-sort', attr: { 'aria-label': 'Sort videos' } });
		const sorts: { value: Sort; label: string }[] = [
			{ value: 'added', label: 'Recently added' },
			{ value: 'title', label: 'Title' },
			{ value: 'episode', label: 'Episode' },
		];
		for (const choice of sorts) {
			const option = sort.createEl('option', { text: choice.label, value: choice.value });
			option.selected = choice.value === this.sort;
		}
		sort.addEventListener('change', () => {
			this.sort = sort.value as Sort;
			this.render();
		});

		const views = bar.createDiv({ cls: 'bfm-library-views' });
		const listButton = views.createEl('button', { cls: 'bfm-library-view' });
		setIcon(listButton, 'list');
		listButton.setAttribute('aria-label', 'List view');
		listButton.toggleClass('is-active', this.view === 'list');
		listButton.addEventListener('click', () => this.setView('list'));
		const gridButton = views.createEl('button', { cls: 'bfm-library-view' });
		setIcon(gridButton, 'layout-grid');
		gridButton.setAttribute('aria-label', 'Grid view');
		gridButton.toggleClass('is-active', this.view === 'grid');
		gridButton.addEventListener('click', () => this.setView('grid'));

		this.renderContinue();
		const ordered = this.sorted(visible);
		if (this.view === 'grid') this.renderGrid(ordered);
		else this.renderList(ordered);
	}

	/** Switch the layout and remember the choice for the next open. */
	private setView(view: View): void {
		if (this.view === view) return;
		this.view = view;
		this.callbacks.onViewChange?.(view);
		this.render();
	}

	/**
	 * The horizontal strip of half-watched episodes, most recently played first.
	 *
	 * It reads the whole library rather than the filtered list: it is a shortcut
	 * back to what the viewer was last doing, and a search that happens to match
	 * nothing should not hide it.
	 */
	private renderContinue(): void {
		const entries = this.library
			.items()
			.filter((item) => item.progress && !item.watched)
			.sort((a, b) => (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0));
		if (entries.length === 0) return;

		const host = this.bodyEl.createDiv({ cls: 'bfm-library-continue' });
		host.createDiv({ cls: 'bfm-library-continue-heading', text: 'Continue watching' });
		const row = host.createDiv({ cls: 'bfm-library-continue-row' });
		for (const item of entries) {
			const record = item.progress;
			const card = row.createDiv({ cls: 'bfm-library-continue-card' });
			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			card.setAttribute('aria-label', `Resume ${describeEntry(item)}`);
			card.createDiv({ cls: 'bfm-library-continue-series', text: item.series || item.name });
			const badge = record ? `Resume at ${formatDuration(record.position)}` : '';
			const remaining =
				record && record.duration > record.position
					? `${formatDuration(record.duration - record.position)} left`
					: '';
			card.createDiv({
				cls: 'bfm-library-continue-meta',
				text: [badge, remaining].filter(Boolean).join(' · '),
			});
			const fraction = watchFraction(item);
			if (fraction > 0) {
				const track = card.createDiv({ cls: 'bfm-library-progress' });
				track.createDiv({ cls: 'bfm-library-progress-fill' }).setCssProps({
					width: `${Math.round(fraction * 100)}%`,
				});
			}
			const play = () => this.callbacks.onPlay(item);
			card.addEventListener('click', play);
			card.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					play();
				}
			});
		}
	}

	private sorted(items: LibraryItem[]): LibraryItem[] {
		return [...items].sort((a, b) => {
			if (this.sort === 'title') return `${a.series} ${a.title}`.localeCompare(`${b.series} ${b.title}`);
			if (this.sort === 'episode') return a.episode - b.episode || a.series.localeCompare(b.series);
			return 0;
		});
	}

	private renderList(items: LibraryItem[]): void {
		let list = this.bodyEl.querySelector<HTMLElement>('.bfm-library-list');
		if (!list) list = this.bodyEl.createDiv({ cls: 'bfm-library-list' });
		else list.empty();
		if (items.length === 0) {
			this.renderEmptyInto(list);
			return;
		}

		for (const item of items) {
			const row = list.createDiv({ cls: 'bfm-library-item' });
			if (item.watched) row.addClass('is-watched');

			const preview = row.createDiv({ cls: 'bfm-library-item-preview' });
			const season = inferSeason(`${item.series} ${item.name}`);
			preview.createDiv({
				cls: 'bfm-library-item-episode-badge',
				text: season ? `S${season} E${item.episode || '?'}` : `E${item.episode || '?'}`,
			});
			preview.createDiv({ cls: 'bfm-library-item-preview-label', text: 'Episode' });

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

	/**
	 * The poster grid.
	 *
	 * Posters come from the cached catalogue (`posters()` callback) — no network
	 * request is made for the grid, so a series the plugin never fetched simply
	 * gets a fallback card with the series' first letter. Cards reuse the list's
	 * behaviours: tap to play, with details and delete kept as small overlays so
	 * the grid stays one-tap-deep like the list.
	 */
	private renderGrid(items: LibraryItem[]): void {
		let grid = this.bodyEl.querySelector<HTMLElement>('.bfm-library-grid');
		if (!grid) grid = this.bodyEl.createDiv({ cls: 'bfm-library-grid' });
		else grid.empty();
		if (items.length === 0) {
			this.renderEmptyInto(grid);
			return;
		}
		const posters = this.callbacks.posters?.() ?? new Map<string, string>();

		for (const item of items) {
			const card = grid.createDiv({ cls: 'bfm-library-card' });
			if (item.watched) card.addClass('is-watched');

			const poster = card.createDiv({ cls: 'bfm-library-card-poster' });
			const url = item.series ? posters.get(item.series.toLowerCase()) : undefined;
			if (url) {
				poster.createEl('img', {
					cls: 'bfm-library-card-poster-image',
					attr: { src: url, alt: '', loading: 'lazy' },
				});
			} else {
				poster.createDiv({
					cls: 'bfm-library-card-poster-placeholder',
					text: (item.series || item.name).charAt(0).toUpperCase() || '?',
				});
			}
			const season = inferSeason(`${item.series} ${item.name}`);
			poster.createDiv({
				cls: 'bfm-library-card-badge',
				text: season ? `S${season} E${item.episode || '?'}` : `E${item.episode || '?'}`,
			});
			const fraction = watchFraction(item);
			if (fraction > 0) {
				const track = poster.createDiv({ cls: 'bfm-library-progress' });
				track.createDiv({ cls: 'bfm-library-progress-fill' }).setCssProps({
					width: `${Math.round(fraction * 100)}%`,
				});
			}

			const body = card.createDiv({ cls: 'bfm-library-card-body' });
			body.createDiv({ cls: 'bfm-library-card-title', text: item.series || item.name });
			const meta = item.title && item.series ? item.title : describeEntryMeta(item);
			body.createDiv({ cls: 'bfm-library-card-meta', text: meta });

			if (this.callbacks.onDetails && item.series) {
				const info = card.createEl('button', { cls: 'bfm-library-card-info' });
				setIcon(info, 'info');
				info.setAttribute('aria-label', `Details for ${item.series}`);
				info.addEventListener('click', (event) => {
					event.stopPropagation();
					this.callbacks.onDetails?.(item.series);
				});
			}
			const remove = card.createEl('button', { cls: 'bfm-library-card-delete' });
			setIcon(remove, 'trash-2');
			remove.setAttribute('aria-label', `Delete ${item.name}`);
			remove.addEventListener('click', (event) => {
				event.stopPropagation();
				this.confirmDelete(item);
			});

			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			card.setAttribute('aria-label', `Play ${describeEntry(item)}`);
			card.addEventListener('click', () => this.callbacks.onPlay(item));
			card.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				this.callbacks.onPlay(item);
			});
		}
	}

	/** The shared "nothing here" panel used by both views. */
	private renderEmptyInto(host: Element): void {
		const empty = host.createDiv({ cls: 'bfm-library-empty' });
		setIcon(empty.createDiv({ cls: 'bfm-library-empty-icon' }), 'film');
		empty.createDiv({
			cls: 'bfm-library-empty-text',
			text:
				this.library.entries.length === 0
					? this.callbacks.emptyHint || 'No downloaded videos yet. Download an episode to see it here.'
					: 'Nothing matches this search.',
		});
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

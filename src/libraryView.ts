import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import { formatDuration } from './hls';
import { type LibraryItem, type VideoLibrary } from './library';
import {
	groupMatches,
	groupPercent,
	sortGroups,
	type EpisodeItem,
	type SeriesGroup,
} from './libraryGroups';
import { ConfirmModal } from './modals';
import type AnimePlugin from './main';

export const VIEW_TYPE_LIBRARY = 'browser-for-mobile-library';

type Sort = 'recent' | 'title' | 'episodes';

const SORT_OPTIONS: readonly { value: Sort; label: string }[] = [
	{ value: 'recent', label: 'Recently added' },
	{ value: 'title', label: 'Title' },
	{ value: 'episodes', label: 'Most episodes' },
];

/**
 * A stable hue per title. A library with no artwork would otherwise be a grid
 * of identical grey rectangles; the tint gives each series a face.
 */
function titleHue(title: string): number {
	let hash = 0;
	for (let i = 0; i < title.length; i += 1) hash = (hash * 31 + title.charCodeAt(i)) % 360;
	return hash;
}

/** Up to two initials, so the placeholder reads as a poster, not a monogram. */
function initials(title: string): string {
	const words = title.trim().split(/\s+/).filter(Boolean);
	return `${words[0]?.charAt(0) ?? '?'}${words[1]?.charAt(0) ?? ''}`.toUpperCase();
}

/** A season tab inside a series page. */
type SeasonTab = 'all' | number;

/** How far through an episode the viewer got, 0–1. */
function fraction(item: LibraryItem): number {
	const record = item.progress;
	if (!record || record.duration <= 0) return 0;
	return Math.max(0, Math.min(1, record.position / record.duration));
}

function percentOf(fractionValue: number): string {
	return `${Math.round(Math.max(0, Math.min(1, fractionValue)) * 100)}%`;
}

/**
 * The video library, as a workspace view.
 *
 * The old library was a modal that listed every file flat, newest first — which
 * is a file manager, not a collection. This is a view with three levels: a
 * continue-watching shelf, one card per series, and a series page with its
 * seasons and episodes. Everything is drawn from the existing scan and watch
 * records; the grouping is pure (`libraryGroups.ts`) and tested without a
 * vault.
 */
export class LibraryView extends ItemView {
	private query = '';
	private sort: Sort = 'recent';
	private openKey: string | null = null;
	private season: SeasonTab = 'all';
	private busy = false;
	private headEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private scrollTo: string | null = null;
	private searchTimer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: AnimePlugin,
	) {
		super(leaf);
		this.navigation = false;
	}

	override getViewType(): string {
		return VIEW_TYPE_LIBRARY;
	}

	override getDisplayText(): string {
		return 'Video library';
	}

	override getIcon(): string {
		return 'film';
	}

	override async onOpen(): Promise<void> {
		this.contentEl.addClass('bfm-library-view');
		this.contentEl.empty();
		this.headEl = this.contentEl.createDiv({ cls: 'bfm-library-head' });
		this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-library-body' });
		this.render();
		// A scan on every open keeps files added outside the plugin visible;
		// the first paint uses whatever the last scan found.
		void this.refresh();
		// Files can land in the folder at any time — a download finishing, a
		// sync from another device — so the view follows the folder instead of
		// asking the user to reopen it.
		this.registerEvent(this.app.vault.on('create', () => this.scheduleRefresh()));
		this.registerEvent(this.app.vault.on('delete', () => this.scheduleRefresh()));
		this.registerEvent(this.app.vault.on('rename', () => this.scheduleRefresh()));
	}

	override async onClose(): Promise<void> {
		if (this.searchTimer !== null) {
			window.clearTimeout(this.searchTimer);
			this.searchTimer = null;
		}
		this.contentEl.empty();
	}

	private refreshTimer: number | null = null;

	/** Coalesce a burst of vault events (a sync writes many files) into one scan. */
	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 1200);
	}

	/** Re-scan, then repaint. Safe to call when the view is already open. */
	async refresh(): Promise<void> {
		try {
			await this.plugin.refreshLibrary();
			this.plugin.library.prune();
		} catch (error) {
			new Notice(error instanceof Error ? error.message : 'The download folder could not be read.');
		}
		this.render();
	}

	private posters(): Map<string, string> {
		return this.plugin.libraryPosters();
	}

	private openGroup(): SeriesGroup | null {
		if (!this.openKey) return null;
		const group = this.plugin.libraryGroup(this.openKey, this.plugin.settings.downloadFilenameTemplate);
		return group ?? null;
	}

	private render(): void {
		if (!this.bodyEl) return;
		this.headEl.empty();
		this.bodyEl.empty();
		const group = this.openGroup();
		if (group) this.renderSeries(group);
		else this.renderShelves();
	}

	// ---------------------------------------------------------------- shelves

	private renderShelves(): void {
		this.renderToolbar();
		this.renderShelfContent();
	}

	/** Search, sort and the one action that puts something new in the library. */
	private renderToolbar(): void {
		const bar = this.headEl.createDiv({ cls: 'bfm-library-bar' });
		const wrap = bar.createDiv({ cls: 'bfm-library-search-wrap' });
		const search = wrap.createEl('input', {
			cls: 'bfm-library-search',
			attr: {
				type: 'search',
				placeholder: 'Search series and episodes',
				'aria-label': 'Search series and episodes',
			},
		});
		search.value = this.query;
		const clear = wrap.createEl('button', {
			cls: 'bfm-library-search-clear',
			attr: { 'aria-label': 'Clear search' },
		});
		setIcon(clear, 'x');
		clear.toggleClass('is-hidden', !this.query);
		clear.addEventListener('click', () => {
			this.query = '';
			search.value = '';
			clear.addClass('is-hidden');
			this.renderShelfContent();
			search.focus();
		});
		search.addEventListener('input', () => {
			this.query = search.value;
			clear.toggleClass('is-hidden', !this.query);
			// Repaint the results only. Rebuilding this bar on every keystroke stole
			// the caret and made fast typing feel like it was fighting the field.
			if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
			this.searchTimer = window.setTimeout(() => {
				this.searchTimer = null;
				if (!this.openKey) this.renderShelfContent();
			}, 140);
		});

		const tools = bar.createDiv({ cls: 'bfm-library-tools' });
		const sortButton = tools.createEl('button', {
			cls: 'bfm-library-sort',
			attr: { 'aria-label': 'Sort series' },
		});
		setIcon(sortButton, 'arrow-up-down');
		sortButton.createSpan({
			text: SORT_OPTIONS.find((choice) => choice.value === this.sort)?.label ?? 'Recently added',
		});
		setIcon(sortButton.createSpan({ cls: 'bfm-library-sort-chevron' }), 'chevron-down');
		sortButton.addEventListener('click', (event) => {
			const menu = new Menu();
			for (const choice of SORT_OPTIONS) {
				menu.addItem((item) => {
					item.setTitle(choice.label);
					item.setIcon(this.sort === choice.value ? 'check' : 'list');
					item.onClick(() => {
						this.sort = choice.value;
						this.render();
					});
				});
			}
			menu.showAtMouseEvent(event);
		});

		const add = tools.createEl('button', {
			cls: 'bfm-library-add',
			attr: { 'aria-label': 'Find anime to download', title: 'Find anime' },
		});
		setIcon(add, 'plus');
		add.addEventListener('click', () => this.plugin.openFind());
	}

	private renderShelfContent(): void {
		this.bodyEl.empty();
		const library: VideoLibrary = this.plugin.library;
		const groups = sortGroups(
			library.entries.length > 0
				? this.plugin.libraryGroups().filter((entry) => groupMatches(entry, this.query))
				: [],
			this.sort,
		);
		const all = this.plugin.libraryGroups();
		if (all.length === 0) {
			this.renderEmpty();
			return;
		}
		if (!this.query.trim()) this.renderContinueShelf(all);
		this.renderSeriesGrid(groups);
	}

	/** Resume cards, most recently played first. */
	private renderContinueShelf(groups: SeriesGroup[]): void {
		const cards = groups
			.flatMap((group) => group.episodes.map((entry) => ({ group, entry })))
			.filter(({ entry }) => !entry.item.watched && fraction(entry.item) > 0.01)
			.sort((a, b) => (b.entry.item.progress?.updatedAt ?? 0) - (a.entry.item.progress?.updatedAt ?? 0))
			.slice(0, 8);
		if (cards.length === 0) return;
		const shelf = this.bodyEl.createDiv({ cls: 'bfm-library-shelf' });
		shelf.createDiv({ cls: 'bfm-library-shelf-title', text: 'Continue watching' });
		const row = shelf.createDiv({ cls: 'bfm-library-shelf-row' });
		for (const { group, entry } of cards) {
			const item = entry.item;
			const card = row.createDiv({ cls: 'bfm-library-continue-card' });
			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			const label = `${group.title}${item.episode > 0 ? ` · Episode ${item.episode}` : ''}`;
			card.setAttribute('aria-label', `Resume ${label}`);
			card.createDiv({ cls: 'bfm-library-continue-series', text: group.title });
			const position = item.progress?.position ?? 0;
			const length = item.progress?.duration ?? 0;
			const left = length > position ? `${formatDuration(length - position)} left` : '';
			card.createDiv({
				cls: 'bfm-library-continue-meta',
				text: [item.episode > 0 ? `Episode ${item.episode}` : '', left].filter(Boolean).join(' · '),
			});
			const track = card.createDiv({ cls: 'bfm-library-progress' });
			track.createDiv({ cls: 'bfm-library-progress-fill' }).setCssProps({ width: percentOf(fraction(item)) });
			const play = (): void => void this.play(item);
			card.addEventListener('click', play);
			card.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				play();
			});
		}
	}

	/** One card per series. */
	private renderSeriesGrid(groups: SeriesGroup[]): void {
		const grid = this.bodyEl.createDiv({ cls: 'bfm-library-grid' });
		if (groups.length === 0) {
			grid.createDiv({ cls: 'bfm-library-empty-text', text: 'Nothing matches this search.' });
			return;
		}
		const posters = this.posters();
		for (const group of groups) {
			const card = grid.createDiv({ cls: 'bfm-library-card' });
			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			card.setAttribute('aria-label', `Open ${group.title}`);
			if (group.progress >= 1) card.addClass('is-watched');

			const poster = card.createDiv({ cls: 'bfm-library-card-poster' });
			const url = posters.get(group.key);
			if (url) {
				poster.createEl('img', { cls: 'bfm-library-card-poster-image', attr: { src: url, alt: '', loading: 'lazy' } });
			} else {
				poster.addClass('is-placeholder');
				poster.style.setProperty('--bfm-poster-hue', String(titleHue(group.title)));
				poster.createDiv({
					cls: 'bfm-library-card-poster-placeholder',
					text: initials(group.title),
				});
			}
			const count = group.episodes.length;
			poster.createDiv({
				cls: 'bfm-library-card-badge',
				text: count === 1 ? '1 episode' : `${count} episodes`,
			});
			if (group.progress > 0) {
				const track = poster.createDiv({ cls: 'bfm-library-progress' });
				track.createDiv({ cls: 'bfm-library-progress-fill' }).setCssProps({ width: percentOf(group.progress) });
			}

			const body = card.createDiv({ cls: 'bfm-library-card-body' });
			body.createDiv({ cls: 'bfm-library-card-title', text: group.title });
			const meta: string[] = [];
			if (group.watched > 0) meta.push(`${group.watched}/${count} watched`);
			if (group.seasons.length > 1) meta.push(`${group.seasons.length} seasons`);
			body.createDiv({ cls: 'bfm-library-card-meta', text: meta.join(' · ') || 'Not started' });

			const open = (): void => {
				this.openKey = group.key;
				this.season = 'all';
				this.render();
				this.contentEl.scrollTo?.({ top: 0 });
			};
			card.addEventListener('click', open);
			card.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				open();
			});
		}
	}

	// ----------------------------------------------------------------- series

	private renderSeries(group: SeriesGroup): void {
		const back = this.headEl.createEl('button', { cls: 'bfm-library-back' });
		setIcon(back, 'chevron-left');
		back.createSpan({ text: 'Library' });
		back.setAttribute('aria-label', 'Back to the library');
		back.addEventListener('click', () => {
			this.openKey = null;
			this.season = 'all';
			this.render();
		});

		const hero = this.bodyEl.createDiv({ cls: 'bfm-library-hero' });
		const posters = this.posters();
		const url = posters.get(group.key);
		const art = hero.createDiv({ cls: 'bfm-library-hero-art' });
		if (url) art.createEl('img', { attr: { src: url, alt: '', loading: 'lazy' } });

		const info = hero.createDiv({ cls: 'bfm-library-hero-info' });
		info.createEl('h2', { text: group.title });
		const total = group.episodes.length;
		const parts = [`${total === 1 ? '1 episode' : `${total} episodes`}`];
		if (group.watched > 0) parts.push(`${group.watched} watched`);
		if (group.seasons.length > 1) parts.push(`${group.seasons.length} seasons`);
		info.createDiv({ cls: 'bfm-library-hero-meta', text: parts.join(' · ') });
		const progress = info.createDiv({ cls: 'bfm-library-progress' });
		progress.createDiv({ cls: 'bfm-library-progress-fill' }).setCssProps({ width: percentOf(group.progress) });
		info.createDiv({ cls: 'bfm-library-hero-percent', text: `${groupPercent(group)}% watched` });

		const actions = info.createDiv({ cls: 'bfm-library-hero-actions' });
		const resumeLabel = group.watched >= total ? 'Play again' : fraction(group.resume) > 0 ? 'Resume' : 'Play';
		const play = actions.createEl('button', { cls: 'bfm-library-hero-play' });
		setIcon(play, 'play');
		play.createSpan({ text: ` ${resumeLabel}${group.resume.episode > 0 ? ` episode ${group.resume.episode}` : ''}` });
		play.addEventListener('click', () => void this.play(group.resume));

		if (group.title && this.plugin.canOpenSeriesDetails(group.title)) {
			const details = actions.createEl('button', { text: 'Details' });
			details.addEventListener('click', () => this.plugin.openDetails(group.title));
		}

		if (group.seasons.length > 1) this.renderSeasonTabs(group);

		const episodes = group.episodes.filter((entry) =>
			this.season === 'all' ? true : entry.season === this.season,
		);
		const list = this.bodyEl.createDiv({ cls: 'bfm-library-episodes' });
		for (const entry of episodes) this.renderEpisodeRow(list, group, entry);
	}

	private renderSeasonTabs(group: SeriesGroup): void {
		const tabs = this.bodyEl.createDiv({ cls: 'bfm-library-seasons' });
		const choices: { value: SeasonTab; label: string }[] = [
			{ value: 'all', label: 'All' },
			...group.seasons.map((season) => ({ value: season, label: `Season ${season}` })),
		];
		for (const choice of choices) {
			const button = tabs.createEl('button', { cls: 'bfm-library-season', text: choice.label });
			button.toggleClass('is-active', this.season === choice.value);
			button.addEventListener('click', () => {
				this.season = choice.value;
				this.render();
			});
		}
	}

	private renderEpisodeRow(list: HTMLElement, group: SeriesGroup, entry: EpisodeItem): void {
		const item = entry.item;
		const row = list.createDiv({ cls: 'bfm-library-episode' });
		if (item.watched) row.addClass('is-watched');

		const label = item.episode > 0 ? String(item.episode) : '?';
		const name = item.title && item.title !== item.name ? item.title : `Episode ${label}`;
		const play = row.createEl('button', { cls: 'bfm-library-episode-play' });
		play.setAttribute('aria-label', `Play ${group.title} episode ${label}`);
		play.createSpan({ cls: 'bfm-library-episode-number', text: label });

		const main = row.createDiv({ cls: 'bfm-library-episode-main' });
		main.createDiv({ cls: 'bfm-library-episode-title', text: name });
		const meta: string[] = [];
		if (item.watched) meta.push('Watched');
		else if (item.progress && item.progress.duration > 0) {
			meta.push(`Resume at ${formatDuration(item.progress.position)}`);
		}
		meta.push(item.ext.toUpperCase());
		main.createDiv({ cls: 'bfm-library-episode-meta', text: meta.join(' · ') });
		const played = fraction(item);
		if (played > 0 && !item.watched) {
			const track = main.createDiv({ cls: 'bfm-library-progress' });
			track.createDiv({ cls: 'bfm-library-progress-fill' }).setCssProps({ width: percentOf(played) });
		}

		play.addEventListener('click', () => void this.play(item));

		const remove = row.createEl('button', { cls: 'bfm-library-episode-delete' });
		setIcon(remove, 'trash-2');
		remove.setAttribute('aria-label', `Delete ${item.name}`);
		remove.addEventListener('click', () => this.confirmDelete(item));
	}

	// ---------------------------------------------------------------- actions

	private renderEmpty(): void {
		const empty = this.bodyEl.createDiv({ cls: 'bfm-library-empty' });
		setIcon(empty.createDiv({ cls: 'bfm-library-empty-icon' }), 'film');
		empty.createDiv({
			cls: 'bfm-library-empty-text',
			text:
				this.plugin.libraryEmptyHint() ||
				'No downloaded videos yet. Download an episode and it appears here.',
		});
	}

	/**
	 * Play an item, then repaint when the player closes so the row's progress
	 * and resume point are current. The player is a modal over this view and
	 * writes progress as it goes, so a paint on close is all this needs.
	 */
	private async play(item: LibraryItem): Promise<void> {
		await this.plugin.playItem(item, () => this.render());
	}

	private confirmDelete(item: LibraryItem): void {
		if (this.busy) return;
		new ConfirmModal(
			this.app,
			`Delete ${item.name}? The file is removed from your vault. This cannot be undone.`,
			() =>
				void (async () => {
					this.busy = true;
					try {
						await this.plugin.deleteItem(item);
						await this.refresh();
						new Notice(`Deleted ${item.name}`);
					} catch (error) {
						new Notice(error instanceof Error ? error.message : 'The file could not be deleted.');
					} finally {
						this.busy = false;
					}
				})(),
		).open();
	}
}

import { inferSeason, type LibraryItem } from './library';

/**
 * The library as a browser presents a collection: one shelf per series, each
 * holding its episodes in order.
 *
 * A flat newest-first list is what the library used to be, and it is the wrong
 * shape for a collection of episodes — three seasons of one show scattered by
 * download date, every episode of every other show between them. Grouping is
 * pure so it can be tested without a vault, and so the ordering rules live in
 * one place instead of being spread through the DOM code.
 */

/** One episode inside a series group. */
export interface EpisodeItem {
	item: LibraryItem;
	/** Season recovered from the folder/name, or 1 when nothing says otherwise. */
	season: number;
}

/** One series, or one loose file when the name carried no series. */
export interface SeriesGroup {
	/** Lowercased series name; also the poster key and the DOM id. */
	key: string;
	/** Display name: the series, or the file name for a loose file. */
	title: string;
	/** Episodes in season-then-episode order. */
	episodes: EpisodeItem[];
	/** Every season present, ascending. */
	seasons: number[];
	/** Episodes watched, across all seasons. */
	watched: number;
	/**
	 * The episode to resume: the furthest-along unfinished one, or the first
	 * unwatched, or the last one when everything is watched. Never null while
	 * the group has episodes.
	 */
	resume: LibraryItem;
	/** 0–1: watched episodes over total episodes. */
	progress: number;
	/** Newest mtime in the group, so "recently added" can order groups. */
	modified: number;
}

/** How much of an episode has been watched, 0–1. */
function fraction(item: LibraryItem): number {
	const record = item.progress;
	if (!record || record.duration <= 0) return 0;
	return Math.max(0, Math.min(1, record.position / record.duration));
}

/** A file the plugin did not write has no series; it is its own group. */
function groupKey(item: LibraryItem): string {
	return (item.series || item.name).trim().toLowerCase();
}

/** Pick the episode a series card should offer first. */
function resumeFor(episodes: EpisodeItem[]): LibraryItem {
	const inProgress = episodes
		.filter((entry) => !entry.item.watched && fraction(entry.item) > 0)
		.sort((a, b) => fraction(b.item) - fraction(a.item));
	if (inProgress[0]) return inProgress[0].item;
	const unwatched = episodes.find((entry) => !entry.item.watched);
	if (unwatched) return unwatched.item;
	return episodes[episodes.length - 1]?.item ?? episodes[0]!.item;
}

/**
 * Group a flat library into series, preserving nothing about the input order:
 * the caller picks whether groups are listed by name or by recency.
 */
export function groupBySeries(items: LibraryItem[]): SeriesGroup[] {
	const groups = new Map<string, SeriesGroup>();
	for (const item of items) {
		const key = groupKey(item);
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				title: (item.series || item.name).trim(),
				episodes: [],
				seasons: [],
				watched: 0,
				resume: item,
				progress: 0,
				modified: 0,
			};
			groups.set(key, group);
		}
		const season = inferSeason(`${item.series} ${item.name}`) ?? 1;
		group.episodes.push({ item, season });
		group.modified = Math.max(group.modified, item.modified);
	}
	for (const group of groups.values()) {
		group.episodes.sort(
			(a, b) =>
				a.season - b.season ||
				a.item.episode - b.item.episode ||
				a.item.name.localeCompare(b.item.name),
		);
		group.seasons = [...new Set(group.episodes.map((entry) => entry.season))].sort((a, b) => a - b);
		group.watched = group.episodes.filter((entry) => entry.item.watched).length;
		group.progress = group.episodes.length > 0 ? group.watched / group.episodes.length : 0;
		group.resume = resumeFor(group.episodes);
	}
	return [...groups.values()];
}

/** Sort groups for display. */
export function sortGroups(groups: SeriesGroup[], sort: 'recent' | 'title' | 'episodes'): SeriesGroup[] {
	return [...groups].sort((a, b) => {
		if (sort === 'title') return a.title.localeCompare(b.title);
		if (sort === 'episodes') return b.episodes.length - a.episodes.length || a.title.localeCompare(b.title);
		return b.modified - a.modified || a.title.localeCompare(b.title);
	});
}

/** Whether a group matches a search query; searches series, episode titles and numbers. */
export function groupMatches(group: SeriesGroup, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	if (group.title.toLowerCase().includes(needle)) return true;
	return group.episodes.some(
		(entry) =>
			entry.item.title.toLowerCase().includes(needle) ||
			entry.item.name.toLowerCase().includes(needle) ||
			String(entry.item.episode) === needle,
	);
}

/**
 * The episode the viewer should move to next: the following episode in series
 * order, across season boundaries. Unlike the old lookup this does not depend
 * on the episode being mp4, and it falls back to the group's first episode
 * when nothing follows.
 */
export function neighbourInGroup(
	group: SeriesGroup,
	path: string,
	direction: 'previous' | 'next',
): LibraryItem | null {
	const index = group.episodes.findIndex((entry) => entry.item.path === path);
	if (index < 0) return null;
	return group.episodes[index + (direction === 'next' ? 1 : -1)]?.item ?? null;
}

/** Percent watched, as a whole number for display. */
export function groupPercent(group: SeriesGroup): number {
	return Math.round(group.progress * 100);
}

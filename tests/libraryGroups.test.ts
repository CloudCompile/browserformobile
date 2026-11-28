import { describe, it, expect } from 'vitest';

import type { LibraryItem } from '../src/library';
import {
	groupBySeries,
	groupMatches,
	groupPercent,
	neighbourInGroup,
	sortGroups,
} from '../src/libraryGroups';

function item(overrides: Partial<LibraryItem> & { path: string }): LibraryItem {
	return {
		name: overrides.path.split('/').pop() ?? overrides.path,
		series: '',
		episode: 0,
		title: '',
		ext: 'mp4',
		size: 0,
		modified: 0,
		progress: null,
		watched: false,
		...overrides,
	};
}

/** A series folder as the downloader writes it: one mtime per file. */
function episode(series: string, number: number, modified: number, extra: Partial<LibraryItem> = {}): LibraryItem {
	return item({
		path: `Anime/${series}/${series} - ${String(number).padStart(2, '0')} - Ep ${number}.mp4`,
		series,
		episode: number,
		title: `Ep ${number}`,
		modified,
		...extra,
	});
}

describe('groupBySeries', () => {
	it('folds a series into one group, in episode order, whatever the download order', () => {
		const groups = groupBySeries([episode('Show', 5, 90), episode('Show', 1, 10), episode('Show', 3, 50)]);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.episodes.map((entry) => entry.item.episode)).toEqual([1, 3, 5]);
	});

	it('separates seasons and recovers the season from the folder name', () => {
		const groups = groupBySeries([
			item({ path: 'Anime/Show Season 2/Show S2 - 01 - A.mp4', series: 'Show Season 2', episode: 1 }),
			item({ path: 'Anime/Show/Show - 02 - B.mp4', series: 'Show', episode: 2 }),
		]);
		const seasons = groups.map((group) => group.seasons).flat();
		expect(seasons).toContain(2);
		expect(seasons).toContain(1);
	});

	it('keeps a file with no series as its own group named after the file', () => {
		const groups = groupBySeries([item({ path: 'Anime/holiday.mp4' })]);
		expect(groups[0]!.title).toBe('holiday.mp4');
		expect(groups[0]!.episodes).toHaveLength(1);
	});

	it('resumes the furthest-along unfinished episode, then the first unwatched', () => {
		const far = episode('Show', 1, 10, { progress: { position: 900, duration: 1000, updatedAt: 1 } });
		const near = episode('Show', 2, 20, { progress: { position: 100, duration: 1000, updatedAt: 2 } });
		const group = groupBySeries([near, far])[0]!;
		expect(group.resume.episode).toBe(1);

		const watched = episode('Show', 1, 10, { watched: true, progress: { position: 990, duration: 1000, updatedAt: 1 } });
		const group2 = groupBySeries([watched, episode('Show', 3, 30)])[0]!;
		expect(group2.resume.episode).toBe(3);
	});

	it('counts watched episodes for the progress bar', () => {
		const groups = groupBySeries([
			episode('Show', 1, 10, { watched: true }),
			episode('Show', 2, 20),
			episode('Show', 3, 30),
			episode('Show', 4, 40, { watched: true }),
		]);
		expect(groupPercent(groups[0]!)).toBe(50);
	});
});

describe('sorting and searching groups', () => {
	const groups = () =>
		groupBySeries([
			episode('Alpha', 1, 10),
			episode('Beta', 1, 99),
			episode('Beta', 2, 98),
		]);

	it('sorts by recency or title', () => {
		expect(sortGroups(groups(), 'recent').map((group) => group.title)).toEqual(['Beta', 'Alpha']);
		expect(sortGroups(groups(), 'title').map((group) => group.title)).toEqual(['Alpha', 'Beta']);
		expect(sortGroups(groups(), 'episodes')[0]!.title).toBe('Beta');
	});

	it('matches on the series name and on an episode title', () => {
		const list = groups();
		expect(groupMatches(list[0]!, 'alph')).toBe(true);
		expect(groupMatches(list[0]!, 'Ep 1')).toBe(true);
		expect(groupMatches(list[0]!, 'nothing')).toBe(false);
	});
});

describe('neighbourInGroup', () => {
	it('crosses the season boundary rather than stopping at it', () => {
		const groups = groupBySeries([
			item({ path: 'Anime/Show/Show - 10 - A.mp4', series: 'Show', episode: 10 }),
			item({ path: 'Anime/Show Season 2/Show S2 - 01 - B.mp4', series: 'Show Season 2', episode: 1 }),
		]);
		// Two groups, because the folder names differ; the neighbour stays inside one.
		expect(neighbourInGroup(groups[0]!, groups[0]!.episodes[0]!.item.path, 'next')).toBeNull();
	});

	it('walks forwards and backwards inside a group', () => {
		const group = groupBySeries([episode('Show', 1, 10), episode('Show', 2, 20)])[0]!;
		const first = group.episodes[0]!.item;
		const second = group.episodes[1]!.item;
		expect(neighbourInGroup(group, first.path, 'next')?.path).toBe(second.path);
		expect(neighbourInGroup(group, second.path, 'previous')?.path).toBe(first.path);
		expect(neighbourInGroup(group, first.path, 'previous')).toBeNull();
	});
});

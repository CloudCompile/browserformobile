import { describe, expect, it } from 'vitest';
import { EPISODE_GROUP_SIZE, planEpisodeGroups, type EpisodeSummary } from '../src/animeApi';

function episodes(...numbers: number[]): EpisodeSummary[] {
        return numbers.map((number) => ({
                id: `ep-${number}`,
                number,
                title: `Episode ${number}`,
                filler: false,
                subbed: true,
                dubbed: false,
        }));
}

describe('planEpisodeGroups', () => {
        it('leaves a short series flat', () => {
                expect(planEpisodeGroups(episodes(1, 2, 3))).toBeNull();
                // At the threshold too: grouping only pays for a longer list.
                expect(planEpisodeGroups(episodes(...range(EPISODE_GROUP_SIZE)))).toBeNull();
        });

        it('chunks a long series with honest numeric labels', () => {
                const groups = planEpisodeGroups(episodes(...range(130)));
                expect(groups).not.toBeNull();
                expect(groups?.map((group) => group.label)).toEqual([
                        'Episodes 1–50',
                        'Episodes 51–100',
                        'Episodes 101–130',
                ]);
                expect(groups?.[0]?.episodes).toHaveLength(50);
                expect(groups?.[2]?.episodes).toHaveLength(30);
        });

        it('labels the chunk with the numbers actually inside it', () => {
                // The catalogue skips numbers freely; the labels follow the real
                // numbering rather than assuming a contiguous run.
                const groups = planEpisodeGroups(episodes(1, 2, 4, 6, 9, 200, 401, 402), 3);
                expect(groups?.map((group) => group.label)).toEqual([
                        'Episodes 1–4',
                        'Episodes 6–200',
                        'Episodes 401–402',
                ]);
        });

        it('honours a custom chunk size', () => {
                const groups = planEpisodeGroups(episodes(...range(12)), 5);
                expect(groups?.map((group) => group.label)).toEqual([
                        'Episodes 1–5',
                        'Episodes 6–10',
                        'Episodes 11–12',
                ]);
        });
});

/** 1..count, so a test can spell a range without typing it out. */
function range(count: number): number[] {
        return Array.from({ length: count }, (_, index) => index + 1);
}

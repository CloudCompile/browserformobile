import { describe, expect, it } from 'vitest';
import {
        DEFAULT_SETTINGS,
        definedSettingKeys,
        settingGroups,
        type SettingActions,
} from '../src/settings';

const actions: SettingActions = { exportDebugLog: () => undefined };

interface Leaf {
        control?: { key: string };
        action?: unknown;
}

/** Every leaf row across every group: a control or an action, never a group. */
function leaves(advanced: boolean): Leaf[] {
        const out: Leaf[] = [];
        for (const group of settingGroups(advanced, actions)) {
                if (!('items' in group) || !group.items) continue;
                for (const item of group.items) {
                        if ('control' in item && item.control) out.push(item as Leaf);
                        else if ('action' in item && item.action) out.push(item as Leaf);
                }
        }
        return out;
}

function keysOnPage(): string[] {
        return leaves(true)
                .map((leaf) => leaf.control?.key)
                .filter((key): key is string => typeof key === 'string');
}

/** The headings a page renders, with groups that hide themselves removed. */
function headings(advanced: boolean): string[] {
        return settingGroups(advanced, actions)
                .filter((group) => group.type === 'group' && group.visible !== false)
                .map((group) => ('heading' in group ? String(group.heading ?? '') : ''));
}

/**
 * The three-part rule in `apps/plugin/AGENTS.md`: a new setting goes into
 * `AnimeSettings`, `DEFAULT_SETTINGS` and the page. Missing the third part
 * renders nothing — and a group spreading an undefined entry throws while the
 * page is built, which takes the whole tab down. Neither is a type error on its
 * own, so both are asserted here.
 */
describe('settings page covers every setting', () => {
        it('defines every key in DEFAULT_SETTINGS', () => {
                expect(definedSettingKeys().sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
        });

        it('only points controls at keys that exist', () => {
                const defaults = new Set(Object.keys(DEFAULT_SETTINGS));
                for (const key of keysOnPage()) expect(defaults.has(key)).toBe(true);
        });

        it('reaches every definition from exactly one group', () => {
                const keys = keysOnPage();
                expect(new Set(keys).size).toBe(keys.length);
                expect(new Set(keys)).toEqual(new Set(definedSettingKeys()));
        });

        it('shows the everyday groups with advanced off', () => {
                expect(headings(false)).toEqual([
                        'Essentials',
                        'Downloads and library',
                        'Browser',
                        'Library and catalogue',
                ]);
        });

        it('adds the technical groups with advanced on', () => {
                expect(headings(true)).toEqual([
                        'Essentials',
                        'Downloads and library',
                        'Browser',
                        'Library and catalogue',
                        'Downloading',
                        'Browser, technical',
                        'Subtitles and player',
                        'Recommendations and models',
                        'Diagnostics',
                ]);
        });

        it('keeps one 18+ switch', () => {
                expect(keysOnPage().filter((key) => key === 'showAdultContent')).toHaveLength(1);
        });

        it('renders the switch itself in both modes', () => {
                expect(leaves(false).some((leaf) => leaf.control?.key === 'settingsAdvanced')).toBe(true);
                expect(leaves(true).some((leaf) => leaf.control?.key === 'settingsAdvanced')).toBe(true);
        });
});

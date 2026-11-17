/**
 * The blocks a full series details page is made of.
 *
 * Two pages render the same catalogue answer: the library's details page and
 * the downloader's pre-download details page. Keeping the blocks here means a
 * provider-agnostic page in both places, and one place to fix when a block
 * reads badly on a phone.
 *
 * No state and no requests: callers pass the `AnimePreview` they already have.
 */

import { setIcon } from 'obsidian';
import type {
        AnimePreview,
        PreviewCharacter,
        PreviewDetail,
        PreviewStaffMember,
        PreviewTheme,
} from './animeApi';

export interface DetailFact {
        label: string;
        value: string;
}

/** A number with thousands separators, or an em dash when absent. */
export function countText(value: number | null | undefined): string {
        if (value === null || value === undefined) return '—';
        return value.toLocaleString();
}

/** A duration string, or an em dash when absent. */
export function durationText(value: string | null | undefined): string {
        return value ?? '—';
}

/**
 * The headline numbers for the facts grid. Only present fields are included,
 * because a row of em dashes reads like a broken fetch rather than a gap.
 */
export function factsFor(detail: PreviewDetail, episodesOverride?: number | null): DetailFact[] {
        const facts: DetailFact[] = [];
        if (detail.score !== null) facts.push({ label: 'Score', value: detail.score.toFixed(2) });
        if (detail.rank !== null) facts.push({ label: 'Ranked', value: `#${countText(detail.rank)}` });
        if (detail.popularity !== null) facts.push({ label: 'Popularity', value: `#${countText(detail.popularity)}` });
        const episodes = episodesOverride && episodesOverride > 0 ? episodesOverride : detail.episodes;
        if (episodes !== null) facts.push({ label: 'Episodes', value: String(episodes) });
        if (detail.type) facts.push({ label: 'Type', value: detail.type });
        if (detail.status) facts.push({ label: 'Status', value: detail.status });
        if (detail.duration) facts.push({ label: 'Duration', value: durationText(detail.duration) });
        if (detail.rating) facts.push({ label: 'Rating', value: detail.rating });
        if (detail.source) facts.push({ label: 'Source', value: detail.source });
        if (detail.year !== null) facts.push({ label: 'Year', value: String(detail.year) });
        if (detail.aired.string) facts.push({ label: 'Aired', value: detail.aired.string });
        if (detail.broadcast.string) facts.push({ label: 'Broadcast', value: detail.broadcast.string });
        if (detail.members !== null) facts.push({ label: 'Members', value: countText(detail.members) });
        if (detail.favorites !== null) facts.push({ label: 'Favourites', value: countText(detail.favorites) });
        return facts;
}

/** Append the facts grid to a host. */
export function renderFacts(host: HTMLElement, facts: DetailFact[]): void {
        if (facts.length === 0) return;
        const grid = host.createDiv({ cls: 'bfm-details-facts' });
        for (const fact of facts) {
                const cell = grid.createDiv({ cls: 'bfm-details-fact' });
                cell.createDiv({ cls: 'bfm-details-fact-label', text: fact.label });
                cell.createDiv({ cls: 'bfm-details-fact-value', text: fact.value });
        }
}

/** A titled section with an icon. */
export function section(host: HTMLElement, title: string, icon: string): HTMLElement {
        const element = host.createDiv({ cls: 'bfm-details-section' });
        const header = element.createDiv({ cls: 'bfm-details-section-title' });
        setIcon(header.createSpan({ cls: 'bfm-details-section-icon' }), icon);
        header.createSpan({ text: title });
        return element;
}

export interface HeroOptions {
        poster: string | null;
        title: string;
        subtitle?: string | null;
        /** Show the 18+ badge. */
        adult?: boolean;
        facts: DetailFact[];
}

/**
 * The poster and the headline facts.
 *
 * Facts sit beside the poster rather than under it: on a phone the two columns
 * together are still one screen, while a poster followed by a full-width grid
 * pushes the synopsis below the fold.
 */
export function renderHero(host: HTMLElement, options: HeroOptions): void {
        if (!options.poster && options.facts.length === 0 && !options.title) return;
        const hero = host.createDiv({ cls: 'bfm-details-hero' });
        if (options.poster) {
                hero.createEl('img', {
                        cls: 'bfm-details-poster',
                        attr: { src: options.poster, alt: '', loading: 'lazy' },
                });
        }
        const info = hero.createDiv({ cls: 'bfm-details-hero-info' });
        const titleRow = info.createDiv({ cls: 'bfm-details-hero-title-row' });
        titleRow.createEl('h2', { cls: 'bfm-details-hero-title', text: options.title });
        if (options.adult) titleRow.createSpan({ cls: 'bfm-dl-badge', text: '18+' });
        if (options.subtitle && options.subtitle.trim() && options.subtitle.trim() !== options.title.trim()) {
                info.createDiv({ cls: 'bfm-details-hero-sub', text: options.subtitle });
        }
        renderFacts(info, options.facts);
}

/** Genres, themes and demographics as chips. */
export function renderChips(host: HTMLElement, detail: PreviewDetail): void {
        const chips: Array<{ text: string; cls: string }> = [
                ...detail.genres.map((genre) => ({ text: genre, cls: 'is-genre' })),
                ...detail.themes.map((theme) => ({ text: theme, cls: 'is-theme' })),
                ...detail.demographics.map((demo) => ({ text: demo, cls: 'is-demo' })),
        ];
        if (chips.length === 0) return;
        const row = host.createDiv({ cls: 'bfm-details-chips' });
        for (const chip of chips) {
                row.createSpan({ cls: `bfm-details-chip ${chip.cls}`, text: chip.text });
        }
}

/** The synopsis, when the source actually publishes one. */
export function renderSynopsis(host: HTMLElement, synopsis: string | null | undefined): void {
        if (!synopsis) return;
        const element = section(host, 'Synopsis', 'align-left');
        element.createDiv({ cls: 'bfm-details-synopsis', text: synopsis });
}

/** Openings, endings and other music themes. */
export function renderMusic(host: HTMLElement, themes: PreviewTheme[]): void {
        if (themes.length === 0) return;
        const openings = themes.filter((theme) => theme.kind === 'opening');
        const endings = themes.filter((theme) => theme.kind === 'ending');
        const other = themes.filter((theme) => theme.kind !== 'opening' && theme.kind !== 'ending');
        const element = section(host, 'Music', 'music');
        for (const [label, list] of [
                ['Openings', openings],
                ['Endings', endings],
                ['Other', other],
        ] as Array<[string, PreviewTheme[]]>) {
                if (list.length === 0) continue;
                element.createDiv({ cls: 'bfm-details-subtitle', text: `${label} (${list.length})` });
                const ul = element.createEl('ul', { cls: 'bfm-details-music' });
                for (const theme of list) {
                        const li = ul.createEl('li');
                        li.createSpan({ cls: 'bfm-details-music-title', text: theme.title ?? 'Unknown' });
                        if (theme.artist) li.createSpan({ cls: 'bfm-details-music-artist', text: ` — ${theme.artist}` });
                        if (theme.episodes) li.createSpan({ cls: 'bfm-details-music-eps', text: ` (${theme.episodes})` });
                }
        }
}

/** Main characters first, then by favourites, so the leads are on top. */
export function renderCast(host: HTMLElement, characters: PreviewCharacter[]): void {
        if (characters.length === 0) return;
        const element = section(host, 'Cast', 'users');
        const grid = element.createDiv({ cls: 'bfm-details-cast' });
        const sorted = [...characters].sort((left, right) => {
                const leftMain = left.role === 'Main' ? 1 : 0;
                const rightMain = right.role === 'Main' ? 1 : 0;
                if (leftMain !== rightMain) return rightMain - leftMain;
                return (right.favorites ?? 0) - (left.favorites ?? 0);
        });
        for (const character of sorted.slice(0, 18)) renderCharacterCard(grid, character);
}

function renderCharacterCard(grid: HTMLElement, character: PreviewCharacter): void {
        const card = grid.createDiv({ cls: 'bfm-details-cast-card' });
        if (character.image) {
                card.createEl('img', {
                        cls: 'bfm-details-cast-image',
                        attr: { src: character.image, alt: '', loading: 'lazy' },
                });
        } else {
                const placeholder = card.createDiv({ cls: 'bfm-details-cast-image is-placeholder' });
                setIcon(placeholder, 'user');
        }
        const info = card.createDiv({ cls: 'bfm-details-cast-info' });
        info.createDiv({ cls: 'bfm-details-cast-name', text: character.name ?? 'Unknown' });
        if (character.role) info.createDiv({ cls: 'bfm-details-cast-role', text: character.role });
        // MAL records the Japanese voice actor for each character.
        const voice =
                character.voiceActors.find((actor) => actor.language === 'Japanese') ?? character.voiceActors[0];
        if (voice?.name) info.createDiv({ cls: 'bfm-details-cast-voice', text: voice.name });
}

/** Staff credits. */
export function renderStaff(host: HTMLElement, staff: PreviewStaffMember[]): void {
        if (staff.length === 0) return;
        const element = section(host, 'Staff', 'briefcase');
        const list = element.createDiv({ cls: 'bfm-details-staff' });
        for (const member of staff.slice(0, 12)) {
                const row = list.createDiv({ cls: 'bfm-details-staff-row' });
                row.createSpan({ cls: 'bfm-details-staff-name', text: member.name ?? 'Unknown' });
                if (member.role) row.createSpan({ cls: 'bfm-details-staff-role', text: member.role });
        }
}

/** Studios, producers, licensors and related titles. */
export function renderProduction(host: HTMLElement, detail: PreviewDetail): void {
        const groups: Array<[string, PreviewDetail['studios']]> = [
                ['Studios', detail.studios],
                ['Producers', detail.producers],
                ['Licensors', detail.licensors],
        ];
        const rows = groups.filter(([, list]) => list.length > 0);
        const relations = detail.relations.length > 0;
        if (rows.length === 0 && !relations) return;
        const element = section(host, 'Production', 'building');
        for (const [label, list] of rows) {
                const row = element.createDiv({ cls: 'bfm-details-company-row' });
                row.createSpan({ cls: 'bfm-details-company-label', text: label });
                row.createSpan({
                        cls: 'bfm-details-company-list',
                        text: list.map((company) => company.name).join(', '),
                });
        }
        if (relations) {
                const related = element.createDiv({ cls: 'bfm-details-company-row' });
                related.createSpan({ cls: 'bfm-details-company-label', text: 'Related' });
                related.createSpan({
                        cls: 'bfm-details-company-list',
                        text: detail.relations
                                .slice(0, 8)
                                .map((relation) => `${relation.relation ?? ''}: ${relation.title ?? ''}`.trim())
                                .join(' · '),
                });
        }
}

/** Streaming and external links. */
export function renderLinks(host: HTMLElement, detail: PreviewDetail): void {
        const streaming = detail.streaming.filter((link) => link.url);
        if (streaming.length === 0 && !detail.url) return;
        const element = section(host, 'Links', 'link');
        if (streaming.length > 0) {
                const row = element.createDiv({ cls: 'bfm-details-link-row' });
                row.createSpan({ cls: 'bfm-details-company-label', text: 'Streaming' });
                const list = row.createSpan({ cls: 'bfm-details-company-list' });
                streaming.slice(0, 6).forEach((link, index) => {
                        if (index > 0) list.createSpan({ text: ', ' });
                        const anchor = list.createEl('a', { text: link.name ?? 'link' });
                        anchor.href = link.url ?? '#';
                        anchor.setAttr('target', '_blank');
                        anchor.setAttr('rel', 'noopener');
                });
        }
        if (detail.url) {
                const row = element.createDiv({ cls: 'bfm-details-link-row' });
                row.createSpan({ cls: 'bfm-details-company-label', text: 'MyAnimeList' });
                const anchor = row.createEl('a', { text: detail.url });
                anchor.href = detail.url;
                anchor.setAttr('target', '_blank');
                anchor.setAttr('rel', 'noopener');
        }
}

/**
 * Everything the preview carries, in page order: synopsis, chips, music, cast,
 * staff, production and links. Empty blocks are skipped.
 */
export function renderPreviewBlocks(host: HTMLElement, preview: AnimePreview): void {
        renderSynopsis(host, preview.detail.synopsis);
        renderChips(host, preview.detail);
        renderMusic(host, preview.themes);
        renderCast(host, preview.characters);
        renderStaff(host, preview.staff);
        renderProduction(host, preview.detail);
        renderLinks(host, preview.detail);
}

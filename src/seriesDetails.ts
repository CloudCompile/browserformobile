/**
 * The blocks a full series details page is made of.
 *
 * Two pages render the same catalogue answer: the details page itself and the
 * downloader's pre-download page. Keeping the blocks here means a
 * provider-agnostic page in both places, and one place to fix when a block
 * reads badly on a phone.
 *
 * The layout is deliberately cinematic: a poster-derived backdrop, the poster,
 * the title block with its chips and numbers, and a slot for the page's primary
 * action. Everything below it is a set of panels.
 *
 * No state and no requests: callers pass the `AnimePreview` they already have.
 */

import { setIcon } from 'obsidian';
import { createCover } from './covers';
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

/** A genre, theme or demographic pill. */
export interface DetailChip {
        text: string;
        cls: string;
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

/** Genres, themes and demographics as one ordered pill list. */
export function chipsFor(detail: PreviewDetail): DetailChip[] {
        return [
                ...detail.genres.map((genre) => ({ text: genre, cls: 'is-genre' })),
                ...detail.themes.map((theme) => ({ text: theme, cls: 'is-theme' })),
                ...detail.demographics.map((demo) => ({ text: demo, cls: 'is-demo' })),
        ];
}

/**
 * The one-line context above the title: the shape of the show, when it aired,
 * and whether it is finished. Joined from whatever the record actually has.
 */
export function eyebrowFor(detail: PreviewDetail): string {
        const parts: string[] = [];
        if (detail.type) parts.push(detail.type);
        if (detail.year !== null) parts.push(String(detail.year));
        if (detail.status) parts.push(detail.status);
        if (detail.rating) parts.push(detail.rating);
        return parts.join('  ·  ');
}

/**
 * Split the facts into the handful the cover shows and the rest.
 *
 * A cover is a poster and a few numbers, not a table: the first five facts sit
 * beside the title where they are read at a glance, and everything else goes
 * into a Details panel further down the page.
 */
export function splitFacts(facts: DetailFact[], limit = 5): { hero: DetailFact[]; rest: DetailFact[] } {
        return { hero: facts.slice(0, limit), rest: facts.slice(limit) };
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

/** A titled panel with an icon. */
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
        /** Genres and themes, shown inside the hero under the title. */
        chips?: DetailChip[];
        /** The small line above the title. */
        eyebrow?: string;
        /** The synopsis under the numbers, when the caller already has it. */
        synopsis?: string | null;
}

export interface HeroElements {
        hero: HTMLElement;
        /** The row the caller puts its primary action into. */
        actions: HTMLElement;
        /**
         * Show the text that was missing when the hero was first drawn.
         *
         * A page painted from the kept metadata copy has no synopsis while
         * the 18+ source's page is being read (that read is a network round
         * trip). Rather than repaint the whole page — which would reload every
         * poster — the hero holds a synopsis slot that the caller fills once
         * the text arrives.
         */
        setSynopsis(text: string | null): void;
}

/**
 * The poster, the title block and the headline numbers, over a blurred copy of
 * the poster.
 *
 * The backdrop is what makes the page read as a title page rather than a form:
 * a 132px poster alone on a panel is a thumbnail, while the same art filling
 * the width behind it is a cover. It is a decorative duplicate of the poster
 * image (already in the cache, so no extra request) and is hidden from
 * assistive tech.
 *
 * Returns the action row so the caller can place its own buttons, because the
 * primary action differs per page: "Download episodes" on the details page,
 * "Choose episodes" on the downloader's.
 */
export function renderHero(host: HTMLElement, options: HeroOptions): HeroElements {
        const hero = host.createDiv({ cls: 'bfm-hero' });

        // The cover is whatever actually loads: a poster URL that fails (a moved
        // path, a hotlink-protected CDN) or is missing falls back to a drawn
        // placeholder, so a page never opens to an empty frame.
        const backdrop = hero.createDiv({ cls: 'bfm-hero-backdrop' });
        createCover(backdrop, options.poster, options.title, {
                imageClass: 'bfm-hero-backdrop-image',
                fallbackClass: 'bfm-hero-backdrop-fallback',
                variant: 'wide',
        });
        backdrop.createDiv({ cls: 'bfm-hero-scrim' });

        const inner = hero.createDiv({ cls: 'bfm-hero-inner' });
        const posterWrap = inner.createDiv({ cls: 'bfm-hero-poster-wrap' });
        createCover(posterWrap, options.poster, options.title, {
                imageClass: 'bfm-hero-poster',
                fallbackClass: 'bfm-hero-poster-fallback',
                variant: 'poster',
        });

        const info = inner.createDiv({ cls: 'bfm-hero-info' });
        const eyebrowParts = (options.eyebrow ?? '')
                .split('·')
                .map((part) => part.trim())
                .filter(Boolean);
        if (eyebrowParts.length > 0) {
                // One span per fact, so a wrap lands between two facts instead of
                // breaking a value like "PG-13" across two lines.
                const eyebrow = info.createDiv({ cls: 'bfm-hero-eyebrow' });
                eyebrowParts.forEach((part, index) => {
                        if (index > 0) eyebrow.createSpan({ cls: 'bfm-hero-eyebrow-sep', text: '·' });
                        eyebrow.createSpan({ cls: 'bfm-hero-eyebrow-part', text: part });
                });
        }
        const titleRow = info.createDiv({ cls: 'bfm-hero-title-row' });
        titleRow.createEl('h2', { cls: 'bfm-hero-title', text: options.title });
        if (options.adult) titleRow.createSpan({ cls: 'bfm-hero-badge', text: '18+' });
        if (options.subtitle && options.subtitle.trim() && options.subtitle.trim() !== options.title.trim()) {
                info.createDiv({ cls: 'bfm-hero-sub', text: options.subtitle });
        }

        if (options.chips && options.chips.length > 0) {
                const chips = info.createDiv({ cls: 'bfm-hero-chips' });
                for (const chip of options.chips) {
                        chips.createSpan({ cls: `bfm-hero-chip ${chip.cls}`, text: chip.text });
                }
        }

        if (options.facts.length > 0) {
                const stats = info.createDiv({ cls: 'bfm-hero-stats' });
                for (const fact of options.facts) {
                        const stat = stats.createDiv({ cls: 'bfm-hero-stat' });
                        stat.createSpan({ cls: 'bfm-hero-stat-value', text: fact.value });
                        stat.createSpan({ cls: 'bfm-hero-stat-label', text: fact.label });
                }
        }

        // The synopsis sits in the cover, under the numbers: it is the one
        // paragraph that convinces someone to watch, so it is part of the title
        // page rather than another panel they have to scroll to.
        let synopsisEl: HTMLElement | null = null;
        const setSynopsis = (text: string | null): void => {
                const trimmed = (text ?? '').trim();
                if (!trimmed) {
                        synopsisEl?.remove();
                        synopsisEl = null;
                        hero.removeClass('has-synopsis');
                        return;
                }
                if (!synopsisEl) {
                        synopsisEl = info.createDiv({ cls: 'bfm-hero-synopsis' });
                        // Before the action row, so the buttons stay the last thing.
                        info.insertBefore(synopsisEl, actions);
                }
                synopsisEl.setText(trimmed);
                hero.addClass('has-synopsis');
                hero.removeClass('is-reading-synopsis');
        };

        const actions = info.createDiv({ cls: 'bfm-hero-actions' });
        if (options.synopsis) setSynopsis(options.synopsis);
        return { hero, actions, setSynopsis };
}

/** Genres, themes and demographics as chips. */
export function renderChips(host: HTMLElement, detail: PreviewDetail): void {
        const chips = chipsFor(detail);
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
                element.createDiv({ cls: 'bfm-details-subtitle', text: `${label} · ${list.length}` });
                const ul = element.createEl('ul', { cls: 'bfm-details-music' });
                for (const theme of list) {
                        const li = ul.createEl('li');
                        const copy = li.createDiv({ cls: 'bfm-details-music-copy' });
                        copy.createSpan({ cls: 'bfm-details-music-title', text: theme.title ?? 'Unknown' });
                        if (theme.artist) copy.createSpan({ cls: 'bfm-details-music-artist', text: theme.artist });
                        if (theme.episodes) li.createSpan({ cls: 'bfm-details-music-eps', text: theme.episodes });
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

export interface PreviewBlockOptions {
        /**
         * Render the chips. Pages whose hero already carries them pass false, so
         * the genres are not printed twice.
         */
        chips?: boolean;
}

/**
 * Everything the preview carries, in page order: synopsis, chips, music, cast,
 * staff, production and links. Empty blocks are skipped.
 */
export function renderPreviewBlocks(
        host: HTMLElement,
        preview: AnimePreview,
        options: PreviewBlockOptions = {},
): void {
        renderSynopsis(host, preview.detail.synopsis);
        if (options.chips !== false) renderChips(host, preview.detail);
        renderMusic(host, preview.themes);
        renderCast(host, preview.characters);
        renderStaff(host, preview.staff);
        renderProduction(host, preview.detail);
        renderLinks(host, preview.detail);
}

import { App, Modal, Notice, setIcon } from 'obsidian';
import { loadPreview, type AnimePreview, type PreviewCharacter, type PreviewTheme } from './animeApi';
import type { Recommendation } from './recommend';
import { describeBecause } from './recommendService';

export interface DetailsCallbacks {
        /** Series name, used to queue episodes through the existing downloader. */
        onDownload?(series: string): void;
        /** Open the details page for a recommended title. */
        onOpenRecommendation?(title: string): void;
        onClosed?(): void;
}

export interface DetailsModalOptions {
        /** Series name or id to load. */
        series: string;
        /** Base URL of the anime API, from the plugin settings. */
        apiBase: string;
        /** Called when recommendations should be produced for this series. */
        loadRecommendations?: (seed: string) => Promise<Recommendation[]>;
}

/** Format a number with thousands separators, or an em dash when absent. */
function count(value: number | null | undefined): string {
        if (value === null || value === undefined) return '—';
        return value.toLocaleString();
}

/** A short "24 min" style duration, or the raw string. */
function durationText(value: string | null): string {
        return value ?? '—';
}

/**
 * The full details page for a series.
 *
 * Everything shown comes from the API's `/api/preview/:id`, which rebuilds the
 * MyAnimeList record: score, rank, studios, cast, staff, themes, relations and
 * the catalogue's own recommendations. Blocks are rendered only when they have
 * content, because a title with no themes or no trailer is normal and an empty
 * heading reads like a bug.
 */
export class DetailsModal extends Modal {
        private preview: AnimePreview | null = null;
        private loading = true;
        private failed: string | null = null;
        private recommendations: Recommendation[] = [];
        private recommendationsLoading = false;
        private bodyEl!: HTMLElement;

        constructor(
                app: App,
                private readonly options: DetailsModalOptions,
                private readonly callbacks: DetailsCallbacks = {},
        ) {
                super(app);
                this.modalEl.addClass('bfm-details-modal');
        }

        onOpen(): void {
                this.titleEl.setText(this.options.series);
                this.contentEl.empty();
                this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-details-body' });
                this.render();
                void this.load();
        }

        onClose(): void {
                this.contentEl.empty();
                this.callbacks.onClosed?.();
        }

        private async load(): Promise<void> {
                try {
                        this.preview = await loadPreview(this.options.apiBase, this.options.series);
                        if (!this.preview) this.failed = 'No details are available for this title.';
                } catch (error) {
                        this.failed = error instanceof Error ? error.message : 'Could not load details.';
                } finally {
                        this.loading = false;
                        this.render();
                }
                // Recommendations are a separate pass so the details page does not
                // wait on them.
                if (this.preview && this.options.loadRecommendations) {
                        this.recommendationsLoading = true;
                        this.renderRecommendations();
                        try {
                                this.recommendations = await this.options.loadRecommendations(this.options.series);
                        } catch {
                                this.recommendations = [];
                        } finally {
                                this.recommendationsLoading = false;
                                this.renderRecommendations();
                        }
                }
        }

        private render(): void {
                this.bodyEl.empty();
                if (this.loading) {
                        const loading = this.bodyEl.createDiv({ cls: 'bfm-details-loading' });
                        loading.createDiv({ cls: 'bfm-details-spinner' });
                        loading.createDiv({ text: 'Loading details…' });
                        return;
                }
                if (!this.preview) {
                        const empty = this.bodyEl.createDiv({ cls: 'bfm-details-empty' });
                        setIcon(empty.createDiv({ cls: 'bfm-details-empty-icon' }), 'info');
                        empty.createDiv({ text: this.failed ?? 'No details available.' });
                        return;
                }

                const detail = this.preview.detail;
                this.titleEl.setText(detail.title ?? this.options.series);
                this.renderHero(detail.image);
                this.renderFacts();
                this.renderSynopsis();
                this.renderTags();
                this.renderThemes();
                this.renderCast();
                this.renderStaff();
                this.renderRelations();
                this.renderLinks();
                this.renderRecommendations();
        }

        private renderHero(poster: string | null): void {
                if (!poster) return;
                const hero = this.bodyEl.createDiv({ cls: 'bfm-details-hero' });
                hero.createEl('img', { cls: 'bfm-details-poster', attr: { src: poster, alt: '', loading: 'lazy' } });
        }

        /** The headline numbers: score, rank, episodes, status. */
        private renderFacts(): void {
                const detail = this.preview!.detail;
                const facts: Array<{ label: string; value: string }> = [];
                if (detail.score !== null) facts.push({ label: 'Score', value: detail.score.toFixed(2) });
                if (detail.rank !== null) facts.push({ label: 'Ranked', value: `#${count(detail.rank)}` });
                if (detail.popularity !== null) facts.push({ label: 'Popularity', value: `#${count(detail.popularity)}` });
                if (detail.episodes !== null) facts.push({ label: 'Episodes', value: String(detail.episodes) });
                if (detail.type) facts.push({ label: 'Type', value: detail.type });
                if (detail.status) facts.push({ label: 'Status', value: detail.status });
                if (detail.duration) facts.push({ label: 'Duration', value: durationText(detail.duration) });
                if (detail.rating) facts.push({ label: 'Rating', value: detail.rating });
                if (detail.source) facts.push({ label: 'Source', value: detail.source });
                if (detail.year !== null) facts.push({ label: 'Year', value: String(detail.year) });
                if (detail.aired.string) facts.push({ label: 'Aired', value: detail.aired.string });
                if (detail.broadcast.string) facts.push({ label: 'Broadcast', value: detail.broadcast.string });
                if (detail.members !== null) facts.push({ label: 'Members', value: count(detail.members) });
                if (detail.favorites !== null) facts.push({ label: 'Favourites', value: count(detail.favorites) });
                if (facts.length === 0) return;

                const grid = this.bodyEl.createDiv({ cls: 'bfm-details-facts' });
                for (const fact of facts) {
                        const cell = grid.createDiv({ cls: 'bfm-details-fact' });
                        cell.createDiv({ cls: 'bfm-details-fact-label', text: fact.label });
                        cell.createDiv({ cls: 'bfm-details-fact-value', text: fact.value });
                }
        }

        private renderSynopsis(): void {
                const synopsis = this.preview!.detail.synopsis;
                if (!synopsis) return;
                const section = this.section('Synopsis', 'align-left');
                section.createDiv({ cls: 'bfm-details-synopsis', text: synopsis });
        }

        /** Genres, themes and demographics as chips. */
        private renderTags(): void {
                const detail = this.preview!.detail;
                const chips: Array<{ text: string; cls: string }> = [
                        ...detail.genres.map((genre) => ({ text: genre, cls: 'is-genre' })),
                        ...detail.themes.map((theme) => ({ text: theme, cls: 'is-theme' })),
                        ...detail.demographics.map((demo) => ({ text: demo, cls: 'is-demo' })),
                ];
                if (chips.length === 0) return;
                const row = this.bodyEl.createDiv({ cls: 'bfm-details-chips' });
                for (const chip of chips) {
                        row.createSpan({ cls: `bfm-details-chip ${chip.cls}`, text: chip.text });
                }
        }

        private renderThemes(): void {
                const themes = this.preview!.themes;
                if (themes.length === 0) return;
                const openings = themes.filter((theme) => theme.kind === 'opening');
                const endings = themes.filter((theme) => theme.kind === 'ending');
                const other = themes.filter((theme) => theme.kind !== 'opening' && theme.kind !== 'ending');
                const section = this.section('Music', 'music');
                for (const [label, list] of [['Openings', openings], ['Endings', endings], ['Other', other]] as Array<[string, PreviewTheme[]]>) {
                        if (list.length === 0) continue;
                        section.createDiv({ cls: 'bfm-details-subtitle', text: `${label} (${list.length})` });
                        const ul = section.createEl('ul', { cls: 'bfm-details-music' });
                        for (const theme of list) {
                                const li = ul.createEl('li');
                                li.createSpan({ cls: 'bfm-details-music-title', text: theme.title ?? 'Unknown' });
                                if (theme.artist) li.createSpan({ cls: 'bfm-details-music-artist', text: ` — ${theme.artist}` });
                                if (theme.episodes) li.createSpan({ cls: 'bfm-details-music-eps', text: ` (${theme.episodes})` });
                        }
                }
        }

        private renderCast(): void {
                const characters = this.preview!.characters;
                if (characters.length === 0) return;
                const section = this.section('Cast', 'users');
                const grid = section.createDiv({ cls: 'bfm-details-cast' });
                // Main characters first, then by favourites, so the leads are on top.
                const sorted = [...characters].sort((left, right) => {
                        const leftMain = left.role === 'Main' ? 1 : 0;
                        const rightMain = right.role === 'Main' ? 1 : 0;
                        if (leftMain !== rightMain) return rightMain - leftMain;
                        return (right.favorites ?? 0) - (left.favorites ?? 0);
                });
                for (const character of sorted.slice(0, 18)) {
                        this.renderCharacterCard(grid, character);
                }
        }

        private renderCharacterCard(grid: HTMLElement, character: PreviewCharacter): void {
                const card = grid.createDiv({ cls: 'bfm-details-cast-card' });
                if (character.image) {
                        card.createEl('img', { cls: 'bfm-details-cast-image', attr: { src: character.image, alt: '', loading: 'lazy' } });
                } else {
                        const placeholder = card.createDiv({ cls: 'bfm-details-cast-image is-placeholder' });
                        setIcon(placeholder, 'user');
                }
                const info = card.createDiv({ cls: 'bfm-details-cast-info' });
                info.createDiv({ cls: 'bfm-details-cast-name', text: character.name ?? 'Unknown' });
                if (character.role) info.createDiv({ cls: 'bfm-details-cast-role', text: character.role });
                // The Japanese voice actor is the one MAL records for each character.
                const voice = character.voiceActors.find((actor) => actor.language === 'Japanese') ?? character.voiceActors[0];
                if (voice?.name) info.createDiv({ cls: 'bfm-details-cast-voice', text: voice.name });
        }

        private renderStaff(): void {
                const staff = this.preview!.staff;
                if (staff.length === 0) return;
                const section = this.section('Staff', 'briefcase');
                const list = section.createDiv({ cls: 'bfm-details-staff' });
                for (const member of staff.slice(0, 12)) {
                        const row = list.createDiv({ cls: 'bfm-details-staff-row' });
                        row.createSpan({ cls: 'bfm-details-staff-name', text: member.name ?? 'Unknown' });
                        if (member.role) row.createSpan({ cls: 'bfm-details-staff-role', text: member.role });
                }
        }

        /** Studios, producers and licensors. */
        private renderRelations(): void {
                const detail = this.preview!.detail;
                const groups: Array<[string, typeof detail.studios]> = [
                        ['Studios', detail.studios],
                        ['Producers', detail.producers],
                        ['Licensors', detail.licensors],
                ];
                const rows = groups.filter(([, list]) => list.length > 0);
                if (rows.length === 0) return;
                const section = this.section('Production', 'building');
                for (const [label, list] of rows) {
                        const row = section.createDiv({ cls: 'bfm-details-company-row' });
                        row.createSpan({ cls: 'bfm-details-company-label', text: label });
                        row.createSpan({ cls: 'bfm-details-company-list', text: list.map((company) => company.name).join(', ') });
                }
                if (detail.relations.length > 0) {
                        const related = section.createDiv({ cls: 'bfm-details-company-row' });
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

        /** Streaming and external links, and the download action. */
        private renderLinks(): void {
                const detail = this.preview!.detail;
                const section = this.section('Links', 'link');
                if (detail.streaming.length > 0) {
                        const row = section.createDiv({ cls: 'bfm-details-link-row' });
                        row.createSpan({ cls: 'bfm-details-company-label', text: 'Streaming' });
                        const list = row.createSpan({ cls: 'bfm-details-company-list' });
                        detail.streaming.slice(0, 6).forEach((link, index) => {
                                if (index > 0) list.createSpan({ text: ', ' });
                                const anchor = list.createEl('a', { text: link.name ?? 'link' });
                                anchor.href = link.url ?? '#';
                                anchor.setAttr('target', '_blank');
                                anchor.setAttr('rel', 'noopener');
                        });
                }
                if (detail.url) {
                        const row = section.createDiv({ cls: 'bfm-details-link-row' });
                        row.createSpan({ cls: 'bfm-details-company-label', text: 'MyAnimeList' });
                        const anchor = row.createEl('a', { text: detail.url });
                        anchor.href = detail.url;
                        anchor.setAttr('target', '_blank');
                        anchor.setAttr('rel', 'noopener');
                }
                if (this.callbacks.onDownload) {
                        const actions = section.createDiv({ cls: 'bfm-details-actions' });
                        const button = actions.createEl('button', { cls: 'mod-cta', text: 'Download episodes' });
                        button.addEventListener('click', () => {
                                this.callbacks.onDownload?.(this.options.series);
                                this.close();
                        });
                }
        }

        /** The recommendation list, rendered on its own so it can update late. */
        private renderRecommendations(): void {
                let host = this.bodyEl.querySelector<HTMLElement>('.bfm-details-recommendations');
                if (!host) {
                        host = this.bodyEl.createDiv({ cls: 'bfm-details-recommendations' });
                }
                host.empty();
                if (!this.options.loadRecommendations) return;

                const header = host.createDiv({ cls: 'bfm-details-section-title' });
                setIcon(header.createSpan({ cls: 'bfm-details-section-icon' }), 'sparkles');
                header.createSpan({ text: 'Recommended for you' });

                if (this.recommendationsLoading) {
                        host.createDiv({ cls: 'bfm-details-hint', text: 'Finding recommendations…' });
                        return;
                }
                if (this.recommendations.length === 0) {
                        host.createDiv({
                                cls: 'bfm-details-hint',
                                text: 'No recommendations yet. Download a few series and they will show up here.',
                        });
                        return;
                }
                const grid = host.createDiv({ cls: 'bfm-details-rec-grid' });
                for (const item of this.recommendations) {
                        const card = grid.createDiv({ cls: 'bfm-details-rec-card' });
                        card.setAttribute('role', 'button');
                        card.setAttribute('tabindex', '0');
                        card.setAttribute('aria-label', `${item.title} — ${describeBecause(item)}`);

                        // The poster is what makes the section scannable: a column
                        // of titles with a reason each reads as a list of claims,
                        // while a card with artwork reads as a shelf.
                        const poster = card.createDiv({ cls: 'bfm-details-rec-poster' });
                        if (item.image) {
                                poster.createEl('img', {
                                        cls: 'bfm-details-rec-poster-image',
                                        attr: { src: item.image, alt: '', loading: 'lazy' },
                                });
                        } else {
                                setIcon(poster.createDiv({ cls: 'bfm-details-rec-poster-placeholder' }), 'film');
                        }

                        const body = card.createDiv({ cls: 'bfm-details-rec-body' });
                        body.createDiv({ cls: 'bfm-details-rec-title', text: item.title });
                        body.createDiv({ cls: 'bfm-details-rec-why', text: describeBecause(item) });

                        const open = (): void => {
                                this.callbacks.onOpenRecommendation?.(item.title);
                                new Notice(`Searching for ${item.title}...`);
                                this.close();
                        };
                        card.addEventListener('click', open);
                        card.addEventListener('keydown', (event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') return;
                                event.preventDefault();
                                open();
                        });
                }
        }

        /** A titled section with an icon. */
        private section(title: string, icon: string): HTMLElement {
                const section = this.bodyEl.createDiv({ cls: 'bfm-details-section' });
                const header = section.createDiv({ cls: 'bfm-details-section-title' });
                setIcon(header.createSpan({ cls: 'bfm-details-section-icon' }), icon);
                header.createSpan({ text: title });
                return section;
        }
}

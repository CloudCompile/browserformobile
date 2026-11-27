import { App, Modal, setIcon } from 'obsidian';
import { createCover } from './covers';
import {
        ADULT_PROVIDER,
        browseGenre,
        browseSection,
        loadGenres,
        type GenreRef,
        type SeriesSummary,
} from './animeApi';

/** A listing section the API exposes as its own route. */
interface Section {
        id: string;
        name: string;
        description: string;
        icon: string;
}

const NATIVE_SECTIONS: Section[] = [
        { id: 'most-popular', name: 'Most popular', description: 'What everyone is watching', icon: 'flame' },
        { id: 'top-airing', name: 'Top airing', description: 'Currently releasing', icon: 'trending-up' },
        { id: 'top-upcoming', name: 'Top upcoming', description: 'Not out yet', icon: 'calendar-clock' },
        { id: 'recently-added', name: 'Recently added', description: 'New in the catalogue', icon: 'sparkles' },
        { id: 'completed', name: 'Completed', description: 'Binge from start to finish', icon: 'circle-check' },
        { id: 'movie', name: 'Movies', description: 'Feature-length titles', icon: 'film' },
        { id: 'tv', name: 'TV series', description: 'Multi-episode shows', icon: 'tv' },
        { id: 'ova', name: 'OVA', description: 'Bonus episodes and side stories', icon: 'disc' },
        { id: 'ona', name: 'ONA', description: 'Made for streaming', icon: 'globe' },
        { id: 'special', name: 'Specials', description: 'One-off episodes', icon: 'star' },
];

const ADULT_SECTIONS: Section[] = [
        { id: 'monthly', name: 'Monthly releases', description: 'Newest additions', icon: 'calendar-clock' },
        { id: 'series', name: 'All series', description: 'Every title on the source', icon: 'layout-grid' },
];

type View = 'sections' | 'genres' | 'browse';

/**
 * Where the finder was left, so reopening it lands back on the same listing
 * instead of the top of the catalogue every time. Deliberately navigation
 * only — the titles themselves reload from the (cached) API.
 */
export interface PersistedFinderState {
        /** Active source: `undefined` is the catalogue, or the 18+ provider. */
        source?: string;
        view: View;
        sectionId: string | null;
        sectionName: string;
        genreSlug: string | null;
        page: number;
        /**
         * The 18+ opt-in as it stood. Restoring the adult source is gated on it,
         * so a listing from that source only ever comes back when the opt-in
         * comes back with it.
         */
        adultOptIn: boolean;
}

export interface FindModalOptions {
        apiBase: string;
        /** Open a title in the downloader, carrying its source. */
        onOpenSeries(series: SeriesSummary): void;
        /** Where the finder was left last time, if anywhere. */
        initialState?: PersistedFinderState;
        /** Called whenever the visible place changes, to persist it. */
        onStateChange?(state: PersistedFinderState): void;
}

/**
 * Browse the catalogue without searching: pick a listing section or a genre and
 * page through the titles. The 18+ source has the same shape (its own sections
 * and genre pages) and is offered as a second tab once it is switched on, the
 * same opt-in the downloader's search uses.
 */
export class FindModal extends Modal {
        private includeAdult = false;
        private source: string | undefined;
        private view: View = 'sections';
        private sectionId: string | null = null;
        private sectionName = '';
        private genreSlug: string | null = null;
        private page = 1;
        private totalPages = 1;
        private series: SeriesSummary[] = [];
        private genres: GenreRef[] = [];
        private busy = false;
        /** A failed load, kept so the page can offer a retry instead of an empty grid. */
        private error: string | null = null;
        private bodyEl!: HTMLElement;

        constructor(
                app: App,
                private readonly options: FindModalOptions,
        ) {
                super(app);
                this.modalEl.addClass('bfm-find-modal');
        }

        onOpen(): void {
                this.titleEl.setText('Find anime');
                this.contentEl.empty();
                this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-find-body' });
                this.restoreState();
                this.render();
                // A restored deep view reloads its listing; the sections view is
                // already on screen after render().
                if (this.view === 'browse') void this.load();
                else if (this.view === 'genres') void this.loadGenreList();
        }

        /** Apply the persisted state, with the 18+ gate re-checked. */
        private restoreState(): void {
                const state = this.options.initialState;
                if (!state) return;
                this.includeAdult = state.adultOptIn === true;
                this.view = state.view === 'genres' || state.view === 'browse' ? state.view : 'sections';
                this.sectionId = typeof state.sectionId === 'string' ? state.sectionId : null;
                this.sectionName = typeof state.sectionName === 'string' ? state.sectionName : '';
                this.genreSlug = typeof state.genreSlug === 'string' ? state.genreSlug : null;
                this.page = typeof state.page === 'number' && Number.isFinite(state.page) && state.page > 0 ? Math.floor(state.page) : 1;
                // The same rule the opt-in checkbox applies: an 18+ source without
                // the opt-in falls back to the catalogue.
                this.source = state.source && this.includeAdult ? state.source : undefined;
        }

        /** The state as it is on screen, for the caller to persist. */
        private snapshot(): PersistedFinderState {
                return {
                        source: this.source,
                        view: this.view,
                        sectionId: this.sectionId,
                        sectionName: this.sectionName,
                        genreSlug: this.genreSlug,
                        page: this.page,
                        adultOptIn: this.includeAdult,
                };
        }

        onClose(): void {
                this.contentEl.empty();
        }

        private sections(): Section[] {
                return this.source === ADULT_PROVIDER ? ADULT_SECTIONS : NATIVE_SECTIONS;
        }

        private render(): void {
                this.bodyEl.empty();
                this.renderSourceTabs();
                const content = this.bodyEl.createDiv({ cls: 'bfm-find-content' });
                content.setAttribute('aria-busy', this.busy ? 'true' : 'false');
                if (this.view === 'sections') this.renderSections(content);
                else if (this.view === 'genres') this.renderGenres(content);
                else this.renderBrowse(content);
                // Persist where the user is after every visible change; the
                // caller decides how to store it.
                this.options.onStateChange?.(this.snapshot());
        }

        private renderSourceTabs(): void {
                const bar = this.bodyEl.createDiv({ cls: 'bfm-find-bar' });
                const tabs = bar.createDiv({ cls: 'bfm-find-tabs', attr: { role: 'tablist', 'aria-label': 'Source' } });
                const sources: { id: string | undefined; name: string }[] = [{ id: undefined, name: 'Catalogue' }];
                if (this.includeAdult) sources.push({ id: ADULT_PROVIDER, name: '18+' });
                for (const entry of sources) {
                        const active = this.source === entry.id;
                        const button = tabs.createEl('button', {
                                cls: 'bfm-find-tab',
                                text: entry.name,
                                attr: {
                                        type: 'button',
                                        role: 'tab',
                                        'aria-selected': active ? 'true' : 'false',
                                },
                        });
                        if (active) button.addClass('is-active');
                        button.addEventListener('click', () => {
                                if (this.source === entry.id) return;
                                this.source = entry.id;
                                this.resetToSections();
                                this.render();
                        });
                }

                const label = bar.createEl('label', { cls: 'bfm-find-adult' });
                if (this.includeAdult) label.addClass('is-on');
                const checkbox = label.createEl('input', {
                        attr: { type: 'checkbox', 'aria-label': 'Show 18+ titles' },
                });
                checkbox.checked = this.includeAdult;
                label.createSpan({ text: 'Show 18+' });
                checkbox.addEventListener('change', () => {
                        this.includeAdult = checkbox.checked;
                        // Leaving the 18+ source on screen after switching the opt-in off
                        // would keep serving adult listings, so fall back to the catalogue.
                        if (!this.includeAdult && this.source === ADULT_PROVIDER) this.source = undefined;
                        this.resetToSections();
                        this.render();
                });
        }

        private resetToSections(): void {
                this.view = 'sections';
                this.sectionId = null;
                this.sectionName = '';
                this.genreSlug = null;
                this.genres = [];
                this.error = null;
                this.page = 1;
        }

        private renderSections(host: HTMLElement): void {
                const intro = host.createDiv({ cls: 'bfm-find-intro' });
                intro.createDiv({
                        cls: 'bfm-find-intro-title',
                        text: this.source === ADULT_PROVIDER ? 'Browse the 18+ source' : 'Browse the catalogue',
                });
                intro.createDiv({
                        cls: 'bfm-find-intro-text',
                        text: 'Pick a list to page through, or start from a genre. Titles open in the downloader.',
                });

                const list = host.createDiv({ cls: 'bfm-find-sections' });
                for (const section of this.sections()) {
                        this.renderSectionCard(list, section);
                }

                const entry = host.createEl('button', {
                        cls: 'bfm-find-genre-entry',
                        attr: { type: 'button', 'aria-label': 'Browse by genre' },
                });
                const icon = entry.createDiv({ cls: 'bfm-find-section-icon' });
                setIcon(icon, 'layout-grid');
                const copy = entry.createDiv({ cls: 'bfm-find-section-copy' });
                copy.createDiv({ cls: 'bfm-find-section-title', text: 'Browse by genre' });
                copy.createDiv({
                        cls: 'bfm-find-section-meta',
                        text: 'Action, romance, isekai and more',
                });
                const chevron = entry.createDiv({ cls: 'bfm-find-section-chevron' });
                setIcon(chevron, 'chevron-right');
                entry.addEventListener('click', () => {
                        this.view = 'genres';
                        this.error = null;
                        this.contentEl.scrollTop = 0;
                        void this.loadGenreList();
                });
        }

        private renderSectionCard(list: HTMLElement, section: Section): void {
                const card = list.createDiv({
                        cls: 'bfm-find-section',
                        attr: { role: 'button', tabindex: '0', 'aria-label': `Open ${section.name}` },
                });
                const icon = card.createDiv({ cls: 'bfm-find-section-icon' });
                setIcon(icon, section.icon);
                const copy = card.createDiv({ cls: 'bfm-find-section-copy' });
                copy.createDiv({ cls: 'bfm-find-section-title', text: section.name });
                copy.createDiv({ cls: 'bfm-find-section-meta', text: section.description });
                const chevron = card.createDiv({ cls: 'bfm-find-section-chevron' });
                setIcon(chevron, 'chevron-right');

                const open = () => {
                        this.sectionId = section.id;
                        this.sectionName = section.name;
                        this.genreSlug = null;
                        this.page = 1;
                        this.view = 'browse';
                        this.error = null;
                        this.contentEl.scrollTop = 0;
                        void this.load();
                };
                card.addEventListener('click', open);
                this.activateOnKey(card, open);
        }

        private async loadGenreList(): Promise<void> {
                if (this.genres.length > 0) {
                        this.render();
                        return;
                }
                this.busy = true;
                this.error = null;
                this.render();
                try {
                        this.genres = await loadGenres(this.options.apiBase, this.source);
                } catch {
                        this.genres = [];
                        this.error = 'Could not load genres.';
                } finally {
                        this.busy = false;
                        this.render();
                }
        }

        private renderGenres(host: HTMLElement): void {
                this.renderToolbar(host, {
                        title: 'Genres',
                        meta: this.busy ? 'Loading genres…' : `${this.genres.length} genres`,
                        adult: this.source === ADULT_PROVIDER,
                        back: () => {
                                this.view = 'sections';
                                this.error = null;
                                this.render();
                        },
                });

                if (this.busy) {
                        this.renderGenreSkeletons(host);
                        return;
                }
                if (this.error) {
                        this.renderState(host, {
                                icon: 'alert-triangle',
                                title: 'Could not load genres',
                                text: 'Check your connection and try again.',
                                action: 'Try again',
                                onAction: () => void this.loadGenreList(),
                        });
                        return;
                }
                if (this.genres.length === 0) {
                        this.renderState(host, {
                                icon: 'inbox',
                                title: 'No genres available',
                                text: 'This source has not published any genres yet.',
                                action: 'Try again',
                                onAction: () => void this.loadGenreList(),
                        });
                        return;
                }

                const list = host.createDiv({ cls: 'bfm-find-genres' });
                for (const genre of this.genres) {
                        const chip = list.createEl('button', {
                                cls: 'bfm-find-genre',
                                text: genre.name,
                                attr: { type: 'button' },
                        });
                        chip.addEventListener('click', () => {
                                this.genreSlug = genre.slug;
                                this.sectionName = genre.name;
                                this.sectionId = null;
                                this.page = 1;
                                this.view = 'browse';
                                this.error = null;
                                this.contentEl.scrollTop = 0;
                                void this.load();
                        });
                }
        }

        private renderBrowse(host: HTMLElement): void {
                const goBack = () => {
                        this.view = this.genreSlug ? 'genres' : 'sections';
                        this.error = null;
                        this.render();
                };
                this.renderToolbar(host, {
                        title: this.sectionName || 'Titles',
                        meta: this.busy
                                ? 'Loading titles…'
                                : `Page ${this.page} of ${this.totalPages} · ${this.series.length} titles`,
                        adult: this.source === ADULT_PROVIDER,
                        back: goBack,
                });

                if (this.busy) {
                        this.renderSkeletons(host);
                        return;
                }
                if (this.error) {
                        this.renderState(host, {
                                icon: 'alert-triangle',
                                title: 'Could not load this list',
                                text: 'Check your connection and try again.',
                                action: 'Try again',
                                onAction: () => void this.load(),
                        });
                        return;
                }
                if (this.series.length === 0) {
                        this.renderState(host, {
                                icon: 'inbox',
                                title: 'Nothing here yet',
                                text: 'This list has no titles right now. Try another section or check back later.',
                                action: 'Go back',
                                onAction: goBack,
                        });
                        return;
                }

                const grid = host.createDiv({ cls: 'bfm-find-grid' });
                for (const series of this.series) {
                        this.renderCard(grid, series);
                }
                this.renderPager(host);
        }

        private renderToolbar(
                host: HTMLElement,
                options: { title: string; meta: string; adult: boolean; back: () => void },
        ): void {
                const bar = host.createDiv({ cls: 'bfm-find-toolbar' });
                const back = bar.createEl('button', {
                        cls: 'bfm-find-back',
                        attr: { type: 'button', 'aria-label': 'Back' },
                });
                const backIcon = back.createSpan({ cls: 'bfm-find-back-icon' });
                setIcon(backIcon, 'chevron-left');
                back.createSpan({ text: 'Back' });
                back.addEventListener('click', options.back);

                const title = bar.createDiv({ cls: 'bfm-find-browse-title' });
                title.createDiv({ cls: 'bfm-find-heading', text: options.title });
                title.createDiv({ cls: 'bfm-find-browse-meta', text: options.meta, attr: { 'aria-live': 'polite' } });

                if (options.adult) bar.createSpan({ cls: 'bfm-find-source-chip', text: '18+' });
        }

        private renderCard(grid: HTMLElement, series: SeriesSummary): void {
                const title = series.title || series.id;
                const card = grid.createDiv({
                        cls: 'bfm-find-card',
                        attr: { role: 'button', tabindex: '0', 'aria-label': `Open ${title}` },
                });

                // A poster that is missing or refuses to load still leaves a card
                // with its title, badges and meta: the art is an enhancement.
                const poster = card.createDiv({ cls: 'bfm-find-poster-wrap' });
                createCover(poster, series.poster, title, {
                        imageClass: 'bfm-find-poster',
                        fallbackClass: 'bfm-find-poster-fallback',
                });

                const badges = poster.createDiv({ cls: 'bfm-find-badges' });
                if (series.showType && series.showType !== 'Unknown') {
                        badges.createSpan({ cls: 'bfm-find-badge', text: series.showType });
                }
                if (series.eps > 0) {
                        badges.createSpan({ cls: 'bfm-find-badge', text: `${series.eps} eps` });
                }
                if (series.adultContent) {
                        badges.createSpan({ cls: 'bfm-find-badge is-adult', text: '18+' });
                }

                const body = card.createDiv({ cls: 'bfm-find-card-body' });
                body.createDiv({ cls: 'bfm-find-card-title', text: title });
                const meta = this.cardMeta(series);
                if (meta) body.createDiv({ cls: 'bfm-find-card-meta', text: meta });

                const open = () => this.options.onOpenSeries(series);
                card.addEventListener('click', open);
                this.activateOnKey(card, open);
        }

        private cardMeta(series: SeriesSummary): string {
                const parts: string[] = [];
                if (series.eps > 0) parts.push(`${series.eps} episode${series.eps === 1 ? '' : 's'}`);
                if (series.dub > 0) parts.push(`${series.dub} dub`);
                if (series.sub > 0) parts.push(`${series.sub} sub`);
                return parts.join(' · ');
        }

        private renderPager(host: HTMLElement): void {
                const pager = host.createEl('nav', {
                        cls: 'bfm-find-pager',
                        attr: { 'aria-label': 'Pagination' },
                });

                const previous = pager.createEl('button', {
                        cls: 'bfm-find-pager-step',
                        attr: { type: 'button', 'aria-label': 'Previous page' },
                });
                const previousIcon = previous.createSpan({ cls: 'bfm-find-pager-icon' });
                setIcon(previousIcon, 'chevron-left');
                previous.createSpan({ text: 'Prev' });
                previous.disabled = this.page <= 1 || this.busy;
                previous.addEventListener('click', () => this.goToPage(this.page - 1));

                const status = pager.createSpan({ cls: 'bfm-find-pager-status' });
                status.createSpan({ text: 'Page ' });
                status.createEl('strong', { text: String(this.page) });
                status.createSpan({ text: ` of ${this.totalPages}` });

                const next = pager.createEl('button', {
                        cls: 'bfm-find-pager-step',
                        attr: { type: 'button', 'aria-label': 'Next page' },
                });
                next.createSpan({ text: 'Next' });
                const nextIcon = next.createSpan({ cls: 'bfm-find-pager-icon' });
                setIcon(nextIcon, 'chevron-right');
                next.disabled = this.page >= this.totalPages || this.busy;
                next.addEventListener('click', () => this.goToPage(this.page + 1));
        }

        private renderSkeletons(host: HTMLElement): void {
                const grid = host.createDiv({ cls: 'bfm-find-grid', attr: { 'aria-hidden': 'true' } });
                for (let index = 0; index < 10; index++) {
                        const card = grid.createDiv({ cls: 'bfm-find-skeleton' });
                        card.createDiv({ cls: 'bfm-find-skeleton-poster' });
                        card.createDiv({ cls: 'bfm-find-skeleton-line' });
                        card.createDiv({ cls: 'bfm-find-skeleton-line is-short' });
                }
        }

        private renderGenreSkeletons(host: HTMLElement): void {
                const list = host.createDiv({ cls: 'bfm-find-genres', attr: { 'aria-hidden': 'true' } });
                for (let index = 0; index < 14; index++) {
                        list.createSpan({ cls: 'bfm-find-genre-skeleton' });
                }
        }

        private renderState(
                host: HTMLElement,
                options: {
                        icon: string;
                        title: string;
                        text: string;
                        action: string;
                        onAction: () => void;
                },
        ): void {
                const state = host.createDiv({ cls: 'bfm-find-state' });
                const icon = state.createDiv({ cls: 'bfm-find-state-icon' });
                setIcon(icon, options.icon);
                state.createDiv({ cls: 'bfm-find-state-title', text: options.title });
                state.createDiv({ cls: 'bfm-find-state-text', text: options.text });
                const button = state.createEl('button', {
                        cls: 'mod-cta',
                        text: options.action,
                        attr: { type: 'button' },
                });
                button.addEventListener('click', options.onAction);
        }

        private activateOnKey(element: HTMLElement, action: () => void): void {
                element.addEventListener('keydown', (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        action();
                });
        }

        private goToPage(next: number): void {
                if (this.busy || next === this.page || next < 1 || next > this.totalPages) return;
                this.page = next;
                void this.load();
        }

        private async load(): Promise<void> {
                if (this.busy) return;
                this.busy = true;
                this.error = null;
                this.render();
                try {
                        const page = this.genreSlug
                                ? await browseGenre(this.options.apiBase, this.genreSlug, this.page, this.source)
                                : await browseSection(this.options.apiBase, this.sectionId ?? 'most-popular', this.page, this.source);
                        this.series = page.series;
                        this.totalPages = Math.max(1, page.totalPages);
                        this.page = page.page;
                } catch {
                        this.series = [];
                        this.totalPages = 1;
                        this.error = 'Could not load this list.';
                } finally {
                        this.busy = false;
                        if (!this.error) this.contentEl.scrollTop = 0;
                        this.render();
                }
        }
}

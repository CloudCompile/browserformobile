import { App, Modal } from 'obsidian';
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
}

const NATIVE_SECTIONS: Section[] = [
        { id: 'most-popular', name: 'Most popular' },
        { id: 'top-airing', name: 'Top airing' },
        { id: 'top-upcoming', name: 'Top upcoming' },
        { id: 'recently-added', name: 'Recently added' },
        { id: 'completed', name: 'Completed' },
        { id: 'movie', name: 'Movies' },
        { id: 'tv', name: 'TV series' },
        { id: 'ova', name: 'OVA' },
        { id: 'ona', name: 'ONA' },
        { id: 'special', name: 'Specials' },
];

const ADULT_SECTIONS: Section[] = [
        { id: 'monthly', name: 'Monthly releases' },
        { id: 'series', name: 'All series' },
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
                if (this.view === 'sections') this.renderSections();
                else if (this.view === 'genres') this.renderGenres();
                else this.renderBrowse();
                // Persist where the user is after every visible change; the
                // caller decides how to store it.
                this.options.onStateChange?.(this.snapshot());
        }

        private renderSourceTabs(): void {
                const tabs = this.bodyEl.createDiv({ cls: 'bfm-find-tabs' });
                const sources: { id: string | undefined; name: string }[] = [{ id: undefined, name: 'Catalogue' }];
                if (this.includeAdult) sources.push({ id: ADULT_PROVIDER, name: '18+' });
                for (const entry of sources) {
                        const button = tabs.createEl('button', { cls: 'bfm-find-tab', text: entry.name });
                        if (this.source === entry.id) button.addClass('is-active');
                        button.addEventListener('click', () => {
                                if (this.source === entry.id) return;
                                this.source = entry.id;
                                this.view = 'sections';
                                this.sectionId = null;
                                this.genreSlug = null;
                                this.genres = [];
                                this.render();
                        });
                }

                const label = tabs.createEl('label', { cls: 'bfm-find-adult' });
                const checkbox = label.createEl('input', { attr: { type: 'checkbox' } });
                checkbox.checked = this.includeAdult;
                label.createSpan({ text: '18+' });
                checkbox.addEventListener('change', () => {
                        this.includeAdult = checkbox.checked;
                        // Leaving the 18+ source on screen after switching the opt-in off
                        // would keep serving adult listings, so fall back to the catalogue.
                        if (!this.includeAdult && this.source === ADULT_PROVIDER) this.source = undefined;
                        this.view = 'sections';
                        this.sectionId = null;
                        this.genreSlug = null;
                        this.genres = [];
                        this.render();
                });
        }

        private renderSections(): void {
                const list = this.bodyEl.createDiv({ cls: 'bfm-find-sections' });
                for (const section of this.sections()) {
                        const card = list.createDiv({ cls: 'bfm-find-section' });
                        card.createDiv({ cls: 'bfm-find-section-title', text: section.name });
                        card.addEventListener('click', () => {
                                this.sectionId = section.id;
                                this.sectionName = section.name;
                                this.genreSlug = null;
                                this.page = 1;
                                this.view = 'browse';
                                void this.load();
                        });
                }

                const genreButton = this.bodyEl.createEl('button', {
                        cls: 'bfm-find-genre-link',
                        text: 'Browse by genre',
                });
                genreButton.addEventListener('click', () => {
                        this.view = 'genres';
                        void this.loadGenreList();
                });
        }

        private async loadGenreList(): Promise<void> {
                if (this.genres.length > 0) {
                        this.render();
                        return;
                }
                this.busy = true;
                this.render();
                try {
                        this.genres = await loadGenres(this.options.apiBase, this.source);
                } catch {
                        this.genres = [];
                } finally {
                        this.busy = false;
                        this.render();
                }
        }

        private renderGenres(): void {
                if (this.busy) {
                        this.bodyEl.createEl('p', { cls: 'bfm-find-hint', text: 'Loading genres…' });
                        return;
                }
                if (this.genres.length === 0) {
                        this.bodyEl.createEl('p', { cls: 'bfm-find-hint', text: 'No genres were available.' });
                        return;
                }
                const list = this.bodyEl.createDiv({ cls: 'bfm-find-genres' });
                for (const genre of this.genres) {
                        const chip = list.createEl('button', { cls: 'bfm-find-genre', text: genre.name });
                        chip.addEventListener('click', () => {
                                this.genreSlug = genre.slug;
                                this.sectionName = genre.name;
                                this.sectionId = null;
                                this.page = 1;
                                this.view = 'browse';
                                void this.load();
                        });
                }
        }

        private renderBrowse(): void {
                const header = this.bodyEl.createDiv({ cls: 'bfm-find-browse-header' });
                const back = header.createEl('button', { cls: 'bfm-find-back', text: 'Back' });
                back.addEventListener('click', () => {
                        this.view = this.genreSlug ? 'genres' : 'sections';
                        this.render();
                });
                header.createSpan({ cls: 'bfm-find-heading', text: this.sectionName });

                if (this.busy) {
                        this.bodyEl.createEl('p', { cls: 'bfm-find-hint', text: 'Loading titles…' });
                        return;
                }
                if (this.series.length === 0) {
                        this.bodyEl.createEl('p', { cls: 'bfm-find-hint', text: 'Nothing here yet.' });
                        return;
                }

                const grid = this.bodyEl.createDiv({ cls: 'bfm-find-grid' });
                for (const series of this.series) {
                        const card = grid.createDiv({ cls: 'bfm-find-card' });
                        if (series.poster) {
                                card.createEl('img', {
                                        cls: 'bfm-find-poster',
                                        attr: { src: series.poster, alt: '', loading: 'lazy' },
                                });
                        }
                        card.createDiv({ cls: 'bfm-find-card-title', text: series.title });
                        card.addEventListener('click', () => this.options.onOpenSeries(series));
                }

                const pager = this.bodyEl.createDiv({ cls: 'bfm-find-pager' });
                const prev = pager.createEl('button', { text: 'Prev' });
                prev.disabled = this.page <= 1 || this.busy;
                prev.addEventListener('click', () => {
                        if (this.page > 1) {
                                this.page--;
                                void this.load();
                        }
                });
                pager.createSpan({ text: `Page ${this.page} of ${this.totalPages}` });
                const next = pager.createEl('button', { text: 'Next' });
                next.disabled = this.page >= this.totalPages || this.busy;
                next.addEventListener('click', () => {
                        if (this.page < this.totalPages) {
                                this.page++;
                                void this.load();
                        }
                });
        }

        private async load(): Promise<void> {
                if (this.busy) return;
                this.busy = true;
                this.render();
                try {
                        const page = this.genreSlug
                                ? await browseGenre(this.options.apiBase, this.genreSlug, this.page, this.source)
                                : await browseSection(this.options.apiBase, this.sectionId ?? 'most-popular', this.page, this.source);
                        this.series = page.series;
                        this.totalPages = page.totalPages;
                        this.page = page.page;
                } catch {
                        this.series = [];
                        this.totalPages = 1;
                } finally {
                        this.busy = false;
                        this.render();
                }
        }
}

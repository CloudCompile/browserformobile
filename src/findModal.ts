import { App, Modal, setIcon } from 'obsidian';
import { createCover } from './covers';
import {
        ADULT_PROVIDER,
        AnimeApiError,
        browseGenre,
        browseSection,
        loadGenres,
        searchSeries,
        type BrowsePage,
        type GenreRef,
        type SeriesSummary,
} from './animeApi';
import {
        buildCards,
        filterGenres,
        pagerFor,
        pagerForBrowse,
        pagerLabel,
        type FinderCard,
        type PagerModel,
} from './finder';

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
        { id: 'recent', name: 'New episodes', description: 'Just added to the source', icon: 'sparkles' },
        { id: 'series', name: 'All series', description: 'Every title on the source', icon: 'layout-grid' },
];

type View = 'sections' | 'genres' | 'browse' | 'search';

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
        /** Last title search, so the box is filled in again. */
        query: string;
        page: number;
        /**
         * Legacy: the finder's own opt-in, before it became one plugin-wide
         * setting. Still read so an existing install keeps its adult tab.
         */
        adultOptIn?: boolean;
}

export interface FindModalOptions {
        apiBase: string;
        /** Open a title in the downloader, carrying its source. */
        onOpenSeries(series: SeriesSummary): void;
        /** Where the finder was left last time, if anywhere. */
        initialState?: PersistedFinderState;
        /** Called whenever the visible place changes, to persist it. */
        onStateChange?(state: PersistedFinderState): void;
        /** The plugin-wide 18+ opt-in, shared with the downloader's search. */
        adultOptIn?: boolean;
        /** Called when the opt-in is switched, so the plugin can persist it. */
        onAdultOptInChange?(enabled: boolean): void;
}

/** Which pager button should take focus after the next render. */
type PagerStep = 'prev' | 'next';

/** A score out of ten, printed without a pointless trailing zero. */
function formatRating(rating: number): string {
        return Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
}

/**
 * Browse the catalogue without searching: pick a listing section or a genre and
 * page through the titles, or search across both sources from the front page.
 * The 18+ source has the same shape (its own sections and genre pages) and is
 * offered as a second tab once the shared opt-in is on.
 */
export class FindModal extends Modal {
        private includeAdult: boolean;
        private source: string | undefined;
        private view: View = 'sections';
        private sectionId: string | null = null;
        private sectionName = '';
        private genreSlug: string | null = null;
        private query = '';
        private page = 1;
        private totalPages: number | null = null;
        private hasNextPage = false;
        private series: SeriesSummary[] = [];
        private genres: GenreRef[] = [];
        private busy = false;
        /** A failed load, kept so the page can offer a retry instead of an empty grid. */
        private error: string | null = null;
        /**
         * Every load takes a ticket; only the newest ticket may paint. Without
         * it, paging quickly left a slow answer for page 2 under the heading for
         * page 3 (and a source switch could be overwritten by the old source).
         */
        private requestSeq = 0;
        private pendingFocus: PagerStep | null = null;
        private bodyEl!: HTMLElement;

        constructor(
                app: App,
                private readonly options: FindModalOptions,
        ) {
                super(app);
                this.includeAdult =
                        options.adultOptIn === true || options.initialState?.adultOptIn === true;
                this.modalEl.addClass('bfm-find-modal');
        }

        onOpen(): void {
                this.titleEl.setText('Find anime');
                this.contentEl.empty();
                this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-find-body' });
                this.restoreState();
                // A restored deep view loads immediately, so open on skeletons
                // rather than flashing an empty state first.
                this.busy = this.view !== 'sections';
                this.render();
                if (this.view === 'browse' || this.view === 'search') void this.load();
                else if (this.view === 'genres') void this.loadGenreList();
        }

        /** Apply the persisted state, with the 18+ gate re-checked. */
        private restoreState(): void {
                const state = this.options.initialState;
                if (!state) return;
                this.view = state.view;
                this.sectionId = typeof state.sectionId === 'string' ? state.sectionId : null;
                this.sectionName = typeof state.sectionName === 'string' ? state.sectionName : '';
                this.genreSlug = typeof state.genreSlug === 'string' ? state.genreSlug : null;
                this.query = typeof state.query === 'string' ? state.query : '';
                this.page =
                        typeof state.page === 'number' && Number.isFinite(state.page) && state.page > 0
                                ? Math.floor(state.page)
                                : 1;
                // The same rule the opt-in checkbox applies: an 18+ source without
                // the opt-in falls back to the catalogue.
                this.source = state.source && this.includeAdult ? state.source : undefined;
                // A view whose destination is gone is the front page, not a blank
                // listing with no way back.
                if (this.view === 'browse' && !this.sectionId && !this.genreSlug) this.view = 'sections';
                if (this.view === 'search' && !this.query.trim()) this.view = 'sections';
        }

        /** The state as it is on screen, for the caller to persist. */
        private snapshot(): PersistedFinderState {
                return {
                        source: this.source,
                        view: this.view,
                        sectionId: this.sectionId,
                        sectionName: this.sectionName,
                        genreSlug: this.genreSlug,
                        query: this.query,
                        page: this.page,
                };
        }

        onClose(): void {
                this.cancelPending();
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
                const tabs = bar.createDiv({
                        cls: 'bfm-find-tabs',
                        attr: { role: 'tablist', 'aria-label': 'Source' },
                });
                const sources: { id: string | undefined; name: string }[] = [
                        { id: undefined, name: 'Catalogue' },
                ];
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
                checkbox.addEventListener('change', () => this.setAdultOptIn(checkbox.checked));
        }

        /**
         * Switch the shared 18+ opt-in.
         *
         * The same flag backs the downloader's search, so it is reported to the
         * plugin rather than kept in this modal's own saved state. Leaving the
         * source after switching it off would keep serving adult listings, so
         * that falls back to the catalogue.
         */
        private setAdultOptIn(enabled: boolean): void {
                if (this.includeAdult === enabled) return;
                this.includeAdult = enabled;
                this.options.onAdultOptInChange?.(enabled);
                if (!enabled && this.source === ADULT_PROVIDER) {
                        this.source = undefined;
                        this.resetToSections();
                        this.render();
                        return;
                }
                // A genre list belongs to the source that produced it.
                this.genres = [];
                if (this.view === 'browse' || this.view === 'search') {
                        this.page = 1;
                        this.render();
                        void this.load();
                } else if (this.view === 'genres') {
                        void this.loadGenreList();
                } else {
                        this.render();
                }
        }

        /** Stop an in-flight load from painting over whatever comes next. */
        private cancelPending(): void {
                this.requestSeq += 1;
                this.busy = false;
        }

        private resetToSections(): void {
                this.cancelPending();
                this.pendingFocus = null;
                this.view = 'sections';
                this.sectionId = null;
                this.sectionName = '';
                this.genreSlug = null;
                this.genres = [];
                this.series = [];
                this.error = null;
                this.totalPages = null;
                this.hasNextPage = false;
                this.page = 1;
        }

        private goToSections(): void {
                this.cancelPending();
                this.pendingFocus = null;
                this.view = 'sections';
                this.error = null;
                this.render();
        }

        private renderSections(host: HTMLElement): void {
                const intro = host.createDiv({ cls: 'bfm-find-intro' });
                intro.createDiv({
                        cls: 'bfm-find-intro-title',
                        text: this.source === ADULT_PROVIDER ? 'Browse the 18+ source' : 'Browse the catalogue',
                });
                intro.createDiv({
                        cls: 'bfm-find-intro-text',
                        text: 'Pick a list to page through, start from a genre, or search by title. Titles open in the downloader.',
                });

                this.renderSearchEntry(host);

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
                        this.cancelPending();
                        this.view = 'genres';
                        this.error = null;
                        this.contentEl.scrollTop = 0;
                        void this.loadGenreList();
                });
        }

        private renderSearchEntry(host: HTMLElement): void {
                const form = host.createEl('form', {
                        cls: 'bfm-find-search',
                        attr: { role: 'search' },
                });
                const input = form.createEl('input', {
                        cls: 'bfm-find-search-input',
                        attr: {
                                type: 'search',
                                placeholder: 'Search titles…',
                                'aria-label': 'Search titles',
                                enterkeyhint: 'search',
                        },
                });
                input.value = this.query;
                const submit = form.createEl('button', {
                        cls: 'bfm-find-search-submit',
                        attr: { type: 'submit' },
                });
                const icon = submit.createSpan({ cls: 'bfm-find-search-icon' });
                setIcon(icon, 'search');
                submit.createSpan({ text: 'Search' });
                form.addEventListener('submit', (event) => {
                        event.preventDefault();
                        const query = input.value.trim();
                        if (!query) {
                                input.focus();
                                return;
                        }
                        this.startSearch(query);
                });
        }

        private startSearch(query: string): void {
                this.cancelPending();
                this.pendingFocus = null;
                this.query = query;
                this.view = 'search';
                this.sectionId = null;
                this.sectionName = '';
                this.genreSlug = null;
                this.series = [];
                this.error = null;
                this.totalPages = null;
                this.hasNextPage = false;
                this.page = 1;
                this.contentEl.scrollTop = 0;
                void this.load();
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
                        this.cancelPending();
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
                const seq = ++this.requestSeq;
                this.busy = true;
                this.error = null;
                this.render();
                try {
                        const genres = await loadGenres(this.options.apiBase, this.source);
                        if (seq !== this.requestSeq) return;
                        this.genres = genres;
                } catch (error) {
                        if (seq !== this.requestSeq) return;
                        this.genres = [];
                        this.error = this.describeError(error, 'Could not load genres.');
                } finally {
                        if (seq === this.requestSeq) {
                                this.busy = false;
                                this.render();
                        }
                }
        }

        private renderGenres(host: HTMLElement): void {
                this.renderToolbar(host, {
                        title: 'Genres',
                        meta: this.busy ? 'Loading genres…' : `${this.genres.length} genres`,
                        adult: this.source === ADULT_PROVIDER,
                        back: () => this.goToSections(),
                });

                if (this.busy) {
                        this.renderGenreSkeletons(host);
                        return;
                }
                if (this.error) {
                        this.renderState(host, {
                                icon: 'alert-triangle',
                                title: 'Could not load genres',
                                text: this.error,
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

                const filter = host.createEl('label', { cls: 'bfm-find-filter' });
                const input = filter.createEl('input', {
                        attr: {
                                type: 'search',
                                placeholder: 'Filter genres…',
                                'aria-label': 'Filter genres',
                        },
                });
                const count = filter.createSpan({
                        cls: 'bfm-find-filter-count',
                        text: `${this.genres.length} genres`,
                });

                const list = host.createDiv({ cls: 'bfm-find-genres' });
                for (const genre of this.genres) {
                        const chip = list.createEl('button', {
                                cls: 'bfm-find-genre',
                                text: genre.name,
                                attr: { type: 'button', 'data-genre': genre.slug },
                        });
                        chip.addEventListener('click', () => {
                                this.cancelPending();
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
                const noMatches = host.createDiv({
                        cls: 'bfm-find-genre-empty',
                        text: 'No genres match that filter.',
                });
                noMatches.hidden = true;

                // Filtering toggles chips in place so typing never rebuilds the
                // list (and never loses the caret).
                input.addEventListener('input', () => {
                        const matches = filterGenres(this.genres, input.value);
                        const visible = new Set(matches.map((genre) => genre.slug));
                        let shown = 0;
                        for (const chip of Array.from(list.querySelectorAll<HTMLElement>('.bfm-find-genre'))) {
                                const match = visible.has(chip.dataset.genre ?? '');
                                chip.hidden = !match;
                                if (match) shown += 1;
                        }
                        count.setText(`${shown} of ${this.genres.length} genres`);
                        noMatches.hidden = shown > 0;
                });
        }

        private renderBrowse(host: HTMLElement): void {
                const searching = this.view === 'search';
                const goBack = () => (searching ? this.goToSections() : this.goBackFromBrowse());
                const cards = buildCards(this.series);
                const pager = searching
                        ? pagerFor(this.page, this.totalPages, this.hasNextPage)
                        : pagerForBrowse({
                                  series: this.series,
                                  totalPages: this.totalPages,
                                  page: this.page,
                                  hasNextPage: this.hasNextPage,
                              });
                const title = searching
                        ? `Results for “${this.query}”`
                        : this.sectionName || 'Titles';
                this.renderListing(host, {
                        title,
                        meta: this.busy
                                ? searching
                                        ? 'Searching…'
                                        : 'Loading titles…'
                                : `${cards.length} ${cards.length === 1 ? 'title' : 'titles'} · ${pagerLabel(pager)}`,
                        adult: !searching && this.source === ADULT_PROVIDER,
                        back: goBack,
                        cards,
                        pager,
                        empty: searching
                                ? {
                                          icon: 'search',
                                          title: 'No titles matched',
                                          text: 'Try a shorter title, or browse a section instead.',
                                          action: 'Clear search',
                                          onAction: () => {
                                                  this.query = '';
                                                  this.goToSections();
                                          },
                                  }
                                : {
                                          icon: 'inbox',
                                          title: 'Nothing here yet',
                                          text: 'This list has no titles right now. Try another section or check back later.',
                                          action: 'Go back',
                                          onAction: () => this.goBackFromBrowse(),
                                  },
                });
        }

        private goBackFromBrowse(): void {
                this.cancelPending();
                this.view = this.genreSlug ? 'genres' : 'sections';
                this.error = null;
                this.render();
                if (this.view === 'genres' && this.genres.length === 0) void this.loadGenreList();
        }

        private renderListing(
                host: HTMLElement,
                options: {
                        title: string;
                        meta: string;
                        adult: boolean;
                        back: () => void;
                        cards: FinderCard[];
                        pager: PagerModel;
                        empty: {
                                icon: string;
                                title: string;
                                text: string;
                                action: string;
                                onAction: () => void;
                        };
                },
        ): void {
                this.renderToolbar(host, {
                        title: options.title,
                        meta: options.meta,
                        adult: options.adult,
                        back: options.back,
                });

                if (this.busy) {
                        this.renderSkeletons(host);
                        return;
                }
                if (this.error) {
                        this.renderState(host, {
                                icon: 'alert-triangle',
                                title: 'Could not load this list',
                                text: this.error,
                                action: 'Try again',
                                onAction: () => void this.load(),
                        });
                        return;
                }
                if (options.cards.length === 0) {
                        this.renderState(host, options.empty);
                        return;
                }

                const grid = host.createDiv({ cls: 'bfm-find-grid' });
                for (const card of options.cards) this.renderCard(grid, card);
                this.renderPager(host, options.pager);
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
                title.createDiv({
                        cls: 'bfm-find-browse-meta',
                        text: options.meta,
                        attr: { 'aria-live': 'polite' },
                });

                if (options.adult) bar.createSpan({ cls: 'bfm-find-source-chip', text: '18+' });
        }

        private renderCard(grid: HTMLElement, card: FinderCard): void {
                const series = card.series;
                const title = series.title || series.id;
                const element = grid.createDiv({
                        cls: 'bfm-find-card',
                        attr: { role: 'button', tabindex: '0', 'aria-label': `Open ${title}` },
                });

                // A poster that is missing or refuses to load still leaves a card
                // with its title, badges and meta: the art is an enhancement.
                const poster = element.createDiv({ cls: 'bfm-find-poster-wrap' });
                createCover(poster, series.poster, title, {
                        imageClass: 'bfm-find-poster',
                        fallbackClass: 'bfm-find-poster-fallback',
                });

                const badges = poster.createDiv({ cls: 'bfm-find-badges' });
                const rating = series.rating;
                if (typeof rating === 'number' && rating > 0) {
                        const printed = formatRating(rating);
                        badges.createSpan({
                                cls: 'bfm-find-badge is-rating',
                                text: `★ ${printed}`,
                                attr: { 'aria-label': `Rated ${printed} out of 10` },
                        });
                }
                if (card.episodeNumber !== null) {
                        // The feed's own rows all say "Episode"; the number is the
                        // useful part, and the series type is not known here anyway.
                        badges.createSpan({ cls: 'bfm-find-badge', text: `Ep ${card.episodeNumber}` });
                } else if (series.showType && series.showType !== 'Unknown') {
                        badges.createSpan({ cls: 'bfm-find-badge', text: series.showType });
                }
                if (card.episodeNumber === null && series.eps > 0) {
                        badges.createSpan({ cls: 'bfm-find-badge', text: `${series.eps} eps` });
                }
                if (series.adultContent) {
                        badges.createSpan({ cls: 'bfm-find-badge is-adult', text: '18+' });
                }

                const body = element.createDiv({ cls: 'bfm-find-card-body' });
                body.createDiv({ cls: 'bfm-find-card-title', text: title });
                const meta = this.cardMeta(card);
                if (meta) body.createDiv({ cls: 'bfm-find-card-meta', text: meta });

                const open = () => this.options.onOpenSeries(series);
                element.addEventListener('click', open);
                this.activateOnKey(element, open);
        }

        private cardMeta(card: FinderCard): string {
                const series = card.series;
                const parts: string[] = [];
                if (card.episodeNumber !== null) {
                        // Episode counts on a feed row are absent, and the row's
                        // "type" is the word Episode; the merge count is the fact
                        // this card can actually report.
                        if (card.episodes > 1) parts.push(`${card.episodes} new episodes`);
                } else {
                        if (series.eps > 0) parts.push(`${series.eps} episode${series.eps === 1 ? '' : 's'}`);
                        if (series.dub > 0) parts.push(`${series.dub} dub`);
                        if (series.sub > 0) parts.push(`${series.sub} sub`);
                }
                return parts.join(' · ');
        }

        private renderPager(host: HTMLElement, pager: PagerModel): void {
                if (!pager.visible) return;
                const nav = host.createEl('nav', {
                        cls: 'bfm-find-pager',
                        attr: { 'aria-label': 'Pagination' },
                });

                const previous = nav.createEl('button', {
                        cls: 'bfm-find-pager-step',
                        attr: { type: 'button', 'aria-label': 'Previous page', 'data-find-step': 'prev' },
                });
                const previousIcon = previous.createSpan({ cls: 'bfm-find-pager-icon' });
                setIcon(previousIcon, 'chevron-left');
                previous.createSpan({ text: 'Prev' });
                previous.disabled = !pager.hasPrevious;
                previous.addEventListener('click', () => this.goToPage(pager.page - 1, 'prev'));

                const status = nav.createSpan({ cls: 'bfm-find-pager-status' });
                status.createSpan({ text: 'Page ' });
                status.createEl('strong', { text: String(pager.page) });
                if (pager.totalPages !== null) {
                        status.createSpan({ text: ` of ${pager.totalPages}` });
                }

                const next = nav.createEl('button', {
                        cls: 'bfm-find-pager-step',
                        attr: { type: 'button', 'aria-label': 'Next page', 'data-find-step': 'next' },
                });
                next.createSpan({ text: 'Next' });
                const nextIcon = next.createSpan({ cls: 'bfm-find-pager-icon' });
                setIcon(nextIcon, 'chevron-right');
                next.disabled = !pager.hasNext;
                next.addEventListener('click', () => this.goToPage(pager.page + 1, 'next'));

                // Paging rebuilds the page (skeletons, then the answer), so the
                // button that had focus no longer exists. Put it back on the same
                // control, without scrolling away from the new page's top.
                const step = this.pendingFocus;
                this.pendingFocus = null;
                if (!step) return;
                const preferred = step === 'next' ? next : previous;
                const fallback = step === 'next' ? previous : next;
                if (!preferred.disabled) preferred.focus({ preventScroll: true });
                else if (!fallback.disabled) fallback.focus({ preventScroll: true });
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

        private goToPage(next: number, focus: PagerStep): void {
                if (next === this.page) return;
                if (next > this.page && !this.hasNextPage) return;
                if (next < 1) return;
                this.page = next;
                this.pendingFocus = focus;
                this.contentEl.scrollTop = 0;
                void this.load();
        }

        /** Turn a thrown error into the sentence the page shows. */
        private describeError(error: unknown, fallback: string): string {
                return error instanceof AnimeApiError && error.message ? error.message : fallback;
        }

        /**
         * Load the page on screen. Every call supersedes the last one instead of
         * being dropped while busy, so paging never silently ignores a tap, and
         * only the newest answer paints.
         */
        private async load(): Promise<void> {
                const seq = ++this.requestSeq;
                this.busy = true;
                this.error = null;
                this.render();
                try {
                        let answer: BrowsePage;
                        if (this.view === 'search') {
                                const result = await searchSeries(this.options.apiBase, this.query, {
                                        page: this.page,
                                        includeAdult: this.includeAdult,
                                });
                                const totalPages = Math.max(1, result.totalPages);
                                // A restored page can outlive the result set that
                                // produced it; the API serves the last real page,
                                // so the pager must show that page, not the one
                                // that was asked for.
                                const page = Math.min(this.page, totalPages);
                                answer = {
                                        series: result.series,
                                        totalPages,
                                        page,
                                        hasNextPage: page < totalPages && result.series.length > 0,
                                };
                        } else if (this.genreSlug) {
                                answer = await browseGenre(
                                        this.options.apiBase,
                                        this.genreSlug,
                                        this.page,
                                        this.source,
                                );
                        } else {
                                answer = await browseSection(
                                        this.options.apiBase,
                                        this.sectionId ?? 'most-popular',
                                        this.page,
                                        this.source,
                                );
                        }
                        if (seq !== this.requestSeq) return;
                        this.series = answer.series;
                        this.page = answer.page;
                        this.totalPages = answer.totalPages;
                        this.hasNextPage = answer.hasNextPage;
                } catch (error) {
                        if (seq !== this.requestSeq) return;
                        this.series = [];
                        this.totalPages = null;
                        this.hasNextPage = false;
                        this.error = this.describeError(error, 'Could not load this list.');
                } finally {
                        if (seq === this.requestSeq) {
                                this.busy = false;
                                this.contentEl.scrollTop = 0;
                                this.render();
                        }
                }
        }
}

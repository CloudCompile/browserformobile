import { App, Modal, Notice, setIcon } from 'obsidian';
import {
        ADULT_PROVIDER,
        loadSeriesDetails,
        type AnimePreview,
        type SeriesDetails,
        type SeriesSummary,
} from './animeApi';
import type { Recommendation } from './recommend';
import { describeBecause } from './recommendService';
import { factsFor, renderHero, renderPreviewBlocks, section } from './seriesDetails';

export interface DetailsCallbacks {
        /**
         * Queue a series through the downloader. The summary carries the source
         * and id, so a title from the 18+ catalogue opens its own provider page
         * instead of a native search that would never find it. `search` is true
         * when the catalogue id was not real (the details came only from the
         * MyAnimeList mirror), in which case the downloader should search by
         * title instead.
         */
        onDownload?(series: SeriesSummary, search: boolean): void;
        /** Open the details page for a recommended title. */
        onOpenRecommendation?(title: string): void;
        onClosed?(): void;
}

export interface DetailsModalOptions {
        /** Series name or id to load. */
        series: string;
        /** Base URL of the anime API, from the plugin settings. */
        apiBase: string;
        /**
         * Source the series belongs to, when the caller knows it. The 18+ source
         * has no MyAnimeList record, so its details come from its own provider
         * route; without this the page falls back to a title search.
         */
        provider?: string;
        /**
         * The kept details answer from the metadata store, when the series was
         * browsed before. The page paints from it immediately and corrects
         * itself if the background refresh differs — airplane mode included.
         */
        initialPreview?: AnimePreview | null;
        /** Called when recommendations should be produced for this series. */
        loadRecommendations?: (seed: string) => Promise<Recommendation[]>;
}

/**
 * The full details page for a series.
 *
 * One page for both sources: the native catalogue's MyAnimeList record when it
 * exists, and the 18+ provider's structured details mapped into the same shape
 * when it does not. The 18+ provider's generated blurb — the same sentence on
 * every series — is never shown; the facts grid and the source's own episode
 * list carry the real information.
 *
 * Blocks are rendered only when they have content, because a title with no
 * themes or no trailer is normal and an empty heading reads like a bug.
 */
export class DetailsModal extends Modal {
        private details: SeriesDetails | null = null;
        private preview: AnimePreview | null = null;
        private loading = true;
        private failed: string | null = null;
        /** Serialized form of what the last render painted from. */
        private renderedPreview: string | null = null;
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
                // Stale-while-revalidate: a series browsed before paints from
                // the kept copy in the first frame, and the load below only
                // replaces it when the catalogue actually moved on. A series
                // with no kept copy behaves exactly as before — a spinner and
                // the same error surface when the API is unreachable.
                if (this.options.initialPreview) {
                        this.preview = this.options.initialPreview;
                        this.loading = false;
                }
                this.render();
                void this.load();
        }

        onClose(): void {
                this.contentEl.empty();
                this.callbacks.onClosed?.();
        }

        private async load(): Promise<void> {
                try {
                        this.details = await loadSeriesDetails(this.options.apiBase, this.options.series, {
                                provider: this.options.provider,
                        });
                        this.preview = this.details.preview;
                } catch (error) {
                        // A kept copy is already on screen; an unreachable API
                        // only matters when there was nothing to show.
                        if (!this.preview) this.failed = error instanceof Error ? error.message : 'Could not load details.';
                } finally {
                        this.loading = false;
                        // Re-render only when the fresh answer differs from the
                        // one painted from the store — the common case is the
                        // same payload fetched again.
                        const serialized = this.preview ? JSON.stringify(this.preview) : null;
                        if (serialized !== this.renderedPreview) {
                                this.renderedPreview = serialized;
                                this.render();
                        }
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
                // What the last render painted from, so a background refresh
                // that fetched identical content does not repaint the page.
                this.renderedPreview = this.preview ? JSON.stringify(this.preview) : null;
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
                renderHero(this.bodyEl, {
                        poster: detail.image,
                        title: detail.title ?? this.options.series,
                        subtitle: detail.titleJapanese,
                        adult: this.isAdult(),
                        facts: factsFor(detail),
                });
                renderPreviewBlocks(this.bodyEl, this.preview);
                this.renderDownloadAction();
                this.renderRecommendations();
        }

        /** True when the details came from the opt-in 18+ source. */
        private isAdult(): boolean {
                return (
                        this.details?.info.adultContent === true ||
                        this.preview?.source === ADULT_PROVIDER
                );
        }

        /** The download hand-off, carrying the source and id with the title. */
        private renderDownloadAction(): void {
                if (!this.callbacks.onDownload) return;
                const actions = section(this.bodyEl, 'Download', 'download');
                const row = actions.createDiv({ cls: 'bfm-details-actions' });
                const button = row.createEl('button', { cls: 'mod-cta', text: 'Download episodes' });
                button.addEventListener('click', () => {
                        this.callbacks.onDownload?.(this.seriesSummary(), !(this.details?.synthesized ?? false));
                        this.close();
                });
        }

        /** Build the summary the downloader opens straight to. */
        private seriesSummary(): SeriesSummary {
                const detail = this.preview?.detail;
                const info = this.details?.info;
                return {
                        id: info?.id ?? this.options.series,
                        title: detail?.title ?? info?.title ?? this.options.series,
                        japaneseTitle: detail?.titleJapanese ?? info?.japaneseTitle ?? null,
                        poster: detail?.image ?? info?.poster ?? null,
                        showType: detail?.type ?? info?.showType ?? 'TV',
                        sub: 0,
                        dub: 0,
                        eps: detail?.episodes ?? info?.episodeCount ?? 0,
                        adultContent: this.isAdult(),
                        provider: info?.provider,
                };
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
}

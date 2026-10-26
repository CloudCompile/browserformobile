import { App, Modal, Notice, setIcon } from 'obsidian';
import type { Recommendation } from './recommend';
import { describeBecause } from './recommendService';

/** What the page's loader hands back once the seeds have been mined. */
export interface RecommendationsResult {
        items: Recommendation[];
        /** Seeds that produced at least one candidate. */
        usedSeeds: string[];
        /** Seeds whose lookup failed, so the page can say the list is partial. */
        failedSeeds: string[];
}

export interface RecommendationsCallbacks {
        /**
         * Build the ranked list. `onProgress` reports the seed being mined and
         * `onResults` receives the list so far, so a long history can fill in
         * rather than leaving the page blank until every seed is read.
         */
        onLoad(
                progress: (done: number, total: number, seed: string) => void,
                onResults: (items: Recommendation[], done: number, total: number) => void,
        ): Promise<RecommendationsResult>;
        /** Open the full details page for a recommendation. */
        onDetails(title: string): void;
        /** Queue episodes for a recommendation through the downloader. */
        onDownload(title: string): void;
        onClosed?(): void;
}

/**
 * Recommendations built from the download history.
 *
 * The page is a poster grid rather than a list because the catalogue returns a
 * poster for every recommendation, and the reason a title is here ("because you
 * downloaded X") is the thing that makes the list trustworthy, so it is shown on
 * every card rather than hidden behind a click.
 *
 * Mining the seeds is slow — each one is a network round trip that fans out
 * upstream — so the page renders immediately and reports which seed it is on,
 * instead of blocking on a blank panel.
 */
export class RecommendationsModal extends Modal {
        private items: Recommendation[] = [];
        private usedSeeds: string[] = [];
        private failedSeeds: string[] = [];
        private loading = true;
        private failed: string | null = null;
        private progress: { done: number; total: number; seed: string } = { done: 0, total: 0, seed: '' };
        private bodyEl!: HTMLElement;
        /**
         * Bumped on every load. A late response from a superseded request is
         * dropped rather than overwriting the list the user just refreshed.
         */
        private requestId = 0;

        constructor(
                app: App,
                private readonly callbacks: RecommendationsCallbacks,
        ) {
                super(app);
                this.modalEl.addClass('bfm-recs-modal');
        }

        onOpen(): void {
                this.titleEl.setText('Recommended for you');
                this.contentEl.empty();
                this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-recs-body' });
                void this.load();
        }

        onClose(): void {
                this.requestId++;
                this.contentEl.empty();
                this.callbacks.onClosed?.();
        }

        private async load(): Promise<void> {
                const id = ++this.requestId;
                this.loading = true;
                this.failed = null;
                this.items = [];
                this.usedSeeds = [];
                this.failedSeeds = [];
                this.progress = { done: 0, total: 0, seed: '' };
                this.render();
                try {
                        const result = await this.callbacks.onLoad(
                                (done, total, seed) => {
                                        if (id !== this.requestId) return;
                                        this.progress = { done, total, seed };
                                        this.renderProgress();
                                },
                                (items, done, total) => {
                                        if (id !== this.requestId) return;
                                        // The list is only ever added to, so repainting on
                                        // each pass shows progress without losing the grid.
                                        this.items = items;
                                        this.progress = { ...this.progress, done, total };
                                        if (items.length > 0) this.render();
                                        else this.renderProgress();
                                },
                        );
                        if (id !== this.requestId) return;
                        this.items = result.items;
                        this.usedSeeds = result.usedSeeds;
                        this.failedSeeds = result.failedSeeds;
                } catch (error) {
                        if (id !== this.requestId) return;
                        this.failed = error instanceof Error ? error.message : 'Could not build recommendations.';
                } finally {
                        if (id === this.requestId) {
                                this.loading = false;
                                this.render();
                        }
                }
        }

        private render(): void {
                this.bodyEl.empty();
                this.renderHeader();

                if (this.loading) {
                        this.renderProgress();
                        // A long history arrives a seed at a time, so show what is
                        // already known underneath the progress bar rather than
                        // holding the whole page back for the last seed.
                        if (this.items.length > 0) this.renderGrid();
                        return;
                }
                if (this.failed) {
                        const empty = this.bodyEl.createDiv({ cls: 'bfm-recs-empty' });
                        setIcon(empty.createDiv({ cls: 'bfm-recs-empty-icon' }), 'alert-triangle');
                        empty.createDiv({ cls: 'bfm-recs-empty-text', text: this.failed });
                        return;
                }
                if (this.items.length === 0) {
                        this.renderEmpty();
                        return;
                }

                this.renderGrid();
                if (this.failedSeeds.length > 0) this.renderPartialNote();
        }

        /** The seed summary and the refresh control. */
        private renderHeader(): void {
                const bar = this.bodyEl.createDiv({ cls: 'bfm-recs-bar' });
                const summary = bar.createDiv({ cls: 'bfm-recs-summary' });
                if (this.loading) {
                        summary.setText('Reading your download history…');
                } else if (this.usedSeeds.length > 0) {
                        summary.setText(
                                this.usedSeeds.length === 1
                                        ? `Based on ${this.usedSeeds[0]}`
                                        : `Based on ${this.usedSeeds.length} series you have downloaded`,
                        );
                } else {
                        summary.setText('Based on your download history');
                }

                const refresh = bar.createEl('button', { cls: 'bfm-recs-refresh' });
                setIcon(refresh, 'refresh-cw');
                refresh.setAttribute('aria-label', 'Refresh recommendations');
                refresh.toggleClass('is-busy', this.loading);
                refresh.disabled = this.loading;
                refresh.addEventListener('click', () => void this.load());
        }

        /** Live progress, redrawn on its own so it does not disturb the header. */
        private renderProgress(): void {
                let host = this.bodyEl.querySelector<HTMLElement>('.bfm-recs-progress');
                if (!host) {
                        host = this.bodyEl.createDiv({ cls: 'bfm-recs-progress' });
                }
                host.empty();
                const label = this.progress.total > 0
                        ? `Finding recommendations… ${Math.min(this.progress.done + 1, this.progress.total)}/${this.progress.total}`
                        : 'Finding recommendations…';
                host.createDiv({ cls: 'bfm-recs-progress-text', text: label });
                if (this.progress.seed) {
                        host.createDiv({ cls: 'bfm-recs-progress-seed', text: this.progress.seed });
                }
                const track = host.createDiv({ cls: 'bfm-recs-progress-track' });
                const fraction = this.progress.total > 0 ? this.progress.done / this.progress.total : 0;
                track.createDiv({ cls: 'bfm-recs-progress-fill' }).setCssProps({
                        width: `${Math.round(fraction * 100)}%`,
                });
        }

        private renderEmpty(): void {
                const empty = this.bodyEl.createDiv({ cls: 'bfm-recs-empty' });
                setIcon(empty.createDiv({ cls: 'bfm-recs-empty-icon' }), 'sparkles');
                // Three different situations reach this state, and only one of them is
                // fixed by downloading more, so they must not share a message.
                let message: string;
                if (this.usedSeeds.length === 0 && this.failedSeeds.length > 0) {
                        message = 'None of your series could be read just now. Check your connection and refresh.';
                } else if (this.usedSeeds.length === 0) {
                        message = 'Download a few series and recommendations will appear here.';
                } else {
                        message = 'No new recommendations right now. Try refreshing in a little while.';
                }
                empty.createDiv({ cls: 'bfm-recs-empty-text', text: message });
                if (this.failedSeeds.length > 0 && this.usedSeeds.length > 0) this.renderPartialNote();
        }

        private renderGrid(): void {
                const grid = this.bodyEl.createDiv({ cls: 'bfm-recs-grid' });
                for (const item of this.items) {
                        this.renderCard(grid, item);
                }
        }

        private renderCard(grid: HTMLElement, item: Recommendation): void {
                const card = grid.createDiv({ cls: 'bfm-recs-card' });
                card.setAttribute('role', 'button');
                card.setAttribute('tabindex', '0');
                card.setAttribute('aria-label', `${item.title} — ${describeBecause(item)}`);

                const poster = card.createDiv({ cls: 'bfm-recs-poster' });
                if (item.image) {
                        poster.createEl('img', {
                                cls: 'bfm-recs-poster-image',
                                attr: { src: item.image, alt: '', loading: 'lazy' },
                        });
                } else {
                        const placeholder = poster.createDiv({ cls: 'bfm-recs-poster-placeholder' });
                        setIcon(placeholder, 'film');
                }

                const body = card.createDiv({ cls: 'bfm-recs-card-body' });
                body.createDiv({ cls: 'bfm-recs-card-title', text: item.title });
                body.createDiv({ cls: 'bfm-recs-card-why', text: describeBecause(item) });

                const actions = body.createDiv({ cls: 'bfm-recs-card-actions' });
                const details = actions.createEl('button', { cls: 'bfm-recs-card-action', text: 'Details' });
                details.addEventListener('click', (event) => {
                        event.stopPropagation();
                        this.callbacks.onDetails(item.title);
                });
                const download = actions.createEl('button', {
                        cls: 'bfm-recs-card-action mod-cta',
                        text: 'Download',
                });
                download.addEventListener('click', (event) => {
                        event.stopPropagation();
                        this.callbacks.onDownload(item.title);
                        new Notice(`Opening the downloader for ${item.title}…`);
                        this.close();
                });

                card.addEventListener('click', () => this.callbacks.onDetails(item.title));
                card.addEventListener('keydown', (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        this.callbacks.onDetails(item.title);
                });
        }

        /** Say the list is partial when some seeds could not be read. */
        private renderPartialNote(): void {
                const note = this.bodyEl.createDiv({ cls: 'bfm-recs-note' });
                setIcon(note.createSpan({ cls: 'bfm-recs-note-icon' }), 'info');
                note.createSpan({
                        text: this.failedSeeds.length === 1
                                ? `One series could not be read (${this.failedSeeds[0]}), so this list may be missing titles.`
                                : `${this.failedSeeds.length} series could not be read, so this list may be missing titles.`,
                });
        }
}

import { App, Modal, Notice, setIcon } from 'obsidian';
import { formatBytes, formatDuration, formatSpeed } from './hls';
import { ConfirmModal } from './modals';
import { type DownloadRun, type StatsStore } from './stats';

export interface StatsCallbacks {
        /** Wipe the run log; the modal re-renders when it resolves. */
        onClear(): Promise<void>;
        onClosed?(): void;
}

/**
 * The download statistics page.
 *
 * Everything shown is derived from the run log by `summarize`, so the page has
 * no state of its own and cannot drift from the numbers it renders. It is a
 * read-only view with one action — clearing the log.
 */
export class StatsModal extends Modal {
        private busy = false;
        private bodyEl!: HTMLElement;

        constructor(
                app: App,
                private readonly stats: StatsStore,
                private readonly callbacks: StatsCallbacks,
        ) {
                super(app);
                this.modalEl.addClass('bfm-stats-modal');
        }

        onOpen(): void {
                this.titleEl.setText('Download statistics');
                this.contentEl.empty();
                this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-stats-body' });
                this.render();
        }

        onClose(): void {
                this.contentEl.empty();
                this.callbacks.onClosed?.();
        }

        private render(): void {
                this.bodyEl.empty();
                const summary = this.stats.summary();

                if (summary.runs.length === 0) {
                        this.renderEmpty();
                        return;
                }

                this.renderOverview(summary);
                this.renderSpeedChart(summary.speedHistory);
                this.renderSeries(summary);
                this.renderRuns(summary.runs);
                this.renderActions();
        }

        private renderEmpty(): void {
                const empty = this.bodyEl.createDiv({ cls: 'bfm-stats-empty' });
                setIcon(empty.createDiv({ cls: 'bfm-stats-empty-icon' }), 'bar-chart-2');
                empty.createDiv({
                        cls: 'bfm-stats-empty-text',
                        text: 'No downloads yet. Statistics appear here once you download an episode.',
                });
        }

        /** The headline figures, as a grid of cards. */
        private renderOverview(summary: ReturnType<StatsStore['summary']>): void {
                const grid = this.bodyEl.createDiv({ cls: 'bfm-stats-grid' });
                const card = (label: string, value: string, hint?: string): void => {
                        const el = grid.createDiv({ cls: 'bfm-stats-card' });
                        el.createDiv({ cls: 'bfm-stats-card-label', text: label });
                        el.createDiv({ cls: 'bfm-stats-card-value', text: value });
                        if (hint) el.createDiv({ cls: 'bfm-stats-card-hint', text: hint });
                };

                card(
                        'Downloaded',
                        formatBytes(summary.totalBytes),
                        `${summary.completed} episode${summary.completed === 1 ? '' : 's'}`,
                );
                card(
                        'Time downloading',
                        formatDuration(summary.totalSeconds),
                        summary.completed > 0 ? `across ${summary.completed} runs` : undefined,
                );
                card('Average speed', formatSpeed(summary.averageSpeed), 'across all runs');
                card(
                        'Best speed',
                        formatSpeed(summary.bestSpeed),
                        summary.peakSpeed > summary.bestSpeed
                                ? `peak ${formatSpeed(summary.peakSpeed)}`
                                : 'fastest run',
                );

                if (summary.failed > 0 || summary.cancelled > 0 || summary.resumed > 0) {
                        const parts: string[] = [];
                        if (summary.resumed > 0) parts.push(`${summary.resumed} resumed`);
                        if (summary.failed > 0) parts.push(`${summary.failed} failed`);
                        if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`);
                        this.bodyEl.createDiv({ cls: 'bfm-stats-note', text: parts.join(' · ') });
                }
        }

        /** A bar per recent run, so a slow patch is visible at a glance. */
        private renderSpeedChart(history: number[]): void {
                if (history.length < 2) return;
                const section = this.bodyEl.createDiv({ cls: 'bfm-stats-section' });
                section.createDiv({ cls: 'bfm-stats-section-title', text: 'Recent speed' });
                const chart = section.createDiv({ cls: 'bfm-stats-chart' });
                const max = Math.max(...history, 1);
                for (const speed of history) {
                        const bar = chart.createDiv({ cls: 'bfm-stats-bar' });
                        // A floor of 4% keeps a very slow run visible rather than a
                        // hairline that reads as no bar at all.
                        const height = Math.max(4, Math.round((speed / max) * 100));
                        bar.createDiv({ cls: 'bfm-stats-bar-fill' }).setCssProps({ height: `${height}%` });
                        bar.setAttribute('aria-label', formatSpeed(speed));
                }
        }

        /** Per-series totals, largest first. */
        private renderSeries(summary: ReturnType<StatsStore['summary']>): void {
                if (summary.series.length === 0) return;
                const section = this.bodyEl.createDiv({ cls: 'bfm-stats-section' });
                section.createDiv({ cls: 'bfm-stats-section-title', text: 'By series' });
                const list = section.createDiv({ cls: 'bfm-stats-list' });
                for (const entry of summary.series) {
                        const row = list.createDiv({ cls: 'bfm-stats-row' });
                        const main = row.createDiv({ cls: 'bfm-stats-row-main' });
                        main.createDiv({ cls: 'bfm-stats-row-title', text: entry.series });
                        main.createDiv({
                                cls: 'bfm-stats-row-meta',
                                text: `${entry.episodes} episode${entry.episodes === 1 ? '' : 's'} · ${formatBytes(entry.bytes)} · ${formatSpeed(entry.averageSpeed)}`,
                        });
                }
        }

        /** The individual runs, newest first. */
        private renderRuns(runs: DownloadRun[]): void {
                const section = this.bodyEl.createDiv({ cls: 'bfm-stats-section' });
                section.createDiv({ cls: 'bfm-stats-section-title', text: 'Recent downloads' });
                const list = section.createDiv({ cls: 'bfm-stats-list' });
                for (const run of runs.slice(0, 30)) {
                        const row = list.createDiv({ cls: 'bfm-stats-row' });
                        if (run.outcome !== 'done') row.addClass('is-' + run.outcome);
                        const main = row.createDiv({ cls: 'bfm-stats-row-main' });
                        const title = `${run.series || 'Unknown series'} · ${run.episode}`;
                        main.createDiv({ cls: 'bfm-stats-row-title', text: title });
                        main.createDiv({ cls: 'bfm-stats-row-meta', text: this.describeRun(run) });
                        row.createDiv({
                                cls: 'bfm-stats-row-time',
                                text: new Date(run.finishedAt).toLocaleDateString(),
                        });
                }
        }

        private describeRun(run: DownloadRun): string {
                if (run.outcome === 'failed') return 'Failed';
                if (run.outcome === 'cancelled') return 'Cancelled';
                const parts = [formatBytes(run.fileSize || run.bytes), formatDuration(run.seconds)];
                if (run.averageSpeed > 0) parts.push(formatSpeed(run.averageSpeed));
                if (run.resumed) parts.push('resumed');
                parts.push(run.format.toUpperCase());
                return parts.join(' · ');
        }

        private renderActions(): void {
                const actions = this.bodyEl.createDiv({ cls: 'bfm-stats-actions' });
                const clear = actions.createEl('button', { cls: 'mod-warning', text: 'Clear statistics' });
                clear.addEventListener('click', () => this.confirmClear());
        }

        private confirmClear(): void {
                if (this.busy) return;
                new ConfirmModal(
                        this.app,
                        'Clear all download statistics? The log of past downloads is deleted. Your downloaded files are not affected.',
                        () => {
                                this.busy = true;
                                void this.callbacks
                                        .onClear()
                                        .then(() => {
                                                new Notice('Download statistics cleared.');
                                                this.render();
                                        })
                                        .catch(() => new Notice('The statistics could not be cleared.'))
                                        .finally(() => {
                                                this.busy = false;
                                        });
                        },
                ).open();
        }
}

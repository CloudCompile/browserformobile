import { App, Modal, Notice, Platform, Setting, setIcon } from 'obsidian';
import {
        AnimeApiError,
        loadEpisodes,
        searchSeries,
        type EpisodeSummary,
        type SeriesSummary,
} from './animeApi';
import { describeProgress, type DownloadJob, type DownloadManager, type OutputFormat } from './downloader';
import { externalStorageAvailable } from './destination';
import { repairFolder } from './doctor';

export interface DownloadModalOptions {
        apiBase: string;
        quality: number;
        format: OutputFormat;
        folder: string;
        external: boolean;
        filenameTemplate: string;
        segmentConcurrency: number;
        maxConcurrentJobs: number;
}

export interface DownloadModalCallbacks {
        onOptionsChanged(options: Partial<DownloadModalOptions>): void;
        /** Fired when the window closes, so the plugin can drop its reference. */
        onClosed?(): void;
}

const QUALITY_CHOICES: { value: string; label: string }[] = [
        { value: '1080', label: '1080p (closest available)' },
        { value: '720', label: '720p' },
        { value: '480', label: '480p' },
        { value: '360', label: '360p' },
];

type Stage = 'search' | 'episodes' | 'queue';

/**
 * Search a series, pick episodes, and hand them to the download manager. The
 * manager outlives the modal, so closing this window does not stop a download.
 */
export class DownloadModal extends Modal {
        private options: DownloadModalOptions;
        private series: SeriesSummary[] = [];
        private selected: SeriesSummary | null = null;
        private episodes: EpisodeSummary[] = [];
        private chosen = new Set<string>();
        private searchValue = '';
        private busy = false;
        private fullscreen = true;
        private stage: Stage = 'search';
        private bodyEl!: HTMLElement;
        private statusEl!: HTMLElement;

        constructor(
                app: App,
                private readonly manager: DownloadManager,
                options: DownloadModalOptions,
                private readonly callbacks: DownloadModalCallbacks,
        ) {
                super(app);
                this.options = { ...options };
                this.modalEl.addClass('bfm-download-modal');
        }

        onOpen(): void {
                this.titleEl.setText('Anime downloads');
                const toggle = this.titleEl.createEl('button', { cls: 'bfm-dl-window-close' });
                setIcon(toggle, 'minimize-2');
                toggle.setAttribute('aria-label', 'Exit full screen');
                toggle.addEventListener('click', () => this.setFullscreen(!this.fullscreen));
                this.contentEl.empty();
                // Fill the window by default: the queue and episode lists are long
                // and a phone's small popup wastes most of the screen.
                this.fullscreen = true;
                this.modalEl.addClass('is-fullscreen');
                this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-dl-body' });
                this.statusEl = this.contentEl.createDiv({ cls: 'bfm-dl-status' });
                this.render();
        }

        private setFullscreen(full: boolean): void {
                this.fullscreen = full;
                this.modalEl.toggleClass('is-fullscreen', full);
                const button = this.titleEl.querySelector('.bfm-dl-window-close');
                if (button) setIcon(button as HTMLElement, full ? 'minimize-2' : 'maximize-2');
        }

        onClose(): void {
                this.contentEl.empty();
                this.callbacks.onClosed?.();
        }

        private render(): void {
                this.bodyEl.empty();
                this.renderStageTabs();
                if (this.stage === 'search') this.renderSearch();
                else if (this.stage === 'episodes') this.renderEpisodes();
                else this.renderQueue();
                this.renderStatus();
        }

        private renderStageTabs(): void {
                const tabs = this.bodyEl.createDiv({ cls: 'bfm-dl-tabs' });
                const active = this.manager.activeCount;
                const stages: { id: Stage; label: string }[] = [
                        { id: 'search', label: 'Search' },
                        { id: 'episodes', label: 'Episodes' },
                        { id: 'queue', label: active > 0 ? `Queue (${active})` : 'Queue' },
                ];
                for (const entry of stages) {
                        const button = tabs.createEl('button', {
                                cls: 'bfm-dl-tab',
                                text: entry.label,
                        });
                        if (this.stage === entry.id) button.addClass('is-active');
                        if (entry.id === 'episodes' && !this.selected) button.disabled = true;
                        button.addEventListener('click', () => {
                                if (entry.id === 'episodes' && !this.selected) return;
                                this.stage = entry.id;
                                this.render();
                        });
                }
        }

        // --- Search ------------------------------------------------------------

        private renderSearch(): void {
                const row = this.bodyEl.createDiv({ cls: 'bfm-dl-search' });
                const input = row.createEl('input', {
                        cls: 'bfm-dl-input',
                        attr: {
                                type: 'text',
                                placeholder: 'Search for a series',
                                value: this.searchValue,
                                autocapitalize: 'off',
                                spellcheck: 'false',
                                enterkeyhint: 'search',
                        },
                });
                const button = row.createEl('button', { cls: 'mod-cta', text: 'Search' });
                const run = () => {
                        this.searchValue = input.value;
                        void this.doSearch();
                };
                button.addEventListener('click', run);
                input.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter') {
                                event.preventDefault();
                                run();
                        }
                });

                if (this.busy) {
                        this.bodyEl.createEl('p', { cls: 'bfm-dl-hint', text: 'Searching…' });
                        return;
                }
                if (this.series.length === 0) {
                        if (this.searchValue) {
                                this.bodyEl.createEl('p', { cls: 'bfm-dl-hint', text: 'No series matched that search.' });
                        }
                        return;
                }
                const list = this.bodyEl.createDiv({ cls: 'bfm-dl-results' });
                for (const series of this.series) {
                        const card = list.createDiv({ cls: 'bfm-dl-result' });
                        if (series.poster) {
                                card.createEl('img', {
                                        cls: 'bfm-dl-poster',
                                        attr: { src: series.poster, alt: '', loading: 'lazy' },
                                });
                        }
                        const info = card.createDiv({ cls: 'bfm-dl-result-info' });
                        info.createDiv({ cls: 'bfm-dl-result-title', text: series.title });
                        const meta: string[] = [];
                        if (series.showType) meta.push(series.showType);
                        meta.push(`${series.eps || series.sub} episodes`);
                        if (series.sub) meta.push(`${series.sub} sub`);
                        if (series.dub) meta.push(`${series.dub} dub`);
                        info.createDiv({ cls: 'bfm-dl-result-meta', text: meta.join(' · ') });
                        card.addEventListener('click', () => void this.openSeries(series));
                }
        }

        private async doSearch(): Promise<void> {
                if (this.busy) return;
                const keyword = this.searchValue.trim();
                if (!keyword) return;
                this.busy = true;
                this.render();
                try {
                        this.series = await searchSeries(this.options.apiBase, keyword);
                } catch (error) {
                        this.series = [];
                        this.notifyError(error);
                } finally {
                        this.busy = false;
                        this.render();
                }
        }

        private async openSeries(series: SeriesSummary): Promise<void> {
                this.busy = true;
                this.selected = series;
                this.render();
                try {
                        const detail = await loadEpisodes(this.options.apiBase, series.id);
                        this.episodes = detail.episodes;
                        this.chosen = new Set(detail.episodes.map((episode) => episode.id));
                        this.stage = 'episodes';
                } catch (error) {
                        this.selected = null;
                        this.notifyError(error);
                } finally {
                        this.busy = false;
                        this.render();
                }
        }

        // --- Episode picker ----------------------------------------------------

        private renderEpisodes(): void {
                const series = this.selected;
                if (!series) {
                        this.stage = 'search';
                        this.render();
                        return;
                }
                const header = this.bodyEl.createDiv({ cls: 'bfm-dl-header' });
                header.createEl('h3', { text: series.title });
                header.createDiv({
                        cls: 'bfm-dl-result-meta',
                        text: `${this.episodes.length} episodes · ${this.chosen.size} selected`,
                });

                this.renderEpisodeControls();
                this.renderDestinationControls();
                this.renderEpisodeList();

                const actions = this.bodyEl.createDiv({ cls: 'bfm-dl-actions' });
                const download = actions.createEl('button', {
                        cls: 'mod-cta',
                        text: this.chosen.size === 0
                                ? 'Select episodes'
                                : `Download ${this.chosen.size} episode${this.chosen.size === 1 ? '' : 's'}`,
                });
                download.disabled = this.chosen.size === 0;
                download.addEventListener('click', () => this.startDownload());
        }

        private renderEpisodeControls(): void {
                const controls = this.bodyEl.createDiv({ cls: 'bfm-dl-controls' });

                const quick = controls.createDiv({ cls: 'bfm-dl-chip-row' });
                const addChip = (label: string, onClick: () => void) => {
                        const chip = quick.createEl('button', { cls: 'bfm-dl-chip', text: label });
                        chip.addEventListener('click', onClick);
                };
                addChip('Select all', () => {
                        this.chosen = new Set(this.episodes.map((episode) => episode.id));
                        this.render();
                });
                addChip('Select none', () => {
                        this.chosen.clear();
                        this.render();
                });
                addChip('Invert', () => {
                        const next = new Set<string>();
                        for (const episode of this.episodes) {
                                if (!this.chosen.has(episode.id)) next.add(episode.id);
                        }
                        this.chosen = next;
                        this.render();
                });
                addChip('Skip filler', () => {
                        this.chosen = new Set(
                                this.episodes.filter((episode) => !episode.filler).map((episode) => episode.id),
                        );
                        this.render();
                });
                addChip('Download missing', () => {
                        void this.selectMissing();
                });

                const rangeRow = controls.createDiv({ cls: 'bfm-dl-range' });
                rangeRow.createSpan({ cls: 'bfm-dl-range-label', text: 'Range' });
                const from = rangeRow.createEl('input', {
                        cls: 'bfm-dl-input bfm-dl-number',
                        attr: { type: 'number', min: '1', placeholder: 'From' },
                });
                const to = rangeRow.createEl('input', {
                        cls: 'bfm-dl-input bfm-dl-number',
                        attr: { type: 'number', min: '1', placeholder: 'To' },
                });
                const applyRange = rangeRow.createEl('button', { cls: 'bfm-dl-chip', text: 'Add' });
                applyRange.addEventListener('click', () => {
                        const start = Number(from.value);
                        const end = Number(to.value) || start;
                        if (!Number.isFinite(start) || start <= 0) return;
                        const low = Math.min(start, end);
                        const high = Math.max(start, end);
                        for (const episode of this.episodes) {
                                if (episode.number >= low && episode.number <= high) this.chosen.add(episode.id);
                        }
                        this.render();
                });
                const clearRange = rangeRow.createEl('button', { cls: 'bfm-dl-chip', text: 'Remove' });
                clearRange.addEventListener('click', () => {
                        const start = Number(from.value);
                        const end = Number(to.value) || start;
                        if (!Number.isFinite(start) || start <= 0) return;
                        const low = Math.min(start, end);
                        const high = Math.max(start, end);
                        for (const episode of this.episodes) {
                                if (episode.number >= low && episode.number <= high) this.chosen.delete(episode.id);
                        }
                        this.render();
                });

                const options = controls.createDiv({ cls: 'bfm-dl-options' });
                new Setting(options)
                        .setName('Quality')
                        .setDesc('The closest available quality is used when the source does not offer the exact one.')
                        .addDropdown((dropdown) => {
                                for (const choice of QUALITY_CHOICES) {
                                        dropdown.addOption(choice.value, choice.label);
                                }
                                dropdown.setValue(String(this.options.quality));
                                dropdown.onChange((value) => this.updateOption({ quality: Number(value) }));
                        });

                new Setting(options)
                        .setName('Format')
                        .setDesc(
                                Platform.isMobile
                                        ? 'TS streams to disk with little memory; MP4 is a single playable file but buffers the whole episode.'
                                        : 'MP4 produces a single playable file. TS keeps the raw stream.',
                        )
                        .addDropdown((dropdown) => {
                                dropdown.addOption('mp4', 'Playable file (mp4)');
                                dropdown.addOption('ts', 'Raw stream (ts, low memory)');
                                dropdown.setValue(this.options.format);
                                dropdown.onChange((value) =>
                                        this.updateOption({ format: value === 'ts' ? 'ts' : 'mp4' }),
                                );
                        });
        }

        private renderDestinationControls(): void {
                const box = this.bodyEl.createDiv({ cls: 'bfm-dl-destination' });
                const canExternal = externalStorageAvailable();

                new Setting(box)
                        .setName('Folder')
                        .setDesc(
                                this.options.external && canExternal
                                        ? 'Absolute path on this device, for example /storage/XXXX-XXXX/Anime.'
                                        : 'Folder inside your vault. On mobile the vault is the only writable location.',
                        )
                        .addText((text) => {
                                text.setPlaceholder(this.options.external ? '/storage/SD/Anime' : 'Anime');
                                text.setValue(this.options.folder);
                                text.onChange((value) => this.updateOption({ folder: value }));
                        });

                if (canExternal) {
                        new Setting(box)
                                .setName('Save outside the vault')
                                .setDesc('Desktop only. Writes to an absolute path, such as a mounted memory card.')
                                .addToggle((toggle) => {
                                        toggle.setValue(this.options.external);
                                        toggle.onChange((value) => this.updateOption({ external: value }));
                                });
                } else {
                        box.createEl('p', {
                                cls: 'bfm-dl-hint',
                                text: 'Saving outside the vault is desktop only: Obsidian on mobile cannot write to a memory card. Files go to the folder above inside your vault.',
                        });
                }
        }

        /**
         * The "series finisher": select only the episodes that are not already
         * saved and not already queued, so a long-running series can be topped up
         * without re-downloading what is on disk.
         */
        private async selectMissing(): Promise<void> {
                const series = this.selected;
                if (!series) return;
                this.busy = true;
                this.render();
                try {
                        const missing = await this.manager.missingEpisodes(series.title, this.episodes);
                        this.chosen = new Set(missing.map((episode) => episode.id));
                        const have = this.episodes.length - missing.length;
                        new Notice(
                                missing.length === 0
                                        ? `All ${this.episodes.length} episodes are already saved.`
                                        : `${missing.length} missing episode${missing.length === 1 ? '' : 's'} selected` +
                                                  (have > 0 ? ` (${have} already saved).` : '.'),
                        );
                } finally {
                        this.busy = false;
                        this.render();
                }
        }

        private renderEpisodeList(): void {
                const list = this.bodyEl.createDiv({ cls: 'bfm-dl-episodes' });
                for (const episode of this.episodes) {
                        const row = list.createDiv({ cls: 'bfm-dl-episode' });
                        const checkbox = row.createEl('input', { attr: { type: 'checkbox' } });
                        checkbox.checked = this.chosen.has(episode.id);
                        checkbox.addEventListener('change', () => {
                                if (checkbox.checked) this.chosen.add(episode.id);
                                else this.chosen.delete(episode.id);
                                this.updateSelectionLabel();
                        });
                        const label = row.createDiv({ cls: 'bfm-dl-episode-label' });
                        label.createSpan({ cls: 'bfm-dl-episode-no', text: `${episode.number}` });
                        label.createSpan({ cls: 'bfm-dl-episode-title', text: episode.title });
                        if (episode.filler) label.createSpan({ cls: 'bfm-dl-badge', text: 'filler' });
                        if (!episode.subbed && episode.dubbed) {
                                label.createSpan({ cls: 'bfm-dl-badge', text: 'dub' });
                        }
                        row.addEventListener('click', (event) => {
                                if (event.target === checkbox) return;
                                checkbox.checked = !checkbox.checked;
                                if (checkbox.checked) this.chosen.add(episode.id);
                                else this.chosen.delete(episode.id);
                                this.updateSelectionLabel();
                        });
                }
        }

        private updateSelectionLabel(): void {
                const header = this.bodyEl.querySelector('.bfm-dl-header .bfm-dl-result-meta');
                if (header) {
                        header.setText(`${this.episodes.length} episodes · ${this.chosen.size} selected`);
                }
                const download = this.bodyEl.querySelector<HTMLButtonElement>('.bfm-dl-actions .mod-cta');
                if (download) {
                        download.disabled = this.chosen.size === 0;
                        download.setText(
                                this.chosen.size === 0
                                        ? 'Select episodes'
                                        : `Download ${this.chosen.size} episode${this.chosen.size === 1 ? '' : 's'}`,
                        );
                }
        }

        private startDownload(): void {
                const series = this.selected;
                if (!series || this.chosen.size === 0) return;
                const episodes = this.episodes.filter((episode) => this.chosen.has(episode.id));
                const created = this.manager.enqueue({ seriesTitle: series.title, episodes });
                const resumed = created.filter((job) => job.status === 'queued' && job.partialFound).length;
                const message =
                        resumed > 0
                                ? `Queued ${created.length} episode${created.length === 1 ? '' : 's'} from ${series.title} (${resumed} will resume).`
                                : `Queued ${created.length} episode${created.length === 1 ? '' : 's'} from ${series.title}.`;
                new Notice(message);
                this.stage = 'queue';
                this.render();
        }

        // --- Queue -------------------------------------------------------------

        private renderQueue(): void {
                const jobs = this.manager.jobs;
                if (jobs.length === 0) {
                        this.bodyEl.createEl('p', {
                                cls: 'bfm-dl-hint',
                                text: 'No downloads yet. Search for a series and pick episodes.',
                        });
                        return;
                }
                const list = this.bodyEl.createDiv({ cls: 'bfm-dl-jobs' });
                for (const job of jobs) this.renderJobRow(list, job);

                const actions = this.bodyEl.createDiv({ cls: 'bfm-dl-actions' });
                const resumable = this.manager.resumableJobs;
                if (resumable.length > 0) {
                        const resumeAll = actions.createEl('button', {
                                cls: 'mod-cta',
                                text: `Resume all (${resumable.length})`,
                        });
                        resumeAll.addEventListener('click', () => {
                                this.manager.enqueue({
                                        seriesTitle: resumable[0]?.seriesTitle ?? '',
                                        episodes: resumable.map((job) => job.episode),
                                });
                                new Notice(`Resuming ${resumable.length} download${resumable.length === 1 ? '' : 's'}.`);
                                this.render();
                        });
                }
                const cancelAll = actions.createEl('button', { text: 'Cancel all' });
                cancelAll.addEventListener('click', () => {
                        this.manager.cancelAll();
                        this.render();
                });
                const clear = actions.createEl('button', { text: 'Clear finished' });
                clear.addEventListener('click', () => {
                        this.manager.clearFinished();
                        this.render();
                });
                const doctor = actions.createEl('button', { text: 'Repair old videos' });
                doctor.addEventListener('click', () => {
                        void this.repairVideos();
                });
        }

        /** One queue row. Kept separate so progress ticks can update it in place. */
        private renderJobRow(list: HTMLElement, job: DownloadJob): void {
                const row = list.createDiv({ cls: 'bfm-dl-job' });
                row.dataset.jobId = job.id;
                row.addClass(`is-${job.status}`);
                const head = row.createDiv({ cls: 'bfm-dl-job-head' });
                head.createSpan({
                        cls: 'bfm-dl-job-title',
                        text: `${job.seriesTitle} · Episode ${job.episode.number}`,
                });
                const status = head.createSpan({ cls: 'bfm-dl-job-status', text: describeProgress(job) });
                if (job.status === 'failed') status.addClass('is-error');
                if (job.status === 'paused') status.addClass('is-paused');
                if (job.status === 'running' || job.status === 'queued' || job.status === 'paused') {
                        const cancel = head.createEl('button', { cls: 'bfm-dl-job-cancel' });
                        setIcon(cancel, 'x');
                        cancel.setAttribute('title', 'Cancel');
                        cancel.addEventListener('click', () => {
                                this.manager.cancel(job.id);
                                this.render();
                        });
                }
                if (job.total && job.total > 0 && job.completed !== null && job.status !== 'done') {
                        const bar = row.createDiv({ cls: 'bfm-dl-progress' });
                        const fill = bar.createDiv({ cls: 'bfm-dl-progress-fill' });
                        fill.style.width = `${Math.round((job.completed / job.total) * 100)}%`;
                }
                if (job.status === 'failed' && job.partialFound) {
                        this.renderResumeRow(row, job);
                }
        }

        /**
         * Update just the status text and progress bar of each visible row, so a
         * fast-downloading queue does not rebuild the whole DOM every 150ms and
         * stall the window. Rows that changed shape (a job that finished, failed,
         * or was parked) fall back to a full render.
         */
        private tickQueue(): void {
                const list = this.bodyEl.querySelector<HTMLElement>('.bfm-dl-jobs');
                if (!list) {
                        this.render();
                        return;
                }
                for (const job of this.manager.jobs) {
                        const row = list.querySelector<HTMLElement>(`[data-job-id="${job.id}"]`);
                        if (!row) {
                                this.render();
                                return;
                        }
                        if (!row.classList.contains(`is-${job.status}`)) {
                                this.render();
                                return;
                        }
                        const status = row.querySelector<HTMLElement>('.bfm-dl-job-status');
                        if (status) status.setText(describeProgress(job));
                        const fill = row.querySelector<HTMLElement>('.bfm-dl-progress-fill');
                        if (fill && job.total && job.completed !== null) {
                                fill.style.width = `${Math.round((job.completed / job.total) * 100)}%`;
                        }
                }
                this.renderStatus();
        }

        /**
         * Show how much of a failed download is still on disk and offer to
         * continue it from the next missing segment.
         */
        private renderResumeRow(row: HTMLElement, job: DownloadJob): void {
                const info = row.createDiv({ cls: 'bfm-dl-resume' });
                const saved =
                        job.total !== null
                                ? `${job.resumeSegments} of ${job.total} segments saved`
                                : `${job.resumeSegments} segments saved`;
                info.createSpan({ cls: 'bfm-dl-resume-text', text: `${saved} — resume continues from there.` });
                const resume = info.createEl('button', { cls: 'mod-cta', text: 'Resume' });
                resume.addEventListener('click', () => {
                        this.manager.enqueue({ seriesTitle: job.seriesTitle, episodes: [job.episode] });
                        new Notice(`Resuming ${job.seriesTitle} · Episode ${job.episode.number}.`);
                        this.render();
                });
                const discard = info.createEl('button', { text: 'Discard' });
                discard.addEventListener('click', () => {
                        void this.manager.discard(job.id).then(() => this.render());
                });
        }

        /**
         * Fix files downloaded before 1.1.1. mux.js left the track durations at
         * its "unknown" sentinel, so Samsung Gallery and similar players show
         * every file as 1:35:15. The real length is still in the movie header,
         * so the files are repaired in place rather than re-downloaded.
         */
        private async repairVideos(): Promise<void> {
                const adapter = this.app.vault.adapter as unknown as {
                        readBinary(path: string): Promise<ArrayBuffer>;
                        writeBinary(path: string, data: ArrayBuffer): Promise<void>;
                        list(path: string): Promise<{ files: string[]; folders: string[] }>;
                        exists(path: string): Promise<boolean>;
                };
                const folder = this.options.external ? '' : this.options.folder;
                const notice = new Notice('Checking downloaded videos…', 0);
                try {
                        const result = await repairFolder(adapter, folder);
                        notice.hide();
                        if (result.scanned === 0) {
                                new Notice('No downloaded videos were found in this folder.');
                                return;
                        }
                        const seconds = result.fixed.reduce((sum, entry) => sum + entry.durationSeconds, 0);
                        const parts = [
                                `${result.scanned} checked`,
                                result.repaired > 0 ? `${result.repaired} repaired` : 'none needed repair',
                        ];
                        if (result.repaired > 0) parts.push(`${Math.round(seconds / 60)} minutes fixed`);
                        if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
                        new Notice(parts.join(' · '));
                } catch (error) {
                        notice.hide();
                        new Notice(error instanceof Error ? error.message : 'The repair could not be completed.');
                }
        }

        private renderStatus(): void {
                this.statusEl.empty();
                const active = this.manager.activeCount;
                const paused = this.manager.pausedJobs.length;
                const done = this.manager.jobs.filter((job) => job.status === 'done').length;
                const failed = this.manager.jobs.filter((job) => job.status === 'failed').length;
                const parts: string[] = [];
                if (active > 0) parts.push(`${active} active`);
                if (paused > 0) parts.push(`${paused} waiting on rate limit`);
                if (done > 0) parts.push(`${done} done`);
                if (failed > 0) parts.push(`${failed} failed`);
                if (this.options.external && externalStorageAvailable()) {
                        parts.push('saving outside the vault');
                }
                this.statusEl.setText(parts.join(' · ') || 'Idle');
        }

        private updateOption(patch: Partial<DownloadModalOptions>): void {
                this.options = { ...this.options, ...patch };
                this.callbacks.onOptionsChanged(patch);
                if (patch.quality !== undefined || patch.format !== undefined) {
                        this.renderStatus();
                }
        }

        private notifyError(error: unknown): void {
                const message =
                        error instanceof AnimeApiError
                                ? error.message
                                : error instanceof Error
                                        ? error.message
                                        : String(error);
                new Notice(message);
        }

        /** Called by the plugin when the manager reports progress. */
        refresh(): void {
                if (this.stage === 'queue') this.tickQueue();
                else this.renderStatus();
        }
}

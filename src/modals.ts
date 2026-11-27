import { App, Modal, SuggestModal } from 'obsidian';

/**
 * Simple confirmation dialog, used before anything destructive.
 *
 * The remaining modals in the plugin are the download, library, statistics and
 * details views. This one is shared because every one of them needs it.
 */
export class ConfirmModal extends Modal {
        private resolved = false;

        constructor(
                app: App,
                private readonly message: string,
                private readonly onConfirm: () => void,
        ) {
                super(app);
        }

        onOpen(): void {
                const { contentEl } = this;
                contentEl.createEl('p', { text: this.message });
                const row = contentEl.createDiv({ cls: 'bfm-modal-actions' });
                const cancel = row.createEl('button', { text: 'Cancel' });
                cancel.addEventListener('click', () => this.close());
                const confirm = row.createEl('button', { cls: 'mod-warning', text: 'Confirm' });
                confirm.addEventListener('click', () => {
                        this.resolved = true;
                        this.onConfirm();
                        this.close();
                });
        }

        onClose(): void {
                this.contentEl.empty();
                if (!this.resolved) {
                        this.resolved = true;
                }
        }
}

/**
 * Fuzzy picker over the series the plugin knows about, so the details page can
 * be opened without going through the library.
 */
export class SeriesPickerModal extends SuggestModal<string> {
        constructor(
                app: App,
                private readonly series: string[],
                private readonly onPick: (series: string) => void,
        ) {
                super(app);
                this.setPlaceholder('Search your series');
                this.emptyStateText = 'Download a series first and it will appear here.';
        }

        getSuggestions(query: string): string[] {
                const needle = query.trim().toLowerCase();
                if (!needle) return this.series.slice(0, 200);
                return this.series.filter((name) => name.toLowerCase().includes(needle)).slice(0, 200);
        }

        renderSuggestion(series: string, el: HTMLElement): void {
                el.createDiv({ cls: 'bfm-suggest-title', text: series });
        }

        onChooseSuggestion(series: string): void {
                this.onPick(series);
        }
}

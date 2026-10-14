import { App, Modal, Notice, Setting, SuggestModal, setIcon } from 'obsidian';
import { cookiesToNetscape } from './cookieStore';
import type { BrowserStore } from './store';
import type { BookmarkRecord, CookieRecord, HistoryRecord } from './types';
import { displayUrl, hostOf } from './utils';

function formatTimestamp(value: number): string {
	return new Date(value).toLocaleString();
}

/** Fuzzy picker over the browsing history. */
export class HistoryModal extends SuggestModal<HistoryRecord> {
	constructor(
		app: App,
		private readonly store: BrowserStore,
		private readonly onPick: (entry: HistoryRecord) => void,
	) {
		super(app);
		this.setPlaceholder('Search history');
		this.emptyStateText = 'No history yet.';
	}

	getSuggestions(query: string): HistoryRecord[] {
		const needle = query.trim().toLowerCase();
		const entries = [...this.store.history].reverse();
		if (!needle) return entries.slice(0, 200);
		return entries
			.filter(
				(entry) =>
					entry.url.toLowerCase().includes(needle) ||
					entry.title.toLowerCase().includes(needle),
			)
			.slice(0, 200);
	}

	renderSuggestion(entry: HistoryRecord, el: HTMLElement): void {
		el.createDiv({ cls: 'bfm-suggest-title', text: entry.title || entry.url });
		el.createDiv({
			cls: 'bfm-suggest-sub',
			text: `${displayUrl(entry.url, 80)} · ${formatTimestamp(entry.visitedAt)}`,
		});
	}

	onChooseSuggestion(entry: HistoryRecord): void {
		this.onPick(entry);
	}
}

/** Fuzzy picker over bookmarks. */
export class BookmarkModal extends SuggestModal<BookmarkRecord> {
	constructor(
		app: App,
		private readonly store: BrowserStore,
		private readonly onPick: (entry: BookmarkRecord) => void,
	) {
		super(app);
		this.setPlaceholder('Search bookmarks');
		this.emptyStateText = 'No bookmarks yet.';
	}

	getSuggestions(query: string): BookmarkRecord[] {
		const needle = query.trim().toLowerCase();
		const entries = [...this.store.bookmarks].reverse();
		if (!needle) return entries;
		return entries.filter(
			(entry) =>
				entry.url.toLowerCase().includes(needle) ||
				entry.title.toLowerCase().includes(needle),
		);
	}

	renderSuggestion(entry: BookmarkRecord, el: HTMLElement): void {
		el.createDiv({ cls: 'bfm-suggest-title', text: entry.title || entry.url });
		el.createDiv({ cls: 'bfm-suggest-sub', text: displayUrl(entry.url, 80) });
	}

	onChooseSuggestion(entry: BookmarkRecord): void {
		this.onPick(entry);
	}
}

/** Manage and export the local cookie jar. */
export class CookieManagerModal extends Modal {
	constructor(
		app: App,
		private readonly store: BrowserStore,
	) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Cookies' });

		const cookies = this.store.cookies;
		if (cookies.length === 0) {
			contentEl.createEl('p', {
				text: 'No cookies are stored. Proxied pages can save cookies here when the cookie jar is enabled.',
			});
		} else {
			const grouped = new Map<string, CookieRecord[]>();
			for (const cookie of cookies) {
				const list = grouped.get(cookie.domain) ?? [];
				list.push(cookie);
				grouped.set(cookie.domain, list);
			}
			for (const [domain, list] of Array.from(grouped.entries()).sort()) {
				new Setting(contentEl)
					.setName(domain)
					.setDesc(`${list.length} cookie${list.length === 1 ? '' : 's'}`)
					.addExtraButton((button) =>
						button
							.setIcon('trash')
							.setTooltip(`Delete cookies for ${domain}`)
							.onClick(() => {
								this.store.clearCookiesForHost(domain);
								new Notice(`Cleared cookies for ${domain}.`);
								this.render();
							}),
					);
			}
		}

		const actions = new Setting(contentEl);
		actions.addButton((button) =>
			button.setButtonText('Copy cookie file').onClick(() => {
				void navigator.clipboard
					.writeText(cookiesToNetscape(this.store.cookies))
					.then(() => new Notice('Cookie file copied to the clipboard.'))
					.catch(() => new Notice('Could not copy the cookie file.'));
			}),
		);
		if (cookies.length > 0) {
			actions.addButton((button) =>
				button
					.setDestructive()
					.setButtonText('Clear all cookies')
					.onClick(() => {
						this.store.clearAllCookies();
						new Notice('All cookies cleared.');
						this.render();
					}),
			);
		}
	}
}

/** Simple confirmation dialog. */
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

/** Ask the user whether to retry a failed page through the proxy. */
export class ProxyFallbackModal extends Modal {
	constructor(
		app: App,
		private readonly url: string,
		private readonly onRetry: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const header = contentEl.createDiv({ cls: 'bfm-modal-header' });
		setIcon(header.createSpan({ cls: 'bfm-modal-icon' }), 'globe');
		header.createEl('h2', { text: 'Site blocked embedding' });
		contentEl.createEl('p', {
			text: `${hostOf(this.url) || 'This site'} refused to load inside Obsidian. You can retry it through the CORS proxy, which renders a read-only copy of the page.`,
		});
		const row = contentEl.createDiv({ cls: 'bfm-modal-actions' });
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		const retry = row.createEl('button', { cls: 'mod-cta', text: 'Retry with proxy' });
		retry.addEventListener('click', () => {
			this.onRetry();
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

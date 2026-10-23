import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { repairDuration, needsRepair, inspectDuration, repairFolder } from './doctor';
import { type LibraryItem } from './library';
import { ConfirmModal } from './modals';
import { formatBytes, formatDuration } from './hls';
import type BrowserPlugin from './main';
import { externalStorageAvailable } from './destination';

export const VIEW_TYPE_DOWNLOADS = 'browser-for-mobile-download-manager';

type Filter = 'all' | 'needs-repair' | 'unhealthy';

interface FileStatus {
	needsRepair: boolean;
	durationSeconds: number | null;
	repaired?: number | null;
	failed?: string;
}

export class DownloadManagerView extends ItemView {
	private readonly plugin: BrowserPlugin;
	private filter: Filter = 'all';
	private bodyEl!: HTMLElement;
	private listEl!: HTMLElement;
	private statuses = new Map<string, FileStatus>();
	private busy = false;

	constructor(leaf: WorkspaceLeaf, plugin: BrowserPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE_DOWNLOADS; }
	getDisplayText(): string { return 'Download manager'; }
	getIcon(): string { return 'download'; }

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('bfm-download-manager');

		const header = this.contentEl.createDiv({ cls: 'bfm-dm-header' });
		header.createEl('h2', { text: 'Download manager' });

		const toolbar = this.contentEl.createDiv({ cls: 'bfm-dm-toolbar' });
		const refreshBtn = toolbar.createEl('button', { text: 'Refresh scan' });
		refreshBtn.addEventListener('click', () => void this.scan());
		const repairAllBtn = toolbar.createEl('button', { cls: 'mod-cta', text: 'Repair all' });
		repairAllBtn.addEventListener('click', () => void this.repairAll());

		const filters = toolbar.createDiv({ cls: 'bfm-dm-filters' });
		const choices: { value: Filter; label: string }[] = [
			{ value: 'all', label: 'All' },
			{ value: 'needs-repair', label: 'Needs repair' },
			{ value: 'unhealthy', label: 'Unhealthy' },
		];
		const buttons: HTMLButtonElement[] = [];
		for (const choice of choices) {
			const button = filters.createEl('button', { cls: 'bfm-dm-filter', text: choice.label });
			button.toggleClass('is-active', this.filter === choice.value);
			button.addEventListener('click', () => {
				this.filter = choice.value;
				for (const other of buttons) other.toggleClass('is-active', false);
				button.toggleClass('is-active', true);
				this.render();
			});
			buttons.push(button);
		}

		const emptyHint = this.externalHint();
		if (emptyHint) {
			const hint = this.contentEl.createDiv({ cls: 'bfm-dm-hint' });
			hint.setText(emptyHint);
		}

		this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-dm-body' });
		this.listEl = this.bodyEl.createDiv({ cls: 'bfm-dm-list' });

		await this.scan();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private externalHint(): string {
		if (!this.plugin.settings.downloadExternal || !externalStorageAvailable()) return '';
		return 'Downloads saved outside the vault are not listed here. Only videos inside your vault appear.';
	}

	private async scan(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const notice = new Notice('Scanning downloads…', 0);
		try {
			await this.plugin.refreshLibrary();
			const library = this.plugin.library;
			this.statuses.clear();
			const adapter = this.app.vault.adapter as unknown as {
				readBinary(path: string): Promise<ArrayBuffer>;
			};
			for (const entry of library.entries) {
				try {
					const buffer = await adapter.readBinary(entry.path);
					const data = new Uint8Array(buffer);
					const ins = inspectDuration(data);
					this.statuses.set(entry.path, {
						needsRepair: needsRepair(data),
						durationSeconds: ins.durationSeconds,
					});
				} catch (error) {
					this.statuses.set(entry.path, {
						needsRepair: false,
						durationSeconds: null,
						failed: error instanceof Error ? error.message : String(error),
					});
				}
			}
			notice.hide();
			this.render();
		} catch (error) {
			notice.hide();
			new Notice(error instanceof Error ? error.message : 'Scan failed.');
		} finally {
			this.busy = false;
		}
	}

	private repairStatus(item: LibraryItem): 'healthy' | 'needs-repair' | 'repaired' | 'failed' {
		const st = this.statuses.get(item.path);
		if (!st) return 'healthy';
		if (st.failed) return 'failed';
		if (st.repaired !== undefined && st.repaired !== null) return 'repaired';
		return st.needsRepair ? 'needs-repair' : 'healthy';
	}

	private render(): void {
		if (!this.listEl) return;
		this.listEl.empty();
		const items = this.plugin.library.items();
		const visible = items.filter((item) => this.matches(item));
		if (items.length === 0) {
			const empty = this.listEl.createDiv({ cls: 'bfm-dm-empty' });
			empty.createDiv({ cls: 'bfm-dm-empty-icon' });
			empty.createDiv({
				cls: 'bfm-dm-empty-text',
				text: this.externalHint() || 'No downloaded videos yet. Download an episode to see it here.',
			});
			return;
		}
		if (visible.length === 0) {
			this.listEl.createDiv({ cls: 'bfm-dm-empty-text', text: 'Nothing matches this filter.' });
			return;
		}
		for (const item of visible) {
			this.renderRow(item);
		}
	}

	private matches(item: LibraryItem): boolean {
		const status = this.repairStatus(item);
		if (this.filter === 'needs-repair' && status !== 'needs-repair') return false;
		if (this.filter === 'unhealthy' && status !== 'needs-repair' && status !== 'failed') return false;
		return true;
	}

	private renderRow(item: LibraryItem): void {
		const row = this.listEl.createDiv({ cls: 'bfm-dm-row' });
		const st = this.statuses.get(item.path);
		const status = this.repairStatus(item);

		const main = row.createDiv({ cls: 'bfm-dm-main' });
		main.createDiv({ cls: 'bfm-dm-title', text: item.name });
		const metaParts: string[] = [];
		if (item.size > 0) metaParts.push(formatBytes(item.size));
		if (st?.durationSeconds) metaParts.push(formatDuration(st.durationSeconds));
		metaParts.push(item.ext.toUpperCase());
		main.createDiv({ cls: 'bfm-dm-meta', text: metaParts.join(' · ') });

		const badge = row.createDiv({ cls: `bfm-dm-status bfm-dm-status-${status}` });
		const labels: Record<string, string> = {
			healthy: 'Healthy',
			'needs-repair': 'Needs repair',
			repaired: 'Repaired',
			failed: 'Failed',
		};
		badge.setText(labels[status] ?? status);
		if (st?.failed) badge.setAttribute('title', st.failed);
		if (st?.repaired) badge.setAttribute('title', `Repaired: ${formatDuration(st.repaired)}s`);

		const actions = row.createDiv({ cls: 'bfm-dm-actions' });
		const playBtn = actions.createEl('button', { cls: 'bfm-dm-btn', text: 'Play' });
		playBtn.addEventListener('click', () => this.plugin.playItem(item));

		const repairBtn = actions.createEl('button', { cls: 'bfm-dm-btn', text: 'Repair' });
		repairBtn.addEventListener('click', () => void this.repairOne(item));

		const deleteBtn = actions.createEl('button', { cls: 'bfm-dm-btn bfm-dm-btn-danger', text: 'Delete' });
		deleteBtn.addEventListener('click', () => this.confirmDelete(item));
	}

	private async repairOne(item: LibraryItem): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const notice = new Notice(`Repairing ${item.name}…`, 0);
		try {
			const adapter = this.app.vault.adapter as unknown as {
				readBinary(path: string): Promise<ArrayBuffer>;
				writeBinary(path: string, data: ArrayBuffer): Promise<void>;
			};
			const buffer = await adapter.readBinary(item.path);
			const data = new Uint8Array(buffer);
			if (!needsRepair(data)) {
				notice.hide();
				new Notice(`${item.name}: nothing to repair.`);
				const ins = inspectDuration(data);
				this.statuses.set(item.path, { needsRepair: false, durationSeconds: ins.durationSeconds });
				this.render();
				return;
			}
			const repaired = repairDuration(data);
			if (!repaired) {
				this.statuses.set(item.path, { needsRepair: true, durationSeconds: null, failed: 'Could not recover duration.' });
				notice.hide();
				new Notice(`${item.name}: repair failed.`);
				this.render();
				return;
			}
			await adapter.writeBinary(item.path, repaired.data.buffer.slice(repaired.data.byteOffset, repaired.data.byteOffset + repaired.data.byteLength) as ArrayBuffer);
			this.statuses.set(item.path, {
				needsRepair: false,
				durationSeconds: repaired.durationSeconds,
				repaired: repaired.durationSeconds,
			});
			notice.hide();
			new Notice(`Repaired ${item.name} (${formatDuration(repaired.durationSeconds)}).`);
			this.render();
		} catch (error) {
			notice.hide();
			const msg = error instanceof Error ? error.message : String(error);
			this.statuses.set(item.path, { needsRepair: false, durationSeconds: null, failed: msg });
			new Notice(`${item.name}: ${msg}`);
			this.render();
		} finally {
			this.busy = false;
		}
	}

	private async repairAll(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const folder = this.plugin.settings.downloadExternal ? '' : this.plugin.settings.downloadFolder;
		const adapter = this.app.vault.adapter as unknown as {
			readBinary(path: string): Promise<ArrayBuffer>;
			writeBinary(path: string, data: ArrayBuffer): Promise<void>;
			list(path: string): Promise<{ files: string[]; folders: string[] }>;
			exists(path: string): Promise<boolean>;
		};
		const notice = new Notice('Checking downloaded videos…', 0);
		try {
			const result = await repairFolder(adapter, folder, (path, done, total) => {
				try {
					(notice as unknown as { setMessage?: (m: string) => void }).setMessage?.(`${done + 1}/${total} · ${path.split('/').pop()}`);
				} catch {
					/* ignore */
				}
			});
			notice.hide();
			const seconds = result.fixed.reduce((sum, entry) => sum + entry.durationSeconds, 0);
			const parts = [
				`${result.scanned} checked`,
				result.repaired > 0 ? `${result.repaired} repaired` : 'none needed repair',
			];
			if (result.repaired > 0) parts.push(`${Math.round(seconds / 60)} min fixed`);
			if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
			new Notice(parts.join(' · '));
			await this.scan();
		} catch (error) {
			notice.hide();
			new Notice(error instanceof Error ? error.message : 'Repair could not be completed.');
		} finally {
			this.busy = false;
		}
	}

	private confirmDelete(item: LibraryItem): void {
		if (this.busy) return;
		const run = async (): Promise<void> => {
			this.busy = true;
			try {
				await this.plugin.deleteItem(item);
				this.statuses.delete(item.path);
				new Notice(`Deleted ${item.name}`);
				await this.scan();
			} catch (error) {
				new Notice(error instanceof Error ? error.message : 'The file could not be deleted.');
			} finally {
				this.busy = false;
			}
		};
		if (this.plugin.settings.confirmDestructiveActions) {
			new ConfirmModal(this.app, `Delete ${item.name}? The file is removed from your vault. This cannot be undone.`, () => void run()).open();
		} else {
			void run();
		}
	}
}

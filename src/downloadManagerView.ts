import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { repairDuration, inspectDurationEnhanced, repairFolder } from './doctor';
import { type LibraryItem, type LibraryEntry } from './library';
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
	scanning?: boolean;
}

interface CacheEntry {
	key: string;
	status: FileStatus;
}

const CONCURRENCY = 2;
const SCAN_FILE_BUDGET_MS = 1000;

export class DownloadManagerView extends ItemView {
	private readonly plugin: BrowserPlugin;
	private filter: Filter = 'all';
	private bodyEl!: HTMLElement;
	private listEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private progressFill!: HTMLElement;
	private progressText!: HTMLElement;
	private statuses = new Map<string, FileStatus>();
	private scanCache = new Map<string, CacheEntry>();
	private busy = false;
	private cancelled = false;

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

		this.progressEl = this.contentEl.createDiv({ cls: 'bfm-dm-progress' });
		this.progressEl.setCssProps({ display: 'none' });
		this.progressFill = this.progressEl.createDiv({ cls: 'bfm-dm-progress-fill' });
		this.progressText = this.progressEl.createDiv({ cls: 'bfm-dm-progress-text' });

		this.bodyEl = this.contentEl.createDiv({ cls: 'bfm-dm-body' });
		this.listEl = this.bodyEl.createDiv({ cls: 'bfm-dm-list' });

		await this.loadScanCache();
		await this.scan();
	}

	async onClose(): Promise<void> {
		this.cancelled = true;
		void this.saveScanCache();
		this.contentEl.empty();
	}

	private externalHint(): string {
		if (!this.plugin.settings.downloadExternal || !externalStorageAvailable()) return '';
		return 'Downloads saved outside the vault are not listed here. Only videos inside your vault appear.';
	}

	private setProgress(visible: boolean, pct: number, text: string): void {
		this.progressEl.setCssProps({ display: visible ? 'block' : 'none' });
		this.progressFill.setCssProps({ width: `${Math.max(0, Math.min(100, pct))}%` });
		this.progressText.setText(text);
	}

	private async loadScanCache(): Promise<void> {
		try {
			const raw = await this.plugin.loadData() as Record<string, unknown> | null;
			const cache = (raw as { downloadScanCache?: Record<string, CacheEntry> } | null)?.downloadScanCache;
			if (cache && typeof cache === 'object') {
				this.scanCache = new Map(Object.entries(cache));
				(this.plugin as unknown as { browserData?: Record<string, unknown> }).browserData = {
					...((this.plugin as unknown as { browserData?: Record<string, unknown> }).browserData ?? {}),
					downloadScanCache: cache,
				};
			}
		} catch {
			// Ignore cache-load failures; a full scan will follow.
		}
	}

	private async saveScanCache(): Promise<void> {
		try {
			const raw = ((await this.plugin.loadData()) ?? {}) as Record<string, unknown>;
			raw.downloadScanCache = Object.fromEntries(this.scanCache);
			(this.plugin as unknown as { browserData?: Record<string, unknown> }).browserData = {
				...((this.plugin as unknown as { browserData?: Record<string, unknown> }).browserData ?? {}),
				downloadScanCache: raw.downloadScanCache,
			};
			await this.plugin.saveData(raw);
		} catch {
			// Persistence is best-effort; the in-memory cache still helps.
		}
	}

	private async scan(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.cancelled = false;
		try {
			await this.plugin.refreshLibrary();
			const library = this.plugin.library;
			const entries = library.entries;
			const total = entries.length;
			this.statuses.clear();
			this.setProgress(true, 0, total === 0 ? 'Nothing to scan.' : `Scanning 0/${total}…`);

			const present = new Set(entries.map((entry) => entry.path));
			for (const path of [...this.scanCache.keys()]) {
				if (!present.has(path)) this.scanCache.delete(path);
			}

			for (const entry of entries) {
				this.statuses.set(entry.path, {
					needsRepair: false,
					durationSeconds: null,
					scanning: true,
				});
			}
			this.render();

			const adapter = this.app.vault.adapter as unknown as {
				readBinary(path: string): Promise<ArrayBuffer>;
			};

			let done = 0;
			const handleOne = async (entry: LibraryEntry): Promise<void> => {
				if (this.cancelled) return;
				try {
					const cacheKey = `${entry.modified}|${entry.size}`;
					const cached = this.scanCache.get(entry.path);
					let status: FileStatus;
					if (cached && cached.key === cacheKey) {
						status = { ...cached.status };
					} else {
						const extension = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase();
						if (extension !== 'mp4') {
							status = { needsRepair: false, durationSeconds: null };
							this.scanCache.set(entry.path, { key: cacheKey, status });
							return;
						}
						const readResult: { kind: 'data'; buffer: ArrayBuffer } | { kind: 'timeout' } = await Promise.race([
							adapter.readBinary(entry.path).then((buffer) => ({ kind: 'data' as const, buffer })),
							new Promise<{ kind: 'timeout' }>((resolve) => {
								window.setTimeout(() => resolve({ kind: 'timeout' }), SCAN_FILE_BUDGET_MS);
							}),
						]);
						if (readResult.kind === 'timeout') {
							throw new Error(`scan budget exceeded (${SCAN_FILE_BUDGET_MS}ms)`);
						}
						const buffer = readResult.buffer;
						const data = new Uint8Array(buffer);
						const patch = inspectDurationEnhanced(data);
						const healthy =
							patch.durationSeconds !== null
							&& ((patch.staleTrackHeaders ?? 0) + (patch.mismatchedTrackHeaders ?? 0)) > 0;
						status = {
							needsRepair: healthy,
							durationSeconds: patch.durationSeconds,
						};
						this.scanCache.set(entry.path, { key: cacheKey, status });
					}
					this.statuses.set(entry.path, status);
				} catch (error) {
					if (entry.size > 0) {
						console.debug('[bfm scan] failed file', entry.path, entry.size, error instanceof Error ? error.message : String(error));
					}
					this.statuses.set(entry.path, {
						needsRepair: false,
						durationSeconds: null,
						failed: error instanceof Error ? error.message : String(error),
					});
				} finally {
					done++;
					if (done % 10 === 0 || done === total) {
						this.setProgress(true, (done / Math.max(1, total)) * 100, `Scanning ${done}/${total}…`);
					}
					if (done % 50 === 0 || done === total) {
						this.render();
					}
				}
			};

			const queue: LibraryEntry[] = [...entries];
			let cursor = 0;
			const active: Promise<void>[] = [];
			for (let i = 0; i < CONCURRENCY && cursor < queue.length; i++) {
				active.push((async () => {
					while (cursor < queue.length) {
						const idx = cursor++;
						const entry = queue[idx]!;
						await handleOne(entry);
						if (this.cancelled) return;
					}
				})());
			}
			await Promise.all(active);

			this.setProgress(true, 100, `Done · ${total} file${total === 1 ? '' : 's'} scanned.`);
			window.setTimeout(() => this.setProgress(false, 0, ''), 1200);
			this.render();
			void this.saveScanCache();
		} catch (error) {
			this.setProgress(false, 0, '');
			new Notice(error instanceof Error ? error.message : 'Scan failed.');
		} finally {
			this.busy = false;
		}
	}

	private repairStatus(item: LibraryItem): 'healthy' | 'needs-repair' | 'repaired' | 'failed' {
		const st = this.statuses.get(item.path);
		if (!st) return 'healthy';
		if (st.failed) return 'failed';
		if (st.scanning) return 'healthy';
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
			healthy: st?.scanning ? 'Scanning…' : 'Healthy',
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
		this.setProgress(true, 0, `Repairing ${item.name}…`);
		try {
			const adapter = this.app.vault.adapter as unknown as {
				readBinary(path: string): Promise<ArrayBuffer>;
				writeBinary(path: string, data: ArrayBuffer): Promise<void>;
			};
			const buffer = await adapter.readBinary(item.path);
			const data = new Uint8Array(buffer);
			const patch = inspectDurationEnhanced(data);
			const isUnhealthy = patch.durationSeconds !== null
				&& ((patch.staleTrackHeaders ?? 0) + (patch.mismatchedTrackHeaders ?? 0)) > 0;
			if (!isUnhealthy) {
				notice.hide();
				new Notice(`${item.name}: nothing to repair.`);
				const status: FileStatus = { needsRepair: false, durationSeconds: patch.durationSeconds };
				this.statuses.set(item.path, status);
				this.scanCache.set(item.path, { key: `${item.modified}|${item.size}`, status });
				await this.saveScanCache();
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
			const status: FileStatus = {
				needsRepair: false,
				durationSeconds: repaired.durationSeconds,
				repaired: repaired.durationSeconds,
			};
			this.statuses.set(item.path, status);
			this.scanCache.set(item.path, { key: `${item.modified}|${item.size}`, status });
			await this.saveScanCache();
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
			window.setTimeout(() => this.setProgress(false, 0, ''), 800);
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
		this.setProgress(true, 0, 'Checking downloaded videos…');
		try {
			const result = await repairFolder(adapter, folder, (path, done, total) => {
				this.setProgress(true, (done / Math.max(1, total)) * 100, `${done + 1}/${total} · ${path.split('/').pop() ?? path}`);
			});
			this.setProgress(true, 100, `Done · ${result.scanned} checked.`);
			const seconds = result.fixed.reduce((sum, entry) => sum + entry.durationSeconds, 0);
			const parts = [
				`${result.scanned} checked`,
				result.repaired > 0 ? `${result.repaired} repaired` : 'none needed repair',
			];
			if (result.repaired > 0) parts.push(`${Math.round(seconds / 60)} min fixed`);
			if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
			new Notice(parts.join(' · '));
			window.setTimeout(() => this.setProgress(false, 0, ''), 1500);
			await this.scan();
		} catch (error) {
			this.setProgress(false, 0, '');
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
				this.scanCache.delete(item.path);
				await this.saveScanCache();
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

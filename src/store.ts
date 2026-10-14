import { mergeCookie, pruneCookies } from './cookieStore';
import { TabStore } from './tabs';
import type { BookmarkRecord, BrowserData, CookieRecord, HistoryRecord } from './types';
import { generateId } from './utils';

export interface Persistence {
	saveData(data: unknown): Promise<void>;
}

const MAX_HISTORY = 1000;
const SAVE_DEBOUNCE_MS = 600;

/**
 * Owns all persisted browser state (tabs, history, bookmarks, cookies) and
 * debounces writes so rapid navigation does not hammer the disk.
 */
export class BrowserStore {
	readonly tabs = new TabStore();
	history: HistoryRecord[] = [];
	bookmarks: BookmarkRecord[] = [];
	cookies: CookieRecord[] = [];

	private saveTimer: number | null = null;
	private dirty = false;

	constructor(private readonly persistence: Persistence) {}

	load(data: Partial<BrowserData> | null): void {
		if (!data) return;
		if (Array.isArray(data.tabs)) {
			this.tabs.tabs = data.tabs;
			this.tabs.activeTabId = data.activeTabId ?? data.tabs[0]?.id ?? null;
		}
		this.history = Array.isArray(data.history) ? data.history : [];
		this.bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
		this.cookies = Array.isArray(data.cookies) ? pruneCookies(data.cookies) : [];
	}

	toJSON(): BrowserData {
		return {
			...this.tabs.toJSON(),
			history: this.history,
			bookmarks: this.bookmarks,
			cookies: this.cookies,
		};
	}

	/** Queue a debounced save. */
	markDirty(): void {
		this.dirty = true;
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, SAVE_DEBOUNCE_MS);
	}

	async flush(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		await this.persistence.saveData(this.toJSON());
	}

	dispose(): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.dirty) {
			this.dirty = false;
			void this.persistence.saveData(this.toJSON());
		}
	}

	// --- History -------------------------------------------------------------

	addHistory(url: string, title: string): void {
		const last = this.history[this.history.length - 1];
		if (last && last.url === url) {
			last.visitedAt = Date.now();
			last.title = title;
			this.markDirty();
			return;
		}
		this.history.push({ id: generateId(), url, title, visitedAt: Date.now() });
		if (this.history.length > MAX_HISTORY) {
			this.history.splice(0, this.history.length - MAX_HISTORY);
		}
		this.markDirty();
	}

	removeHistory(id: string): void {
		this.history = this.history.filter((entry) => entry.id !== id);
		this.markDirty();
	}

	clearHistory(): void {
		this.history = [];
		this.markDirty();
	}

	// --- Bookmarks -----------------------------------------------------------

	addBookmark(url: string, title: string): BookmarkRecord {
		const existing = this.bookmarks.find((bookmark) => bookmark.url === url);
		if (existing) return existing;
		const record: BookmarkRecord = {
			id: generateId(),
			url,
			title,
			createdAt: Date.now(),
		};
		this.bookmarks.push(record);
		this.markDirty();
		return record;
	}

	removeBookmark(id: string): void {
		this.bookmarks = this.bookmarks.filter((bookmark) => bookmark.id !== id);
		this.markDirty();
	}

	toggleBookmark(url: string, title: string): boolean {
		const existing = this.bookmarks.find((bookmark) => bookmark.url === url);
		if (existing) {
			this.removeBookmark(existing.id);
			return false;
		}
		this.addBookmark(url, title);
		return true;
	}

	isBookmarked(url: string): boolean {
		return this.bookmarks.some((bookmark) => bookmark.url === url);
	}

	// --- Cookies -------------------------------------------------------------

	get enabledCookies(): CookieRecord[] {
		return this.cookies;
	}

	writeCookie(cookie: CookieRecord): void {
		this.cookies = mergeCookie(this.cookies, cookie);
		this.markDirty();
	}

	clearCookiesForHost(host: string): void {
		const target = host.toLowerCase();
		this.cookies = this.cookies.filter(
			(cookie) => cookie.domain !== target && !target.endsWith(`.${cookie.domain}`),
		);
		this.markDirty();
	}

	clearAllCookies(): void {
		this.cookies = [];
		this.markDirty();
	}
}

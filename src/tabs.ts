import type { RenderMode, TabState } from './types';
import { clamp, generateId, titleFromUrl } from './utils';

export interface NewTabInput {
	url: string;
	displayUrl?: string;
	title?: string;
	renderMode?: RenderMode;
	proxied?: boolean;
}

/** Pure tab-list logic. Persistence and rendering live elsewhere. */
export class TabStore {
	tabs: TabState[] = [];
	activeTabId: string | null = null;

	constructor(tabs: TabState[] = [], activeTabId: string | null = null) {
		this.tabs = tabs;
		this.activeTabId = activeTabId;
	}

	get active(): TabState | null {
		return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null;
	}

	get count(): number {
		return this.tabs.length;
	}

	indexOf(id: string): number {
		return this.tabs.findIndex((tab) => tab.id === id);
	}

	get(id: string): TabState | null {
		return this.tabs.find((tab) => tab.id === id) ?? null;
	}

	create(input: NewTabInput): TabState {
		const displayUrl = input.displayUrl ?? input.url;
		const tab: TabState = {
			id: generateId(),
			title: input.title ?? titleFromUrl(displayUrl),
			url: input.url,
			displayUrl,
			history: displayUrl ? [displayUrl] : [],
			historyIndex: displayUrl ? 0 : -1,
			renderMode: input.renderMode ?? 'direct',
			proxied: input.proxied ?? false,
			lastError: null,
		};
		this.tabs.push(tab);
		this.activeTabId = tab.id;
		return tab;
	}

	remove(id: string): void {
		const index = this.indexOf(id);
		if (index < 0) return;
		this.tabs.splice(index, 1);
		if (this.activeTabId === id) {
			const fallback = this.tabs[Math.min(index, this.tabs.length - 1)];
			this.activeTabId = fallback ? fallback.id : null;
		}
	}

	activate(id: string): boolean {
		if (!this.get(id)) return false;
		this.activeTabId = id;
		return true;
	}

	move(id: string, offset: number): void {
		const index = this.indexOf(id);
		if (index < 0) return;
		const target = clamp(index + offset, 0, this.tabs.length - 1);
		if (target === index) return;
		const [tab] = this.tabs.splice(index, 1);
		if (!tab) return;
		this.tabs.splice(target, 0, tab);
	}

	update(id: string, patch: Partial<TabState>): void {
		const tab = this.get(id);
		if (!tab) return;
		Object.assign(tab, patch);
	}

	/**
	 * Record a navigation. Forward entries are discarded when the user navigates
	 * from a position that is not the tip of the history list.
	 */
	recordNavigation(id: string, displayUrl: string): void {
		const tab = this.get(id);
		if (!tab) return;
		if (tab.history[tab.historyIndex] === displayUrl) return;
		tab.history = tab.history.slice(0, tab.historyIndex + 1);
		tab.history.push(displayUrl);
		tab.historyIndex = tab.history.length - 1;
	}

	canGoBack(id: string): boolean {
		const tab = this.get(id);
		return !!tab && tab.historyIndex > 0;
	}

	canGoForward(id: string): boolean {
		const tab = this.get(id);
		return !!tab && tab.historyIndex < tab.history.length - 1;
	}

	back(id: string): string | null {
		const tab = this.get(id);
		if (!tab || tab.historyIndex <= 0) return null;
		tab.historyIndex -= 1;
		return tab.history[tab.historyIndex] ?? null;
	}

	forward(id: string): string | null {
		const tab = this.get(id);
		if (!tab || tab.historyIndex >= tab.history.length - 1) return null;
		tab.historyIndex += 1;
		return tab.history[tab.historyIndex] ?? null;
	}

	toJSON(): { tabs: TabState[]; activeTabId: string | null } {
		return { tabs: this.tabs, activeTabId: this.activeTabId };
	}
}

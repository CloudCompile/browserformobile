/**
 * A per-tab cache of natively fetched images.
 *
 * Images in a proxied page otherwise load from the app origin without the
 * site's cookies or Referer, so hotlink-protected CDNs and session-gated images
 * fail. Fetching them through the native layer and handing the page a blob URL
 * makes them ordinary local resources. Blob URLs stay valid until the tab
 * navigates or closes, so eviction never pulls an image out from under a page.
 */

export interface AssetBytes {
	bytes: Uint8Array;
	type: string;
	url: string;
}

export type AssetFetcher = (url: string) => Promise<AssetBytes | null>;

interface CachedAsset {
	blobUrl: string;
	bytes: number;
}

interface TabAssets {
	items: Map<string, CachedAsset>;
	bytes: number;
}

const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_TAB_BYTES = 32 * 1024 * 1024;

export class BrowserAssetCache {
	private readonly tabs = new Map<string, TabAssets>();
	private readonly pending = new Map<string, Promise<string | null>>();

	private tab(tabId: string): TabAssets {
		let entry = this.tabs.get(tabId);
		if (!entry) {
			entry = { items: new Map(), bytes: 0 };
			this.tabs.set(tabId, entry);
		}
		return entry;
	}

	async get(tabId: string, url: string, fetchAsset: AssetFetcher): Promise<string | null> {
		const existing = this.tabs.get(tabId)?.items.get(url);
		if (existing) return existing.blobUrl;
		const key = `${tabId}\n${url}`;
		const inFlight = this.pending.get(key);
		if (inFlight) return inFlight;

		const task = (async (): Promise<string | null> => {
			try {
				const file = await fetchAsset(url);
				if (!file || file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_ASSET_BYTES) return null;
				const state = this.tab(tabId);
				if (state.bytes + file.bytes.byteLength > MAX_TAB_BYTES) return null;
				const buffer = file.bytes.buffer.slice(
					file.bytes.byteOffset,
					file.bytes.byteOffset + file.bytes.byteLength,
				) as ArrayBuffer;
				const blobUrl = URL.createObjectURL(new Blob([buffer], { type: file.type || 'application/octet-stream' }));
				state.items.set(url, { blobUrl, bytes: file.bytes.byteLength });
				state.bytes += file.bytes.byteLength;
				return blobUrl;
			} catch {
				return null;
			} finally {
				this.pending.delete(key);
			}
		})();
		this.pending.set(key, task);
		return task;
	}

	release(tabId: string): void {
		const state = this.tabs.get(tabId);
		if (!state) return;
		for (const item of state.items.values()) URL.revokeObjectURL(item.blobUrl);
		this.tabs.delete(tabId);
	}

	dispose(): void {
		for (const tabId of Array.from(this.tabs.keys())) this.release(tabId);
		this.pending.clear();
	}
}

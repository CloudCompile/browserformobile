import { describe, expect, it } from 'vitest';

import { STORAGE_PREFIX, storageOrigin, storagePrefixes, stripPrefix } from '../src/browser/storage';

describe('browser storage scoping', () => {
	it('names a site by its origin, not its host', () => {
		expect(storageOrigin('https://example.com/watch?x=1')).toBe('https://example.com');
		expect(storageOrigin('http://example.com:8080/')).toBe('http://example.com:8080');
		expect(storageOrigin('http://example.com/')).not.toBe(storageOrigin('https://example.com/'));
	});

	it('gives pages without an origin a single fallback scope', () => {
		expect(storageOrigin('about:srcdoc')).toBe('other');
		expect(storageOrigin('blob:https://example.com/1234')).toBe('other');
		expect(storageOrigin('not a url')).toBe('other');
	});

	it('separates sites, storage kinds and tabs', () => {
		const site = storagePrefixes('https://example.com/', 'run', 'b1');
		const other = storagePrefixes('https://other.example/', 'run', 'b1');
		const tab = storagePrefixes('https://example.com/', 'run', 'b2');
		const nextRun = storagePrefixes('https://example.com/', 'next', 'b1');

		expect(site.origin).toBe('https://example.com');
		expect(site.url).toBe('https://example.com/');
		expect(site.local.startsWith(`${STORAGE_PREFIX}:l:`)).toBe(true);
		expect(site.session.startsWith(`${STORAGE_PREFIX}:s:`)).toBe(true);
		expect(site.idb.startsWith(`${STORAGE_PREFIX}:i:`)).toBe(true);
		expect(site.local).not.toBe(site.session);
		expect(site.local).not.toBe(site.idb);
		expect(site.local).not.toBe(other.local);
		expect(site.idb).not.toBe(other.idb);
		expect(site.session).not.toBe(tab.session);
		expect(site.session).not.toBe(nextRun.session);
		expect(site.local).toBe(nextRun.local);
	});

	it('strips only a prefix from the same scope', () => {
		const { local } = storagePrefixes('https://example.com/', 'run', 'b1');
		expect(stripPrefix(local, `${local}theme`)).toBe('theme');
		expect(stripPrefix(local, `${local}`)).toBe('');
		expect(stripPrefix(local, 'obsidian:theme')).toBeNull();
	});
});

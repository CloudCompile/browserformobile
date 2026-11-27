import { describe, expect, it } from 'vitest';

import { isSearchEngineHost } from '../src/browser/config';
import { cleanBrowserUserAgent, resolveBrowserUserAgent } from '../src/browser/ua';

describe('browser user agent', () => {
	it('keeps the phone identity while removing WebView-only markers', () => {
		const cleaned = cleanBrowserUserAgent(
			'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Obsidian/1.13.0',
		);
		expect(cleaned).toContain('Android 13; Pixel 7');
		expect(cleaned).toContain('Chrome/120.0.0.0 Mobile Safari/537.36');
		expect(cleaned).not.toMatch(/;\s*wv/i);
		expect(cleaned).not.toContain('Version/4.0');
		expect(cleaned).not.toContain('Obsidian/');
	});

	it('uses an explicit UA instead of detecting a new one', () => {
		expect(resolveBrowserUserAgent('  Mozilla/5.0 (Linux; Android 14; Pixel 8)  ')).toBe(
			'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
		);
	});

	it('resolves the automatic setting to a usable browser UA', () => {
		expect(resolveBrowserUserAgent('')).toMatch(/^Mozilla\/5\.0 /);
	});

	it('recognises search-engine hosts that must stay proxied', () => {
		expect(isSearchEngineHost('duckduckgo.com')).toBe(true);
		expect(isSearchEngineHost('www.google.com')).toBe(true);
		expect(isSearchEngineHost('www.google.co.uk')).toBe(true);
		expect(isSearchEngineHost('search.brave.com')).toBe(true);
		expect(isSearchEngineHost('news.example.com')).toBe(false);
		expect(isSearchEngineHost('notgoogle.com')).toBe(false);
	});
});

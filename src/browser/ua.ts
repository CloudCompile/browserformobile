import { Platform } from 'obsidian';

import { DEFAULT_BROWSER_UA } from './config';

/**
 * The browser's user agent.
 *
 * A fixed Android string makes every phone claim to be the same Pixel, and a
 * raw WebView string is often enough for a site to serve a degraded page. The
 * automatic path uses the device's own UA, with the WebView-only markers that
 * trigger "unsupported browser" pages removed.
 */

const IOS_FALLBACK_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const DESKTOP_FALLBACK_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Strip the parts of a WebView UA that make sites treat the browser as an app
 * shell rather than a phone browser. The device model, Android/iOS version and
 * engine version are kept.
 */
export function cleanBrowserUserAgent(raw: string | null | undefined): string {
	let ua = String(raw ?? '').replace(/\s+/g, ' ').trim();
	if (!ua) return '';
	ua = ua.replace(/;\s*wv\b/gi, '');
	ua = ua.replace(/\s+Version\/4\.0\b/gi, '');
	ua = ua.replace(/\s+(?:Obsidian|obsidian|Electron)\/[\w.-]+/g, '');
	ua = ua.replace(/;\s*\)/g, ')');
	ua = ua.replace(/;\s*;/g, ';');
	return ua.replace(/\s{2,}/g, ' ').trim();
}

/** The device's own UA, or a platform-appropriate fallback. */
export function detectBrowserUserAgent(): string {
	// The request is the UA text itself; the OS decision below uses Platform.
	const actual =
		typeof window === 'undefined' ? '' : cleanBrowserUserAgent(window.navigator.userAgent);
	// Platform decides the OS; navigator only supplies the UA text, because
	// the point is to preserve the actual device model and engine version.
	if (Platform.isIosApp) return actual || IOS_FALLBACK_UA;
	if (Platform.isAndroidApp) return actual || DEFAULT_BROWSER_UA;
	if (actual.includes('Mozilla/')) return actual;
	return DESKTOP_FALLBACK_UA;
}

/**
 * Resolve the setting: an explicit string wins, otherwise the device is
 * detected. Empty is the default and means automatic.
 */
export function resolveBrowserUserAgent(configured: string | null | undefined): string {
	const custom = cleanBrowserUserAgent(configured);
	return custom || detectBrowserUserAgent();
}

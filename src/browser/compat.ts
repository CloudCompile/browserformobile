/** Small helpers shared by the browser view, engine and tests. */

export interface MetaRefresh {
	url: string;
	delayMs: number;
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname || url;
	} catch {
		return url;
	}
}

/**
 * Whether a page's own headers let it be embedded at all.
 *
 * The direct compatibility frame runs the site at its real origin, so it only
 * helps on sites that do not deny framing. `SAMEORIGIN` denies us because the
 * app is a different origin; `ALLOW-FROM` is obsolete and is not relied on.
 */
export function framingAllowed(headers: Record<string, string>): boolean {
	const xFrame = headers['x-frame-options']?.trim().toLowerCase();
	if (xFrame) {
		if (xFrame.includes('deny') || xFrame.includes('sameorigin')) return false;
		if (xFrame.includes('allow-from')) return false;
	}

	const csp = headers['content-security-policy'];
	if (csp) {
		for (const directive of csp.split(';')) {
			const trimmed = directive.trim();
			if (!/^frame-ancestors\b/i.test(trimmed)) continue;
			const sources = trimmed
				.slice(trimmed.indexOf(' ') + 1)
				.split(/\s+/)
				.map((source) => source.trim().toLowerCase())
				.filter(Boolean);
			if (sources.length === 0) return false;
			if (sources.includes('*')) return true;
			// The app's own origins are not the site's origin, so 'self' never
			// matches. A page that names only itself denies the embedded view.
			return false;
		}
	}
	return true;
}

/** Read a `<meta http-equiv="refresh">` value without letting it loop forever. */
export function parseMetaRefresh(content: string, pageUrl: string): MetaRefresh | null {
	const match = /^\s*(\d+(?:\.\d+)?)\s*(?:;\s*url\s*=\s*)?(.*)$/i.exec(content);
	if (!match) return null;
	const seconds = Number(match[1]);
	const raw = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
	if (!raw || !Number.isFinite(seconds)) return null;
	try {
		const url = new URL(raw, pageUrl);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return { url: url.href, delayMs: Math.max(0, Math.min(30_000, seconds * 1000)) };
	} catch {
		return null;
	}
}

/**
 * A conservative blank-page check. A page with only an empty app shell is
 * probably a script failure; a form, image, canvas or video means the page is
 * doing something even when it has little text.
 */
export function looksBlank(textLength: number, richElementCount: number): boolean {
	return textLength < 32 && richElementCount === 0;
}

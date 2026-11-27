/**
 * The synopsis on the source's own series page.
 *
 * The 18+ provider's API record carries no real description: its `description`
 * field is the generated line ("Watch <title> hentai online free in HD with
 * English subtitles. N episodes, Ongoing. Genres: …"), which is why the plugin
 * refuses to show it. The provider's *page* does carry a real synopsis — the
 * site's own write-up for the series, under a "Synopsis" heading.
 *
 * There is no API field for it, so the page is read directly and the text is
 * taken out of the block the site renders it in. The page is a lightweight HTML
 * document (~120 KB), fetched with the same native HTTP stack the embedded
 * browser uses — CapacitorHttp on Android, `requestUrl` on desktop — so this
 * works on every platform the plugin supports.
 *
 * Everything here is tolerant by design: a page that cannot be fetched, has no
 * synopsis block, or answers with a challenge page simply yields null, and the
 * details page renders without a synopsis exactly as it did before.
 */

import { decodeText, nativeRequest } from './browser/http';

/** How many characters of a synopsis are worth keeping. */
const MAX_SYNOPSIS_LENGTH = 4000;

/** A desktop browser UA: the source answers bare bot requests with a challenge. */
const PAGE_USER_AGENT =
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/** Turn the synopsis block's HTML into one plain paragraph of text. */
function textFromHtml(fragment: string): string {
        const doc = new DOMParser().parseFromString(`<body>${fragment}</body>`, 'text/html');
        // Paragraph breaks inside the block are real line breaks in prose.
        for (const br of Array.from(doc.querySelectorAll('br'))) br.replaceWith('\n');
        for (const block of Array.from(doc.querySelectorAll('p, div'))) {
                block.append('\n');
        }
        const text = (doc.body.textContent ?? '')
                .replace(/\r/g, '')
                .replace(/[ \t]+/g, ' ')
                .replace(/\s*\n\s*\n\s*/g, '\n\n')
                .trim();
        return text.length > MAX_SYNOPSIS_LENGTH ? `${text.slice(0, MAX_SYNOPSIS_LENGTH).trimEnd()}…` : text;
}

/**
 * Pull the synopsis out of a provider series page.
 *
 * The site renders it as `<div class="dsc-desc"><p>…</p></div>` under a
 * "Synopsis" heading. The class is tried first because it is the specific
 * block; failing that, the last heading that literally reads "Synopsis" is
 * followed to its next element, which survives a theme update that renames the
 * class. An inline script in the page also mentions the class, so the match
 * requires the real block markup (`<div … class="dsc-desc" …>`), never the
 * first occurrence of the string.
 */
export function synopsisFromPageHtml(html: string): string | null {
        if (typeof html !== 'string' || html.length === 0) return null;
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const block = doc.querySelector('.dsc-desc');
        const fromBlock = block ? textFromHtml(block.innerHTML) : '';
        if (fromBlock) return fromBlock;

        for (const heading of Array.from(doc.querySelectorAll('h1, h2, h3, h4'))) {
                if (!/^\s*synopsis\s*$/i.test(heading.textContent ?? '')) continue;
                const next = heading.nextElementSibling;
                const text = next ? textFromHtml(next.innerHTML) : '';
                if (text) return text;
        }
        return null;
}

/** A page-level guess at why there is no synopsis, for the debug log only. */
function describePageFailure(status: number, html: string): string {
        if (status >= 400) return `HTTP ${status}`;
        if (/just a moment|cf-challenge|attention required/i.test(html)) return 'challenge page';
        if (html.length < 500) return 'empty page';
        return 'no synopsis block';
}

/**
 * Read the synopsis from a series' page on the provider.
 *
 * Returns null on any failure — no page URL, a network error, a challenge page,
 * a page without the block — because the caller must be able to render the
 * details page whether or not the source cooperates.
 */
export async function loadProviderSynopsis(
        pageUrl: string | null | undefined,
        onDebug?: (message: string, details?: unknown) => void,
): Promise<string | null> {
        if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return null;
        try {
                const response = await nativeRequest({
                        url: pageUrl,
                        method: 'GET',
                        headers: {
                                'User-Agent': PAGE_USER_AGENT,
                                Accept: 'text/html,application/xhtml+xml',
                                'Accept-Language': 'en-US,en;q=0.9',
                        },
                });
                const html = decodeText(response.bytes, response.headers['content-type']);
                onDebug?.('synopsis.page.fetched', {
                        url: pageUrl,
                        status: response.status,
                        url_after: response.url,
                        bytes: response.bytes.byteLength,
                        hasBlock: html.includes('dsc-desc'),
                });
                const synopsis = synopsisFromPageHtml(html);
                if (!synopsis) {
                        onDebug?.('synopsis.page.none', { url: pageUrl, reason: describePageFailure(response.status, html) });
                }
                return synopsis;
        } catch (error) {
                onDebug?.('synopsis.page.failed', {
                        url: pageUrl,
                        error: error instanceof Error ? error.message : String(error),
                });
                return null;
        }
}

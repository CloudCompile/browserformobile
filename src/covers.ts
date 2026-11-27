/**
 * Poster and cover resolution.
 *
 * Two things break image display in a plugin-hosted page, and neither is the
 * stylesheet's fault:
 *
 *  - a URL in a metadata field is not always a URL that renders. A provider's
 *    poster can 404 (a page-scraped path that moved), and a hotlink-protected
 *    CDN can refuse the request;
 *  - a catalogue entry can carry no poster at all.
 *
 * So a cover is shown *if it loads*, and the page's layout is built for the
 * case where it does not: a drawn placeholder (a gradient plus the title's
 * initials) instead of an empty frame. The same placeholder is what the hero's
 * backdrop uses, so a series with no usable art still has a cover.
 *
 * No Obsidian import: this is ordinary DOM code, shared by every surface that
 * draws a poster.
 */

/** The element an image should be swapped into when it fails. */
/** First letters of a title, at most two, for a placeholder. */
export function initialsFor(title: string): string {
        const words = (title ?? '')
                .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
                .split(/\s+/)
                .filter(Boolean);
        if (words.length === 0) return '?';
        const first = words[0]?.charAt(0) ?? '?';
        const second = words.length > 1 ? words[1]?.charAt(0) ?? '' : words[0]?.charAt(1) ?? '';
        return (first + second).toUpperCase();
}

/**
 * A stable hue for a title, so the same series always gets the same placeholder
 * colour across the library, the details page and the recommendations.
 */
export function hueFor(title: string): number {
        let hash = 0;
        for (const character of title ?? '') {
                hash = (hash * 31 + character.charCodeAt(0)) % 360;
        }
        return hash;
}

/**
 * Make a decorative placeholder: a soft two-tone gradient under big initials.
 * `variant` only changes the gradient's angle, so adjacent placeholders in a
 * grid do not look like copies of one another.
 */
export function fillPlaceholder(host: HTMLElement, title: string, variant = 'poster'): HTMLElement {
        host.empty();
        host.addClass('bfm-cover-placeholder');
        host.addClass(`is-${variant}`);
        host.setCssProps({ '--bfm-cover-hue': String(hueFor(title)) });
        host.createSpan({ cls: 'bfm-cover-initials', text: initialsFor(title) });
        return host;
}

/**
 * Draw a poster that is replaced by a placeholder if it cannot be shown.
 *
 * `onFail` runs after the fallback is drawn, so a caller that needs to restyle
 * its own wrapper (the hero's backdrop, say) can.
 */
export function createCover(
        host: HTMLElement,
        url: string | null | undefined,
        title: string,
        options: {
                imageClass: string;
                /** The placeholder's class, when it differs from the host's. */
                fallbackClass?: string;
                /** 'poster' for a 2:3 card, 'wide' for a backdrop or rail. */
                variant?: 'poster' | 'wide';
                onFail?: () => void;
        },
): void {
        const variant = options.variant ?? 'poster';
        const placeholder = host.createDiv({ cls: options.fallbackClass ?? 'bfm-cover-fallback' });
        if (!url) {
                fillPlaceholder(placeholder, title, variant);
                options.onFail?.();
                return;
        }
        const image = host.createEl('img', {
                cls: `${options.imageClass} is-loaded`,
                attr: { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' },
        });
        image.addEventListener('error', () => {
                image.remove();
                fillPlaceholder(placeholder, title, variant);
                options.onFail?.();
        });
        image.addEventListener('load', () => {
                placeholder.remove();
                options.onFail?.();
        });
}

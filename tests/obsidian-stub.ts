export function requestUrl(): never {
        throw new Error('requestUrl is not available in tests');
}

/**
 * Obsidian's path helper, which collapses `//` and strips leading/trailing
 * slashes. The real one lives in the app bundle; only vault path handling is
 * exercised here.
 */
export function normalizePath(path: string): string {
        return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export const Platform = {
        isDesktopApp: false,
        isMobileApp: true,
        isAndroidApp: false,
        isIosApp: false,
};

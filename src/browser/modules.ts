import { init, parse } from 'es-module-lexer/js';

/**
 * ES module helpers.
 *
 * A proxied page cannot load a relative module from the site, because its
 * document URL is the `srcdoc` URL. The inliner fetches the graph natively and
 * rewrites each specifier to an absolute URL, then maps those URLs to blob
 * modules with an import map. The parser is the CSP build of es-module-lexer,
 * so it does not need WebAssembly eval inside Obsidian.
 */

export interface ModuleSpecifier {
	start: number;
	end: number;
	specifier: string;
	dynamic: boolean;
}

export interface BrowserImportMap {
	imports: Record<string, string>;
	scopes: Record<string, Record<string, string>>;
}

let lexerReady: Promise<void> | null = null;

async function ensureLexer(): Promise<void> {
	if (!lexerReady) lexerReady = init();
	await lexerReady;
}

/** The resolvable imports in a module, with exact source ranges. */
export async function readModuleImports(source: string): Promise<ModuleSpecifier[]> {
	await ensureLexer();
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(source);
	} catch {
		return [];
	}
	const found: ModuleSpecifier[] = [];
	for (const entry of parsed[0]) {
		if (entry.type === 'import-meta') continue;
		if (!entry.specifier) continue;
		if (entry.type === 'dynamic' && entry.glob) continue;
		found.push({
			start: entry.start,
			end: entry.end,
			specifier: entry.specifier,
			dynamic: entry.type === 'dynamic',
		});
	}
	return found;
}

function escapeSpecifier(value: string, quote: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(new RegExp(quote, 'g'), `\\${quote}`)
		.replace(/\r/g, '\\r')
		.replace(/\n/g, '\\n');
}

/** Replace only the parser-reported specifier ranges, leaving the rest alone. */
export function rewriteModuleSpecifiers(
	source: string,
	imports: ModuleSpecifier[],
	resolve: (specifier: string) => string | null,
): string {
	let result = source;
	let offset = 0;
	for (const entry of [...imports].sort((left, right) => left.start - right.start)) {
		const replacement = resolve(entry.specifier);
		if (!replacement || replacement === entry.specifier) continue;
		let text: string;
		if (entry.dynamic) {
			text = JSON.stringify(replacement);
		} else {
			const quote = source.charAt(entry.start - 1);
			if (quote !== '"' && quote !== "'") continue;
			text = escapeSpecifier(replacement, quote);
		}
		const start = entry.start + offset;
		const end = entry.end + offset;
		result = result.slice(0, start) + text + result.slice(end);
		offset += text.length - (entry.end - entry.start);
	}
	return result;
}

function normaliseValue(value: string, baseUrl: string): string {
	const trimmed = value.trim();
	if (!trimmed) return trimmed;
	if (/^(https?:|data:|blob:)/i.test(trimmed)) return trimmed;
	try {
		return new URL(trimmed, baseUrl).href;
	} catch {
		return trimmed;
	}
}

function isUrlLike(specifier: string): boolean {
	return /^(https?:|data:|blob:|\/|\.{1,2}\/)/i.test(specifier);
}

/** Normalise an import map read from a page, resolving its values. */
export function normaliseImportMap(raw: unknown, baseUrl: string): BrowserImportMap {
	const map: BrowserImportMap = { imports: {}, scopes: {} };
	if (!raw || typeof raw !== 'object') return map;
	const source = raw as { imports?: unknown; scopes?: unknown };
	if (source.imports && typeof source.imports === 'object') {
		for (const [key, value] of Object.entries(source.imports as Record<string, unknown>)) {
			if (typeof value !== 'string') continue;
			const normalisedKey = isUrlLike(key) ? normaliseValue(key, baseUrl) : key;
			map.imports[normalisedKey] = normaliseValue(value, baseUrl);
		}
	}
	if (source.scopes && typeof source.scopes === 'object') {
		for (const [scope, entries] of Object.entries(source.scopes as Record<string, unknown>)) {
			if (!entries || typeof entries !== 'object') continue;
			const normalisedScope = normaliseValue(scope, baseUrl);
			const record: Record<string, string> = {};
			for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
				if (typeof value !== 'string') continue;
				const normalisedKey = isUrlLike(key) ? normaliseValue(key, baseUrl) : key;
				record[normalisedKey] = normaliseValue(value, baseUrl);
			}
			map.scopes[normalisedScope] = record;
		}
	}
	return map;
}

/** Parse an `<script type="importmap">` body; null when it is not valid JSON. */
export function parseImportMapJson(text: string, baseUrl: string): BrowserImportMap | null {
	try {
		return normaliseImportMap(JSON.parse(text) as unknown, baseUrl);
	} catch {
		return null;
	}
}

function lookup(entries: Record<string, string>, specifier: string): string | null {
	if (Object.prototype.hasOwnProperty.call(entries, specifier)) return entries[specifier] ?? null;
	let bestKey = '';
	for (const key of Object.keys(entries)) {
		if (key.endsWith('/') && specifier.startsWith(key) && key.length > bestKey.length) {
			bestKey = key;
		}
	}
	if (!bestKey) return null;
	const base = entries[bestKey];
	if (!base) return null;
	return base + specifier.slice(bestKey.length);
}

/**
 * Resolve a module specifier against its importer and the page's import map.
 * Returns null for a bare package with no mapping; the caller leaves it alone.
 */
export function resolveModuleSpecifier(
	specifier: string,
	importerUrl: string,
	map: BrowserImportMap,
): string | null {
	if (!specifier || specifier.startsWith('#')) return null;
	if (/^(data:|blob:)/i.test(specifier)) return specifier;
	if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
		try {
			return new URL(specifier).href;
		} catch {
			return null;
		}
	}
	if (specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../')) {
		try {
			return new URL(specifier, importerUrl).href;
		} catch {
			return null;
		}
	}

	let bestScope = '';
	for (const scope of Object.keys(map.scopes)) {
		if (importerUrl.startsWith(scope) && scope.length > bestScope.length) bestScope = scope;
	}
	if (bestScope) {
		const scoped = lookup(map.scopes[bestScope] ?? {}, specifier);
		if (scoped) return scoped;
	}
	return lookup(map.imports, specifier);
}

/** The browser's own origin for a URL, or an empty string. */
export function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return '';
	}
}

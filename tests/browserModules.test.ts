import { describe, expect, it } from 'vitest';

import {
	normaliseImportMap,
	parseImportMapJson,
	readModuleImports,
	resolveModuleSpecifier,
	rewriteModuleSpecifiers,
} from '../src/browser/modules';

describe('browser module rewriting', () => {
	it('finds static, re-export and dynamic specifiers without touching strings', async () => {
		const source = [
			'import x from "./x.js";',
			'export * from "./y.js";',
			'const label = "import not-a-module from \\"./fake.js\\"";',
			'const z = await import("./z.js");',
			'console.log(import.meta.url);',
		].join('\n');
		const imports = await readModuleImports(source);
		expect(imports.map((entry) => entry.specifier)).toEqual(['./x.js', './y.js', './z.js']);
		expect(imports.map((entry) => entry.dynamic)).toEqual([false, false, true]);
	});

	it('rewrites only specifier ranges and preserves the rest of the source', async () => {
		const source = 'import x from "./x.js";\nconst y = import("./y.js");\nconst s = "./not-a-module";';
		const imports = await readModuleImports(source);
		const rewritten = rewriteModuleSpecifiers(source, imports, (specifier) => {
			if (specifier === './x.js') return 'https://cdn.example.com/x.js';
			if (specifier === './y.js') return 'https://cdn.example.com/y.js';
			return null;
		});
		expect(rewritten).toContain('from "https://cdn.example.com/x.js"');
		expect(rewritten).toContain('import("https://cdn.example.com/y.js")');
		expect(rewritten).toContain('const s = "./not-a-module";');
	});

	it('resolves relative imports and import-map packages', () => {
		const map = normaliseImportMap(
			{
				imports: {
					react: 'https://esm.example.com/react.js',
					'lib/': 'https://esm.example.com/lib/',
				},
			},
			'https://site.example.com/page/',
		);
		expect(resolveModuleSpecifier('./local.js', 'https://site.example.com/a/b.js', map)).toBe(
			'https://site.example.com/a/local.js',
		);
		expect(resolveModuleSpecifier('react', 'https://site.example.com/a/b.js', map)).toBe(
			'https://esm.example.com/react.js',
		);
		expect(resolveModuleSpecifier('lib/thing.js', 'https://site.example.com/a/b.js', map)).toBe(
			'https://esm.example.com/lib/thing.js',
		);
		expect(resolveModuleSpecifier('unmapped', 'https://site.example.com/a/b.js', map)).toBeNull();
	});

	it('normalises a page import map and ignores invalid JSON', () => {
		const map = parseImportMapJson(
			'{"imports":{"./app.js":"./src/app.js"},"scopes":{"https://site.example.com/app/":{"pkg":"./pkg.js"}}}',
			'https://site.example.com/',
		);
		expect(map?.imports['https://site.example.com/app.js']).toBe(
			'https://site.example.com/src/app.js',
		);
		// Import-map values resolve against the map's base URL, not the scope key.
		expect(map?.scopes['https://site.example.com/app/']?.['pkg']).toBe(
			'https://site.example.com/pkg.js',
		);
		expect(parseImportMapJson('{', 'https://site.example.com/')).toBeNull();
	});
});

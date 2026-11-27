import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The shared packages are resolved the same way esbuild resolves them: from
 * `packages/*` in this repository, or from the generated `vendor/` copies in the
 * standalone mirror, where `packages/` does not exist.
 */
const shared = (name: string): string => {
	const source = new URL(`../../packages/${name}/src/index.js`, import.meta.url);
	return existsSync(fileURLToPath(source))
		? fileURLToPath(source)
		: fileURLToPath(new URL(`./vendor/anime-${name}.js`, import.meta.url));
};

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		setupFiles: ['tests/setup.ts'],
	},
	resolve: {
		alias: {
			obsidian: new URL('./tests/obsidian-stub.ts', import.meta.url).pathname,
			'@anime/hls': shared('hls'),
			'@anime/catalogue': shared('catalogue'),
		},
	},
});

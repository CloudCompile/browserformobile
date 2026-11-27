import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'tests',
		'vitest.config.ts',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		// Vendored third-party engine, minified and outside our TS project.
		'src/vendor',
		// Generated copies of packages/* (npm run vendor); the drift check in
		// `npm test` is what verifies them, not the linter.
		'vendor',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					// Paths resolve from tsconfigRootDir. The build scripts run under
					// Node and are outside the TS project, which includes only src/.
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'scripts/*.mjs'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Build scripts, not shipped code: Node built-ins and console output are
		// correct here even though they would be wrong inside the plugin itself.
		files: ['scripts/*.mjs'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
			'obsidianmd/rule-custom-message': 'off',
			'no-undef': 'off',
		},
	},
	{
		// `packages/*` are linked into this app by path and inlined into main.js at
		// build time; they are deliberately not dependencies, because the mirror
		// has neither the packages nor a workspace to resolve them from.
		files: ['src/**/*.ts'],
		rules: { 'import/no-extraneous-dependencies': 'off' },
	},
	{
		// This file exists to expose the device's user-agent string; the rule's
		// purpose (choosing an OS path) still uses Platform, not the UA.
		files: ['src/browser/ua.ts'],
		rules: { 'obsidianmd/platform': 'off' },
	},
);

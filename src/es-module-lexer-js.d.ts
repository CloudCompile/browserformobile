/**
 * The package publishes a CSP/asm.js build under this subpath, but its
 * `exports` map is only understood by TypeScript's node16/bundler resolution.
 * The project uses classic node resolution, so mirror the root types here.
 */
declare module 'es-module-lexer/js' {
	export * from 'es-module-lexer';
}

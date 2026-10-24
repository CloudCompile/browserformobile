/**
 * The test environment is Node, which has no `window`. The cache debounces its
 * writes with `window.setTimeout`, matching the plugin's other stores, so the
 * global is provided here rather than avoided in the source.
 */
const scope = globalThis as unknown as { window?: unknown };
if (typeof scope.window === 'undefined') {
	scope.window = globalThis;
}

#!/usr/bin/env node
/**
 * Fails when the built `main.js` still needs `@anime/*` at runtime.
 *
 * The shared packages are bundled into `main.js` (esbuild inlines everything
 * that is not in `external`). If an import of `@anime/*` ever escapes the
 * bundle, the plugin would load fine in this repo and fail on a user's phone
 * with "Cannot find module '@anime/…'" — after Obsidian has already accepted
 * the release. This is the check that catches it before that.
 *
 * Run by `npm run build`, so CI and a local release both run it.
 */
import { readFileSync } from 'node:fs';

const bundle = readFileSync('main.js', 'utf8');
const pattern = /require\(\s*["'](@anime\/[^"']+)["']\s*\)|import\(\s*["'](@anime\/[^"']+)["']\s*\)|from\s*["'](@anime\/[^"']+)["']/g;
const leftovers = [...bundle.matchAll(pattern)]
  .map((match) => match[1] || match[2] || match[3])
  .filter(Boolean);

if (leftovers.length > 0) {
  console.error(`main.js still imports ${[...new Set(leftovers)].join(', ')} at runtime.`);
  console.error('The shared packages must be bundled: check the esbuild `external` list.');
  process.exit(1);
}

console.log('ok: no @anime/* import survives in main.js');

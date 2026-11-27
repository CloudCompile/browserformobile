#!/usr/bin/env node
/**
 * Rewrites `vendor/anime-*.js` from the monorepo's `packages/*`.
 *
 * The plugin builds against its own copy of the shared code because the mirror
 * has no `packages/` directory. The copy is generated, never hand-edited:
 * `--check` (what `npm test` runs) exits non-zero when the two have drifted, so
 * a change to a package cannot reach the plugin's users as a silent stale copy.
 *
 * The esbuild config picks the package when it can be resolved and the vendored
 * copy otherwise, so both this repository and the mirror build without edits.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const check = process.argv.includes('--check');

const SOURCES = [
  { from: '../../packages/hls/src/index.js', to: 'vendor/anime-hls.js', generated: 'packages/hls/src/index.js' },
  { from: '../../packages/catalogue/src/index.js', to: 'vendor/anime-catalogue.js', generated: 'packages/catalogue/src/index.js' },
  // The types travel with the code: the mirror has no packages/ directory for
  // tsconfig's `paths` to point at, so it points at these copies instead.
  { from: '../../packages/hls/src/index.d.ts', to: 'vendor/anime-hls.d.ts', generated: 'packages/hls/src/index.d.ts' },
  { from: '../../packages/catalogue/src/index.d.ts', to: 'vendor/anime-catalogue.d.ts', generated: 'packages/catalogue/src/index.d.ts' },
];

function banner(name, file) {
  if (file.endsWith('.d.ts')) {
    return [
      '/**',
      ` * GENERATED from ${name} — do not edit.`,
      ' * Types for the vendored copy in the standalone plugin mirror.',
      ' */',
      '',
    ].join('\n');
  }
  return [
    '/**',
    ` * GENERATED from ${name} — do not edit.`,
    ' *',
    ' * The standalone plugin mirror has no packages/ directory, so this copy is what',
    ' * it builds against. `npm run vendor` (scripts/vendor-shared.mjs) rewrites it',
    ' * from the monorepo\'s copy, and `npm test` fails if the two have drifted;',
    ' * scripts/check-shared.mjs proves the generated branch leaves no @anime import',
    ' * in main.js.',
    ' */',
    '',
  ].join('\n');
}

// In the mirror the packages are not present at all: the vendored copies are not
// a copy of anything there, they are the source. Nothing to compare, nothing to
// regenerate.
if (!SOURCES.every((source) => existsSync(join(root, source.from)))) {
  if (!check) console.log('no packages/ here (the standalone mirror); nothing to vendor');
  process.exit(0);
}

let drift = 0;
for (const source of SOURCES) {
  const sourcePath = join(root, source.from);
  const targetPath = join(root, source.to);
  const expected = `${banner(source.generated, source.to)}${readFileSync(sourcePath, 'utf8')}`;
  const actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  if (actual === expected) {
    if (!check) console.log(`ok      ${source.to}`);
    continue;
  }
  if (check) {
    console.error(`DRIFT   ${source.to} does not match ${source.generated}`);
    drift += 1;
    continue;
  }
  writeFileSync(targetPath, expected);
  console.log(`written ${source.to}`);
}

if (drift > 0) {
  console.error('\nRun `npm run vendor` and commit the result.');
  process.exit(1);
}

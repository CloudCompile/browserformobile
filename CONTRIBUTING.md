# Contributing to Anime for Mobile

Thank you for wanting to help. This is a small plugin with strong constraints —
reading this file first will save us both a round trip.

## What this plugin is

An Obsidian plugin (id `browser-for-mobile`, name **Anime for Mobile**) that
searches an anime catalogue, downloads episodes in the background with resume,
keeps an offline library that plays them, and recommends what to watch next
from your download history. It runs on iOS and Android first; desktop is a
convenience, not the target.

## Setting up

```bash
npm install
npm run dev      # esbuild watch build
npm run build    # tsc + production esbuild
npm run lint     # eslint, must be clean: 0 errors, 0 warnings
npm test         # vitest, the committed gate
```

The build checks TypeScript strictly and bundles everything into `main.js`.
Never commit `main.js`, `node_modules/`, or other generated files.

## The constraints that shape everything

These are the rules of the codebase. A change that fights one of them will be
asked to change shape before it is reviewed for content.

1. **Mobile first.** Memory is the scarcest resource. Streams are never held
   whole: the transmuxer is flushed a window at a time, writes are coalesced
   within `batchCeiling()`'s device-scaled bounds, and any change that raises
   peak memory for an episode needs to justify itself in the PR description.
2. **Writes are serialized, in order.** Segment writes go through the per-file
   write chain in `destination.ts` and the ordered drain loop in `hls.ts`.
   Out-of-order appends corrupt files.
3. **The download folder is the library's index.** There is no database; the
   library scans the folder every time it opens. Filenames are parsed back with
   the same template the downloader writes, so template tokens must round-trip.
4. **Every listener, timer, and interval is registered** with the plugin's
   `register*` helpers, so unload cannot leak. `DownloadManager.dispose` clears
   its retry timers for the same reason.
5. **`saveSettings()` writes the whole `data.json`.** Any new persisted key must
   join `PersistedShape`, load in `loadSettings`, and ride the one `saveData`
   call — anything else is silently dropped by the next save.
6. **Recommendations always render.** Every model failure path returns the
   deterministic ranking; nothing may surface a model error, and the curator
   may re-order and prune but **never add** titles.
7. **Privacy is a feature.** Nothing leaves the device except the catalogue
   requests themselves and the opt-in hosted model (taste profile and candidate
   titles only, never file contents). A change that adds a network call beyond
   the catalogue or the model settings will not be accepted.
8. **Honest UI.** Streams are 720p; dub and filler flags are unreliable. Do not
   present a setting as promising something the source does not deliver.

## Pull requests

- One feature or fix per PR, described in terms of what a user will notice.
- `npm run build`, `npm run lint`, and `npm test` must pass; CI runs all three
  on every push.
- New logic gets tests where it can live without Obsidian or the network — the
  pure modules (`mp4.ts`, `recommend.ts`, `perf.ts`, `library.ts`, `utils.ts`,
  `animeCache.ts`, `decision.ts`) are structured so they can.
- If the change touches download, resume, repair, or memory, say what you
  measured. The repo's history is full of fixes picked by measurement; a claim
  like "should be faster" is treated as untested.
- Update `CHANGELOG.md` (a section under **Unreleased** if one does not exist)
  and, if it changes behaviour a user can see, the README.

## Cutting a release

The manual half is three files, one commit, one tag; everything after the tag
push is the workflow's job, and re-running it for the same tag updates the
existing release instead of drafting a duplicate.

1. Bump `version` in `manifest.json` and `package.json`, and add the
   `versions.json` entry (8-space indent, preserved by hand).
2. Prepend the `CHANGELOG.md` section for the version. The workflow extracts
   the section matching the tag for the release notes — a tag without a
   matching `## X.Y.Z` heading publishes with empty notes, so the section is
   part of the release, not an afterthought.
3. One `Release X.Y.Z` commit, one tag named exactly `X.Y.Z` (no leading `v`),
   push both.
4. The tag push builds, lints, tests, attests provenance, and drafts a release
   with `main.js`, `manifest.json`, and `styles.css`. Publishing and setting
   Latest are the human steps.
5. If the tag must be re-cut (a failed publish, a rebuilt asset): fix, re-tag,
   push again. The workflow sees the existing release and updates it in place
   — assets re-uploaded with `--clobber`, notes refreshed — rather than
   drafting a second one.

A user-facing improvement is a minor bump with a `.5` patch (3.10.5); a plain
`.0` minor marks structural work.

## Reporting bugs

Open a GitHub issue with the bug report template. Mobile-only reports: use the
**Export debug log** command and the diagnostics report — the log contains
non-secret runtime details, and "it stops at 43%" without it is not
reproducible. Attach the exported file, not a screenshot of it.

## Feature requests

Check [ROADMAP.md](ROADMAP.md) first — if it is listed, add a thumbs-up on the
issue rather than a new one; if it is not, open one and it will be triaged into
a milestone or the backlog. Anything that widens what the plugin sends to the
hosted model, or reintroduces an embedded browser, is a non-goal.

# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- **Package manager: npm** (required for this sample - `package.json` defines npm scripts and dependencies).
- **Bundler: esbuild** (required for this sample - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.

**Note**: This sample project has specific technical dependencies on npm and esbuild. If you're creating a plugin from scratch, you can choose different tools, but you'll need to replace the build configuration accordingly.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- ESLint is preconfigured with `eslint-plugin-obsidianmd` for Obsidian-specific rules.
- Run `npm run lint` to lint the project.
- A GitHub Action automatically lints every commit on all branches.

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
    ```
    src/
      main.ts           # Plugin entry point, lifecycle management
      settings.ts       # Settings interface and defaults
      commands/         # Command implementations
        command1.ts
        command2.ts
      ui/              # UI components, modals, views
        modal.ts
        view.ts
      utils/           # Utility functions, helpers
        helpers.ts
        constants.ts
      types.ts         # TypeScript interfaces and types
    ```
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):
    - `id` (plugin ID; for local dev it should match the folder name)
    - `name`
    - `version` (Semantic Versioning `x.y.z`)
    - `minAppVersion`
    - `description`
    - `isDesktopOnly` (boolean)
    - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
    ```
    <Vault>/.obsidian/plugins/<plugin-id>/
    ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**

- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**

- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks

### Organize code across multiple files

**main.ts** (minimal, lifecycle only):

```ts
import { Plugin } from 'obsidian';
import { MySettings, DEFAULT_SETTINGS } from './settings';
import { registerCommands } from './commands';

export default class MyPlugin extends Plugin {
	settings!: MySettings;

	async onload() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MySettings>,
		);
		registerCommands(this);
	}
}
```

**settings.ts**:

```ts
export interface MySettings {
	enabled: boolean;
	apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
	enabled: true,
	apiKey: '',
};
```

**commands/index.ts**:

```ts
import { Plugin } from 'obsidian';
import { doSomething } from './my-command';

export function registerCommands(plugin: Plugin) {
	plugin.addCommand({
		id: 'do-something',
		name: 'Do something',
		callback: () => doSomething(plugin),
	});
}
```

### Add a command

```ts
this.addCommand({
	id: 'your-command-id',
	name: 'Do the thing',
	callback: () => this.doTheThing(),
});
```

### Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MySettings>);
  await this.saveData(this.settings);
}
```

### Register listeners safely

```ts
this.registerEvent(
	this.app.workspace.on('file-open', (f) => {
		/* ... */
	}),
);
this.registerDomEvent(activeWindow, 'resize', () => {
	/* ... */
});
this.registerInterval(
	window.setInterval(() => {
		/* ... */
	}, 1000),
);
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/<plugin-id>/`.
- Build issues: if `main.js` is missing, run `npm run build` or `npm run dev` to compile your TypeScript source code.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and you re-render the UI after changes.
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide

## Anime for Mobile — project notes

This repo is the **Anime for Mobile** plugin (folder and plugin id stay
`browser-for-mobile` so existing installs upgrade in place). Everything below is
specific to this codebase.

**The web browser was removed in 3.0.0.** A plugin cannot embed a real engine on
mobile, so the iframe/proxy renderer was never reliable. Do not reintroduce a
browser: there is no `src/view.ts`, `renderer.ts`, `proxy.ts`, `bridge.ts`,
`store.ts`, `cookieStore.ts`, `tabs.ts`, `sheet.ts`, `viewport.ts` or
`types.ts` any more. The plugin is now the downloader, the library, the details
page and the recommendations.

### Architecture

- `src/main.ts` — plugin lifecycle only: settings load/save, view registration,
  ribbon icons, command registration, and the modal wiring. Keep it minimal.
- `src/animeApi.ts` — the catalogue client: search, info, episodes, streams, and
  `/api/preview/:id` for the rich details page. All responses are unwrapped from
  the API's `{ success, results }` envelope here.
- `src/animeCache.ts` — TTL cache installed into `animeApi.ts` via
  `setAnimeCache`. See the caching notes further down.
- `src/downloader.ts` — the `DownloadManager`: queue, staging, resume, rate
  limiting, and the wake lock.
- `src/hls.ts` / `src/transmux.ts` — playlist parsing and MP4 conversion.
- `src/downloadModal.ts` — the downloader window (search, episode picker, queue).
- `src/downloadManagerView.ts` — an `ItemView` that scans the download folder and
  offers per-file repair.
- `src/library.ts` / `src/libraryModal.ts` / `src/playerModal.ts` — the offline
  library: filename parsing, the list, and playback with saved position.
- `src/detailsModal.ts` — the full details page, including the recommendation
  section.
- `src/recommendationsModal.ts` — the recommendations page: a poster grid over
  the whole download history, with per-seed progress while it loads.
- `src/recommend.ts` — the pure ranking engine: `tokenize`, `buildTasteProfile`,
  `bm25Scores`, `rankRecommendations`, `blendModelScores`. No I/O, so it is
  directly testable.
- `src/decision.ts` — the decision-model layer: `TinyDecideRanker` (local,
  vendored) and `JevRanker` (hosted, TypeSafe System One).
- `src/recommendService.ts` — orchestration: `deriveSeeds` from the download
  history and `collectRecommendations` across the catalogue.
- `src/stats.ts` / `src/statsModal.ts` — the run log and its summary page.
- `src/settings.ts` — uses the **declarative settings API**
  (`getSettingDefinitions`). Do not re-add an imperative `display()`; lint flags
  it once `minAppVersion` is 1.13.0.

### Key constraints

- **`minAppVersion` is 1.13.0.** The declarative settings API and
  `setDestructive()` require it. Lowering it will fail lint
  (`obsidianmd/no-unsupported-api`).
- **`saveSettings()` writes the whole `data.json`.** Anything not spread into
  that one `saveData` call is dropped on the next save. `downloadScanCache` and
  `animeCache` both live here for exactly that reason; the old browser code
  carried them through a `browserData` spread that no longer exists. If you add
  a new persisted key, add it to `PersistedShape`, load it in `loadSettings`,
  and include it in `saveSettings`.
- **The download manager writes its scan cache through `plugin.saveSettings()`**,
  not a bare `saveData`, so a concurrent save cannot drop it.
- **Recommendations must always render.** `scoreWithModel` returns an empty map
  on any failure (no key, network error, malformed reply) and the caller falls
  back to the vote ordering. Never surface a model error in the details page or
  the recommendations page.
- **`scoreWithModel` takes the model profile, not a seed.** `modelProfile()`
  builds the text; `recommendFor` passes the series being viewed, and
  `buildRecommendations` passes the seeds that actually produced candidates.
  Both then go through `applyModelScores` for the same fallback behaviour.
- **The recommendation models are opt-in and the hosted one sends user data.**
  `recommendationModel` defaults to `'off'`. Only the taste profile and candidate
  titles are ever sent, and only for `'hosted'`. Do not widen what is sent, and
  do not enable a model by default.
- **`src/vendor/tinydecide.js` is vendored third-party code** (Apache-2.0,
  minified). It is excluded from lint (`src/vendor` in `eslint.config.mts`) and
  must not be edited by hand. Weights are downloaded at runtime, not bundled.
- **Settings use the declarative API.** Add a field to `AnimeSettings`,
  `DEFAULT_SETTINGS`, and `getSettingDefinitions` — all three, or the control
  renders with no effect.
- **Playback is the platform video element.** MPEG-TS cannot be decoded by a
  browser engine, so the library refuses it with a message rather than showing a
  black rectangle. Do not promise TS playback.

### Build, lint, test

```bash
npm run build   # tsc --noEmit && esbuild production
npm run lint    # eslint, must be clean (0 errors, 0 warnings)
```

**Vitest is now the committed test runner** (`npm test`), with
`tests/obsidian-stub.ts` aliased for the `obsidian` module. Current suites:
`utils`, `destination`, `library`, `perf`, `animeApi`, `animeCache`,
`recommend`, and `decision`. Earlier ad-hoc harnesses under `/tmp/bfmtest` and
`/tmp/bfmh` (built with esbuild `--alias:obsidian=...` plus jsdom) covered the
removed browser view and the downloader internals; the downloader ones are
still the reference for staging, resume, rate limiting, and MP4 conversion.

## Anime downloader — project notes

Added in 1.1.0. Now the core of the plugin rather than a side feature.

### Architecture

- `src/animeApi.ts` — client for `animeapi.cjhauser.me` (default
  `DEFAULT_API_BASE`). Three endpoints, no schema endpoint: `/api/search?keyword=`
  (`q=` is silently ignored), `/api/episodes/<seriesId>`, and
  `/api/stream?id=<urlencoded episode id>` where ids look like
  `naruto-76396?ep=76396_1`. Also `parseMasterPlaylist`, `selectVariant`, and
  `STREAM_REFERER`.
- **`/api/stream` does not always return a downloadable file, and its default
  server is not always the downloadable one.** Some series answer with an
  embed-only server — One Piece returns `DatSaV`, whose `link` is `{}` and whose
  only `iframe` is `play.echovideo.ru/embed-*` — while the *same response's*
  `servers` array also names servers that do return a file (`Vidplay`,
  `MyCloud`). A server is selected by **name** via `?server=<serverName>`
  (case-insensitive); numeric `server_id`/`data_id` params are ignored, and an
  unknown name silently falls back to the default rather than erroring, so a
  name with stray whitespace is not a match. `loadStream` therefore tries the
  default first and, only when it yields no `file`, walks the other names
  (subbed tracks first, so a fallback keeps the same audio track) until one
  returns a file; each alternate is isolated so one 5xx does not abort the
  search. Without this, every One Piece episode failed with "the DatSaV server
  only offers an embedded player".
- `src/hls.ts` — playlist parsing and the segment fetcher. `requestUrl`-based
  (the CDN's CORS allowlist is `https://play.echovideo.ru` only, so page `fetch`
  fails). `downloadSegments` buffers; `downloadSegmentsStreaming` hands segments
  to a callback in playlist order for low-memory `.ts` writes. Retry with
  exponential backoff; 408/425/429/5xx are transient.
- `src/transmux.ts` — MPEG-TS to fragmented MP4 via mux.js, plus `patchDuration`.
- `src/destination.ts` — `VaultDestination` and `ExternalDestination`, filename
  sanitising, and `externalStorageAvailable()`.
- `src/downloader.ts` — `DownloadManager`: job queue, concurrency, cancel,
  progress, filename template, and resume (staging `.part` file + sidecar).
- `src/downloadModal.ts` — the three-stage modal (search, episodes, queue).
- `src/mux.d.ts` — hand-written types for mux.js, which ships none.

### Video library

Added in 1.6.0. A separate feature again: it reads the download folder and plays
what it finds. It shares the settings object and the plugin instance, nothing
else.

- `src/library.ts` — `VideoLibrary`: a scan of the download folder, filename
  parsing, and the per-path watch-progress map. No index file; the folder is the
  index, so a file added or deleted outside the plugin is picked up on the next
  open.
- `src/libraryModal.ts` — the browse UI: search, the all/unwatched/in-progress
  filter, progress bars, play, and delete.
- `src/playerModal.ts` — `PlayerModal`: a `<video>` pointed at the file's
  resource path, with resume, periodic progress saves, and start-over.

Progress lives in the plugin's saved data under the `watch` key, keyed by vault
path.

### Key constraints

- **The library is a folder scan, not an index.** `VideoLibrary.refresh` walks
  the download folder with `adapter.list` and `stat`s each file. `.part` and
  `.part.json` staging files are skipped, so an interrupted download is not shown
  as an episode. `prune` then drops progress for paths that are gone.
- **Filenames are parsed with the downloader's own template.** `buildNameRegex`
  turns `{series} - {ep:02} - {title}.{ext}` into a named-group matcher, so the
  parts the downloader wrote can be read back. The template's `{ext}` token is
  what consumes the extension, so `parseEntryName` matches the *whole* name, not
  a stripped base — matching the base silently fails every file. A name that does
  not match is kept whole as the title rather than dropped.
- **Only MP4 plays.** The `.ts` output is a raw MPEG-TS stream, which no browser
  engine plays; `PlayerModal` reports that instead of rendering a dead `<video>`.
  The README points users at MP4 for library playback.
- **Playback uses `adapter.getResourcePath`.** The file is in the vault, so
  Obsidian can hand the media element a URL for it; the bytes are never read into
  memory. A path outside the vault throws, which is caught and reported.
- **Only in-vault videos are listed.** External downloads (desktop only) go
  where `adapter.list` cannot enumerate them, so `libraryFolder()` returns the
  vault-relative folder and the modal shows a hint when external saving is on.
- **`VaultAdapter.list` returns vault-relative paths, not bare names.** Every
  folder walk goes through `collectFiles`/`childPath` in `utils.ts`, which keep an
  already-prefixed child as-is and only join a bare name. Joining the folder back
  on produces `folder/folder/child`, which is how the repair path silently
  reported every file as failed (`doctor.ts` had the same bug and now shares the
  helper). `collectFiles('')` walks the vault root, which is what external mode
  needs.
- **Progress is written on a timer and on close, not on every `timeupdate`.** A
  position under five seconds is treated as "not started" and dropped, and a
  saved position within a second of the end is reset rather than resumed (an
  instant jump to the end reads as a hang).

### Key constraints

- **Streams are 720p only.** Every series and server probed returned a single
  `1280x720` variant. `selectVariant` picks the closest height so a 1080p request
  still downloads; the UI must not imply higher quality exists.
- **The API's `filler` field is always `false`** and `dubbed` is unreliable.
  The filters are wired but effectively inert. Do not present them as accurate.
- **The CDN rate limit is real and roughly per-IP, and high concurrency makes
  downloads *slower*, not faster.** Measured against the live CDN (a 138-segment
  episode, real `downloadSegmentsStreaming` via a `requestUrl`→`fetch` stub):
  starting concurrency 3 → ~9 s, 4 → ~12 s, 6 → ~20 s, 8 → ~20 s, **12 → ~242 s**.
  The CDN starts answering 429 above roughly four in flight, and a naive fixed
  pool spends the whole run retrying. An earlier note here claimed "no 429 at any
  level" and throughput climbing to 24 workers; that does **not** reproduce and
  the numbers almost certainly counted 429 responses as throughput. Do not trust
  a single sweep — the limit is per-IP, so probe with a cooldown between runs and
  check the response status, not just bytes.
  The gate in `downloadSegmentsStreaming` is a *target*, not a fixed pool: on a
  429 it **halves** the target and sets `ceiling = target - 1`, then creeps back
  up one worker per `RATE_LIMIT_COOLDOWN_MS` and stops at the ceiling. Halving
  converges in a few rounds where the old one-step shed took minutes, and the
  ceiling is what stops the pool oscillating back into the limit. The default
  `downloadSegmentConcurrency` is 6; anything above ~6 is now safe (it no longer
  stalls) but rarely faster. Keep the backoff — the limit is per-IP and moves
  with load.
- **`requestUrl` has no timeout option.** `withTimeout` in `hls.ts` races the
  promise against a timer; the request itself is not cancelled.
- **mux.js only emits on `flush()`.** Flushing once at the end materialises the
  whole episode at once — measured at ~4.3 GB peak for a 726 MB stream, enough to
  OOM-restart a phone. Flushing a window at a time (`TransmuxStream`) keeps the
  internal buffer bounded (~200 MB peak measured) while producing byte-identical
  output: same transmuxer instance, so the media timeline stays continuous. The
  earlier "per-segment `tfdt` restarts at 0" note applied to flushing a fresh
  transmuxer per segment; reusing one instance across flushes is what makes the
  windowed path correct. Verify equivalence with a frame/PTS diff, not a player.
- **mux.js leaves every duration at the "unknown" sentinel (`0xffffffff`)** — not
  just `mvhd` but each `tkhd` and `mdhd` — and emits no `mehd`. Players that read
  the movie header cope, but ones that read the track headers (Samsung Gallery)
  show the sentinel: at 90 kHz it is 47721s, which clamps to 1:35:15, so *every*
  file looks the same length. `patchDuration` writes the real duration into all
  four, scaling per box (`mvhd`/`mehd` use the movie timescale, each `mdhd` its
  own, `tkhd` 1000). It is idempotent: a file that already has a `mehd` is
  updated rather than gaining a second. Verify with a box dump, not a player.
- **Writes must be serialized, in order.** Segments finish out of order and
  several workers run at once, so awaiting a write inside the worker let a later
  segment land before an earlier one — reordering the file and, on the first
  write, letting `appendBinary` run before the file existed. Both `hls.ts` (a
  write chain) and the writers in `destination.ts` (a per-file queue) enforce
  order. Batch decisions are made in the ordered drain loop, never inside a
  promise callback: doing it in a callback silently dropped the first segment.
- **Mobile cannot write outside the vault.** `getBasePath()` is desktop-only and
  Android 11+ needs `MANAGE_EXTERNAL_STORAGE` to write to a path outside the
  vault, which Obsidian does not hold. The vault itself may live on an SD card
  and writes go through `adapter`, so that case needs no extra permission.
  External paths are desktop-only and the toggle is hidden when unavailable.
- **Vault writes use `adapter.appendBinary` on mobile, but a file handle on
  desktop.** `appendBinary` (available since app 1.12.3; this plugin requires
  1.13.0) re-reads and rewrites the *whole* file on every append, so writing an
  n-byte file costs O(n²) bytes of I/O — an 800 MB movie moves roughly 10 GB, and
  it is the dominant cost, not the network. On desktop the vault is a real
  directory, so `VaultDestination` opens a Node `fs` handle (`open` + positional
  `write`, `NodeVaultWriter`) and appends in O(1); `getBasePath()` is desktop-only
  so mobile keeps the adapter. Mobile cannot avoid the rewrite, so appends are
  coalesced to reduce passes instead: `TS_BATCH_BYTES` (8 MB) floor and
  `MAX_BATCH_BYTES` (64 MB) ceiling, the ceiling also bounding the transmux flush
  window and peak memory. Writing per segment made the phone unusable. The MP4
  path streams init then fragments instead of assembling a second copy, halving
  peak memory.
- **Batch size scales with device memory.** `batchCeiling()` reads
  `navigator.deviceMemory` (approximate RAM in GB; Chromium-only, absent on iOS)
  and caps the coalesced write at 64 MB on a 4 GB+ device, 32 MB at 2 GB, and
  16 MB below that. A batch is held in memory while it is written and the MP4
  path holds the transmux window too, so the 64 MB ceiling that suits a 4 GB
  phone can OOM a 1 GB one. An unknown value keeps the full ceiling, because the
  only platform without the property is iOS and scaling down costs write passes.
- **The screen is held awake while a job runs** (`src/wakelock.ts`). Android
  suspends the WebView when the screen sleeps, which stalls the segment requests
  and can let the OS reclaim the app mid-episode; the Screen Wake Lock API is
  Chromium-only, so this is a no-op on iOS. Holds are reference-counted so
  concurrent jobs share one lock, and a lock the browser drops on hide is
  re-requested on `visibilitychange`. A parked (rate-limited) job releases the
  lock and re-acquires on retry. `ensure()` coalesces concurrent requests onto a
  single in-flight promise — without that, two jobs starting together each issue
  a request and only the last is tracked, so the screen stays on forever.
- **Chrome on a phone needs safe-area insets and 16px inputs.** Obsidian renders
  with `viewport-fit=cover`, so the toolbar draws under the status bar and the
  status line under the home indicator unless the chrome is inset by
  `env(safe-area-*)`; `--bfm-inset-*` on `.bfm-root` carries the four values. A
  fullscreen modal uses `100dvh`, not `100vh`, or the collapsing URL bar clips
  its bottom. iOS zooms the page when a focused input's font is under 16px, so
  the address bar and downloader inputs are 16px under `@media (pointer: coarse)`,
  which also grows the sub-44px touch targets. All of it is scoped to coarse
  pointers so the desktop layout is untouched.
- **`src/doctor.ts` repairs files written before 1.1.1** by recovering the length
  from `mvhd`/`mehd` and re-running `patchDuration`. Surfaced as a command and a
  button; it only rewrites files that still hold the sentinel.
- **A failed download is resumable; a cancelled one is not.** The stream is
  staged to `<final>.part` with a `<final>.part.json` sidecar recording the last
  contiguous segment and byte count, so a re-enqueue continues from there
  instead of restarting. The sidecar is only trusted when the episode, format,
  quality, playlist length, and total duration all match, and the `.part` size
  equals the sidecar's `bytes`; otherwise both are discarded — splicing two
  different streams is worse than re-downloading. `resumeFrom`/`resumeBytes` in
  `DownloadOptions` skip the prefix, and `writtenThrough` in the streaming
  callback is the true contiguous prefix to record (the in-memory out-of-order
  tail is not on disk, so it must not be). A `cancel` calls `discardPartial`;
  a failure calls `markPartial` and leaves the pair in place. The `.part` name is
  derived from the job's relative staging path, which is kept in `stagingPaths`
  (not `job.filePath`, which is a display path) because a failed job has no
  final file yet.
- **MP4 streams to `.part` as it converts.** mux.js is driven a window at a time,
  so the episode never sits in memory whole. Staging also makes the MP4 path
  resumable: a conversion failure leaves a valid partial and the next run appends
  to it from the last converted segment rather than re-downloading. TS finalises
  by renaming `.part` into place (sidecar removed only after the rename
  succeeds); MP4 writes the final file and only then discards the stage.
- **A throttled run is parked, not failed.** A 429 that outlasts the per-segment
  retries (`RateLimitError` from `hls.ts`) moves the job to `waiting` — a status
  distinct from the user's own `paused` — to the bottom of `jobs`, and a timer
  re-queues it after a wait that doubles per park up to `RATE_LIMIT_MAX_WAIT_MS`.
  It keeps its `.part`, so the retry resumes instead of restarting, and other
  episodes run while it waits. `rateLimitRetries` caps this at 12 consecutive
  parks; the job then surfaces as `failed` but the partial is kept, so Resume
  still continues it. A plain (non-rate-limit) failure is retried up to
  `MAX_AUTO_RETRIES` times on its own with a growing delay, but only when
  `DownloadError.retryable` is set — validation and "already exists" failures are
  deterministic and would only spin. The parked timer is tracked in `retryTimers`
  and cleared in `dispose`, otherwise an unload leaves it to fire into a dead view.
- **A job list does not survive a restart; the staging files do.** On mobile the
  app is killed in the background constantly, so `DownloadManager.restore()`
  rebuilds the queue from `.part.meta` sidecars found by `destination.list()`,
  surfacing each as failed-but-resumable. The sidecar carries the episode number
  and title (v3) so a restored job can name itself without an API call; v2
  sidecars are still read (label falls back to the id), v1 is discarded. A
  staging file *longer* than its sidecar's byte count is a torn batch from a
  crash between append and sidecar write, so it is truncated back rather than
  thrown away; a shorter one is not recoverable and is discarded.
- **The queue updates in place, it does not re-render.** Progress ticks arrive
  every 150 ms; rebuilding the job list each time stalls the window on a phone.
  `tickQueue` patches the status text and progress bar of existing rows and falls
  back to a full `render` only when a row appears, disappears, or changes status
  class. Anything that changes the shape of the queue (enqueue, cancel, finish)
  must call `render`, not `tickQueue`.
- **Speed and ETA come from `src/perf.ts`, and the estimator was chosen by
  measurement, not intuition.** `SpeedTracker` keeps an EMA of the rate between
  progress callbacks and blends it 60/40 with the *median* of the recent
  per-callback rates, and takes the remaining size from
  `remainingBytesFromBitrate` (playlist durations, not average bytes per
  segment). Both choices were picked by scoring candidates against wall-clock
  truth on captured runs: the blend cut mean error from ~49% to ~39% (fast) and
  ~57% to ~47% (slow) and drove the bias from +18%/+39% to ~0. The median is what
  removes the optimism — the raw interval rate against this CDN swings between
  ~2 and ~70 MB/s, and a mean (or an EMA of the spikes) is dragged up by the
  bursts. Do not "improve" this by swapping in a plain windowed mean: that
  scored *worse* (75% mean error, +40% bias) in the same harness.
- **Do not thin the samples.** An earlier version committed a sample at most
  every 250 ms by updating the previous sample in place. The live API ticks every
  ~65 ms, so that never committed a second sample: the window stayed empty and
  `current` read a silent zero. Removing the thinning also cut mean ETA error by
  ~13 points (52.8% -> 39.5%). Every progress callback is now kept.

### Anime API caching

- `src/animeCache.ts` is a TTL cache over the anime API's JSON, installed into
  `src/animeApi.ts` at plugin load via `setAnimeCache`. It exists because the
  API is slow: it runs as serverless functions, so no cache of its own survives
  between requests and every call is cold, and a search fans out across every
  provider upstream. The cache has to live in the plugin.
- **Only API JSON is cached.** The stream CDN's playlist and segments are not:
  `loadStream` caches the API call but still re-reads the manifest, because that
  lives on the CDN and is short-lived.
- **Stream entries are memory-only.** `isPersistable` excludes `/api/stream`:
  a URL saved from the last session is usually dead by the next one, and a
  stale link fails *late* — mid-download — which is worse than a miss.
- TTLs differ per endpoint (`ttlForPath`): info a week, episodes 12h, search and
  stream 10min. Metadata barely changes; a stream URL does.
- A failed request is never cached, and concurrent requests for the same key
  share one in-flight promise, so a double-tap does not double the upstream load.
- The cache persists through the same `saveData` as everything else. **Any code
  that writes settings must carry `animeCache` through**, or it will wipe the
  cache — `saveSettings()` does, and the download manager writes its own scan
  cache through `saveSettings()` too for the same reason.
- `clearAnimeCache` is exposed as a command and the whole feature as the
  **Cache anime details** setting.

### Releases

A release is two commits: the feature work, then a separate `Release X.Y.Z`
commit that bumps `package.json`, `manifest.json`, and `versions.json` together.
Tag the release commit `X.Y.Z` with no leading `v`, and attach `main.js`,
`manifest.json`, and `styles.css` as individual assets.

The maintainer's convention for a user-facing improvement is a **minor bump with
a `.5` patch** (1.7.0 -> 1.8.5), not the plain `.0`. Ask if unsure.

Two gotchas, both hit when cutting 1.8.5:

- The `origin` remote carries an embedded token that expires. A `git push` then
  hangs on a `Password for 'https://...'` prompt rather than failing. Push with
  the current `GITHUB_TOKEN` instead
  (`git remote set-url origin https://x-access-token:$GITHUB_TOKEN@github.com/...`),
  and reset the URL to the plain form afterwards so the token is not left on disk.
- `versions.json` is indented with **8 spaces**, not tabs. Writing it back through
  `json.dumps(..., indent='\t')` reformats the whole file; edit the one entry in
  place instead.

### Verification

No committed test runner. Ad-hoc harnesses live in `/tmp/bfmdl/harness/`:
`e2e.ts` exercises the API client, playlist parsing, template rendering, ordered
streaming, and transmux against the live API; `manager.ts` runs the real
`DownloadManager` against a filesystem-backed fake vault adapter and checks file
contents, duplicate refusal, cancel cleanup, and the patched durations.
`verify.ts` covers write ordering and batching with synthetic segments;
`doctor.ts` covers detection and in-place repair. `resume.ts` drives the real
`DownloadManager` against an in-memory fake adapter and a fake CDN: it checks a
full stream, a failure that leaves a contiguous prefix and sidecar, a resume that
fetches only the missing tail, discarding a changed stream and a torn partial,
cancel cleanup, an MP4 conversion failure that keeps the stage, and write order.
`/tmp/bfmh/mp4.test.ts` additionally drives the windowed MP4 path end to end: a
clean download (peak memory bounded, output decodes), a hard failure that leaves
a resumable prefix, a resume whose prefix is byte-identical to the first attempt,
a transient 429 that is retried, and a sustained 429 that parks the job at the
bottom of the queue with a retry countdown while a healthy job runs.
`/tmp/bfmh/write.test.ts` covers the write path: on desktop the Node handle is
used and the adapter is never called (`adapterAppends === 0`), on mobile it falls
back to the adapter, both produce identical bytes, and an append extends rather
than truncates. It needs `window.require` (a `createRequire` shim) and a stub
`Platform.isDesktopApp` to exercise the desktop branch.
`/tmp/bfmh/gate.test.ts` covers the adaptive concurrency gate against a local
server that returns 429 mid-run: the pool sheds below the configured target
during the limit, recovers afterwards, and still delivers every segment in order.
`/tmp/bfmh/mobile.test.ts` covers the mobile additions with a fake Screen Wake
Lock API and a stubbed `navigator`: two acquires share one lock, the lock is held
until the last release, a lock dropped on hide is re-acquired on show, dispose
releases and unhooks, an unsupported platform is a silent no-op, and the real
exported `batchCeiling()` steps 16/32/64 MB with `deviceMemory`. Node's
`navigator` is getter-only, so the harness installs the stub with
`Object.defineProperty`.

The library has its own harnesses in `/tmp/bfmh`: `library.test.ts` covers
filename parsing (including a template whose `{ext}` token must consume the
extension, not a stripped base), a real-filesystem folder scan that skips `.part`
staging files and non-videos, progress round-tripping, the watched threshold, the
trivial-position drop, and `prune`. `library-ui.test.ts` renders both modals in
jsdom and checks the list, search, the filters, play from the row and the play
control, the delete confirmation, the player's resume and close-time save, the
reset when the saved position is the end, and the `.ts` refusal.
Bundle them with the repo's local esbuild
(`node_modules/.bin/esbuild ... --alias:obsidian=./obsidian-stub.ts`) and a
`window` shim; `npx esbuild` hangs in this environment.

The speed/ETA work added harnesses in `/tmp/bfmh/`: `perf.test.ts` unit-tests
`SpeedTracker` and `remainingBytesFromBitrate` on synthetic timelines;
`capture.test.ts` records a live run's `(time, bytes, completed)` timeline to
JSON; `replay.test.ts` replays those captures through the *real* tracker and
scores the ETA against wall-clock truth, side by side with the estimator it
replaced (this is the harness that caught both the thinning bug and the
windowed-mean regression); `progress.test.ts` covers `describeProgress`.
Re-capturing needs the live CDN, which rate-limits after a handful of runs — a
`429` there is the CDN, not the code.

The statistics work added `/tmp/bfmh/stats.test.ts` (unit: `summarize`, `pruneRuns`,
`parseRun`, and the resumed-run rate that divides fetched bytes by run time),
`/tmp/bfmh/statsui.test.ts` (jsdom render of the page: empty state, the four
cards, totals, best speed, failed-run exclusion, the chart, and clear-with-
confirmation), and `/tmp/bfmh/statsdl.test.ts` (the real `DownloadManager`
against an in-memory fake adapter and a synthetic CDN, checking success, failure,
and resume accounting). Three things are easy to get wrong in `statsdl.test.ts`:
the speed window needs more than 500 ms of real time, so segment fetches must be
delayed; a "failed" fixture must be a *non-retryable* error (an embed-only
stream) or the manager retries instead of failing; and `run.segments` is the
whole file's segment count, not the number this run fetched. Note also that
`sanitizeName` turns `/` into `_`, so a `{series}/Episode {ep}` template writes
`Downloads/Naruto_Episode 1.ts`.

The folder-scan path bug (1.10.5) added `/tmp/bfmh/harness/repair_compare.ts`,
which runs the real `repairFolder` against four mock adapters and shows the
symptom directly: with a *rooted* listing (`list('Anime')` → `['/Anime/Ep 1.mp4']`)
the 1.9.5 `childPath` returned `Anime//Anime/Ep 1.mp4`, so every `readBinary`
threw and the repair reported "271 checked · none needed repair · 271 failed".
The flat-rooted case is the one that reproduces the user's numbers exactly. The
fix strips a leading slash from the folder and the child, and — for a
device-absolute listing — keeps everything from the folder segment onward.
`childPath` is the single join for both the repair scan and the video library, so
the two share the bug and the fix.

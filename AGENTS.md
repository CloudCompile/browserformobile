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

## Browser for Mobile — project notes

This repo is the **Browser for Mobile** plugin. Everything below is specific to
this codebase.

### Architecture

- `src/main.ts` — plugin lifecycle only: settings load/save, view registration,
  ribbon icon, command registration. Keep it minimal.
- `src/view.ts` — the `ItemView`. Builds the chrome (top address row, content
  pane, bottom action bar), owns navigation, history, and renderer lifecycle,
  and hosts the bottom sheets.
- `src/sheet.ts` — `Sheet`, a bottom sheet: dimmed backdrop, grabber, drag-to-
  dismiss, and `addRow` for icon+label actions. Used by the overflow menu and
  the tab switcher. Positioned inside the view (absolute), not fixed to the
  window, because a view is one workspace pane.
- `src/viewport.ts` — `keyboardInset()`, the height the soft keyboard covers,
  derived from `visualViewport`. Pure, so it is unit-testable.
- `src/renderer.ts` — two renderers: `DirectRenderer` (iframe, works when the
  site allows embedding) and `ProxyRenderer` (fetched HTML in a sandboxed frame).
- `src/proxy.ts` — page fetching. `loadPage()` tries Obsidian's native
  `requestUrl` first and only falls back to the CORS proxy. `rewriteHtml()`
  injects `<base>`, strips `integrity`, neutralises restrictive meta tags
  (including `refresh`), and blocks remote scripts. `framePolicyFromHeaders()`
  and `probeFramePolicy()` read a site's `X-Frame-Options` /
  `Content-Security-Policy` to predict a refused embed before rendering.
- `src/bridge.ts` — script injected into proxied pages. Relays title, link
  clicks, cookie reads/writes, and readiness back to the host via
  `postMessage`, using a per-render channel id.
- `src/store.ts` / `src/tabs.ts` — persisted state (history, bookmarks, cookies,
  tabs) with a debounced writer.
- `src/cookieStore.ts` — cookie parsing, merging, pruning, host matching, and
  Netscape export.
- `src/settings.ts` — uses the **declarative settings API**
  (`getSettingDefinitions`). Do not re-add an imperative `display()`; lint flags
  it once `minAppVersion` is 1.13.0.

### Key constraints

- **`minAppVersion` is 1.13.0.** The declarative settings API and
  `setDestructive()` require it. Lowering it will fail lint
  (`obsidianmd/no-unsupported-api`).
- **The chrome is a top address row plus a bottom action bar.** A phone cannot
  reach a top row one-handed, so the frequent actions (reload, bookmark, tabs,
  home, open-external) live in a bottom bar and the top row keeps back/forward,
  the address field, and the overflow button. Do not move primary actions back
  to the top, and do not duplicate back/forward in both rows — a test asserts
  the two rows are disjoint.
- **The tab strip is desktop-only; narrow screens use the tab switcher.** Below
  700px `.bfm-tabs` is `display: none` and the `layers` button in the bottom bar
  opens the tab sheet instead. The strip stays above 700px, where there is room
  for both.
- **`--bfm-keyboard-inset` lifts the bottom bar over the soft keyboard.** The
  on-screen keyboard shrinks the visual viewport without resizing the layout, so
  a bar pinned to the layout bottom is drawn under the keyboard. `watchKeyboard`
  publishes the covered height from `visualViewport` and the bar consumes it as
  bottom padding. Use `panel.setCssProps(...)`, not `element.style.*`; lint
  (`obsidianmd/no-static-styles-assignment`) rejects direct style writes.
- **The sheets are absolutely positioned inside the view.** A `position: fixed`
  panel would escape the view and cover the rest of Obsidian. The overlay is the
  positioning context, so `.bfm-root` must stay `position: relative`.
- **Drag handles opt out of touch scrolling, the sheet body does not.**
  `touch-action: none` belongs on the grabber and title only; putting it on
  `.bfm-sheet` (as it once was) stops the list from scrolling with a finger.
- **Direct mode is desktop-only in practice.** Electron ignores
  `X-Frame-Options` and CSP `frame-ancestors`, so on desktop most sites frame
  fine and direct stays the default. Android WebView enforces both, so a
  refusing site renders Chromium's `ERR_BLOCKED_BY_RESPONSE` error page inside
  the frame. `view.ts` therefore defaults to proxy mode when `Platform.isMobile`.
- **A refused embed cannot be detected from the frame, so it is preflighted by
  header.** A blocked frame and an allowed cross-origin frame are observationally
  identical from the host: both fire `load` in ~100 ms, both expose
  `contentDocument === null` and `contentWindow.length === 0`, and no
  `securitypolicyviolation` event or resource-timing gap distinguishes them.
  `probeFramePolicy` (`src/proxy.ts`) instead reads `X-Frame-Options` /
  CSP `frame-ancestors` from the response through `requestUrl`, and
  `mountRenderer` switches to the proxy when the site refuses framing — without
  it the frame shows Chromium's `ERR_BLOCKED_BY_RESPONSE` and looks dead. Probe
  with **GET**, not HEAD: some servers (news.ycombinator.com) send
  `X-Frame-Options: DENY` only on a real navigation, so a HEAD-only check misses
  them. Results are cached per origin and a failed probe is treated as frameable,
  so the direct path still gets its chance. Do not replace this with DOM sniffing
  of the frame; that genuinely cannot work.
- **Proxied pages run their own scripts by default** (`runScripts`, the "Run
  page scripts" setting). The proxy frame already has `allow-scripts`, so
  blocking was a privacy choice, not a technical limit — and it left every
  client-rendered site (DuckDuckGo, SPAs) blank or mangled. `rewriteHtml`'s
  `runScripts` flag only decides whether `<script src>` tags are neutralised;
  integrity and restrictive meta tags are stripped either way.
- **The bridge shims what an opaque origin lacks.** `localStorage` /
  `sessionStorage` throw on access in the sandbox and `innerWidth` is 0, both
  of which crash framework boot. Keep the `safeStorage` / viewport shims in
  `bridge.ts` ahead of any page script. `window.parent` is also shimmed to
  `window` so a page probing `parent.document` (framebusting, embed detection)
  resolves instead of throwing a `SecurityError` mid-boot. `window.top` is an
  own, non-configurable property and **cannot** be shimmed, which is why page
  errors must never be treated as fatal (below).
- **A page script error is not a load failure.** The bridge forwards page errors
  to `onPageError`; `view.ts` marks the tab and shows **page error** in the
  status bar without touching the DOM. Routing them through `onError` made
  `renderErrorState` call `pageEl.empty()` and blank pages that had rendered
  fine — the reported `SecurityError` from `window.top` did exactly that.
- **The sandboxed frame must never get `allow-same-origin`.** It is opaque on
  purpose; the bridge is the only channel.
- **Cross-origin frames cannot be inspected**, so titles and navigation come
  from the injected bridge, never from reading the frame DOM.
- **`rewriteHtml` must never rewrite inside a raw-text element body**
  (`script`, `style`, `textarea`, `title`). A page may hold markup in a string
  — DuckDuckGo's loader does `document.write('<script src="'+s+i+'"><\/script>')`
  — and emitting a literal `</script>` there ends the real block early and
  breaks the page with "Invalid or unexpected token". `blockRemoteScripts`
  walks the document as the parser would and only neutralises tags at markup
  level; `transformOutsideOpaqueBlocks` guards the meta/integrity pass.
- Third-party proxy default is `https://api.allorigins.win/get?url=` (JSON
  mode, exported as `DEFAULT_PROXY_BASE`). It is flaky and often returns 5xx;
  retries and the `FALLBACK_PROXIES` chain live in `proxyRequest`. The chain is
  only used when `proxyBase` equals `DEFAULT_PROXY_BASE`, so a user's own proxy
  is never bypassed. Order: the Cloudflare Worker
  (`cors-proxy.christopher-j-hauser2025.workers.dev`, the only one that relays
  POST, declared via `methods`), then `r.jina.ai` (needs `x-respond-with: html`
  or it returns markdown), `api.cors.lol`, and `allorigins.win/raw`. HTTP 429
  and 408 are treated as transient so the chain continues past a rate limit.

### Build, lint, test

```bash
npm run build   # tsc --noEmit && esbuild production
npm run lint    # eslint, must be clean (0 errors, 0 warnings)
```

There is no committed test runner. Ad-hoc harnesses were built under
`/tmp/bfmtest` using a stubbed `obsidian` module (via esbuild `--alias`) plus
`jsdom`, covering: utils, cookie parsing/merge/prune, TabStore navigation,
HTML rewriting, the injected bridge, the proxy fetch/fallback logic, and the
full view with a DOM. The mobile-UI pass added `/tmp/bfmh/view.test.ts` (real
`BrowserView` in jsdom: chrome structure, menu-sheet contents, tab-switcher
switch/close/new, tab badge, and the keyboard inset) and
`/tmp/bfmh/viewport.test.ts` (the `keyboardInset` edge cases). Bundle the view
with `--alias:obsidian=./obsidian-view-stub.ts`, which adds `ItemView`,
`SuggestModal`, `Plugin`, and the `setCssProps` DOM augmentation; run the
harness as CJS with `--external:jsdom` (the ESM variant fails on jsdom's
`require('node:fs')`).

## Anime downloader — project notes

Added in 1.1.0. A separate feature from the browser view; shares only the
settings object and the plugin instance.

### Architecture

- `src/animeApi.ts` — client for `animeapi.cjhauser.me` (default
  `DEFAULT_API_BASE`). Three endpoints, no schema endpoint: `/api/search?keyword=`
  (`q=` is silently ignored), `/api/episodes/<seriesId>`, and
  `/api/stream?id=<urlencoded episode id>` where ids look like
  `naruto-76396?ep=76396_1`. Also `parseMasterPlaylist`, `selectVariant`, and
  `STREAM_REFERER`.
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

### Key constraints

- **Streams are 720p only.** Every series and server probed returned a single
  `1280x720` variant. `selectVariant` picks the closest height so a 1080p request
  still downloads; the UI must not imply higher quality exists.
- **The API's `filler` field is always `false`** and `dubbed` is unreliable.
  The filters are wired but effectively inert. Do not present them as accurate.
- **The CDN's rate limit is not a fixed "four parallel requests".** Benchmarked
  against the live CDN (48-segment runs, and a sustained 96-request run): 3 → 11
  MB/s, 6 → 22 MB/s, 8 → 30 MB/s, 16 → 48 MB/s, 24 → 74 MB/s, with **no 429 at
  any level**. The default is 6, but concurrency is a *target* rather than a
  fixed pool: `downloadSegmentsStreaming` drops it by one on a 429 and holds it
  down for a cooldown (`RATE_LIMIT_COOLDOWN_MS`) before creeping back up, so
  raising the setting is safe even if the limit returns. The old "above four"
  note did not reproduce; do not treat 4 as a hard ceiling, but do not remove the
  backoff — the limit is per-IP and may return under load.
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
  retries (`RateLimitError` from `hls.ts`) moves the job to `paused`, to the
  bottom of `jobs`, and a timer re-queues it after `RATE_LIMIT_RETRY_MS`. It keeps
  its `.part`, so the retry resumes instead of restarting, and other episodes run
  while it waits. `rateLimitRetries` caps this at ten consecutive parks so a dead
  stream cannot retry forever. The parked timer is tracked in `retryTimers` and
  cleared in `dispose`, otherwise an unload leaves it to fire into a dead view.
- **The queue updates in place, it does not re-render.** Progress ticks arrive
  every 150 ms; rebuilding the job list each time stalls the window on a phone.
  `tickQueue` patches the status text and progress bar of existing rows and falls
  back to a full `render` only when a row appears, disappears, or changes status
  class. Anything that changes the shape of the queue (enqueue, cancel, finish)
  must call `render`, not `tickQueue`.

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
Bundle them with the repo's local esbuild
(`node_modules/.bin/esbuild ... --alias:obsidian=./obsidian-stub.ts`) and a
`window` shim; `npx esbuild` hangs in this environment.

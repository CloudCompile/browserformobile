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
- `src/view.ts` — the `ItemView` that renders toolbar, address bar, tab strip,
  and content pane. Owns navigation, history, and renderer lifecycle.
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
full view with a DOM.

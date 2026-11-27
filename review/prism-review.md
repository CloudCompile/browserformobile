# Prism Review — `browserformobile` (Obsidian plugin)

**Repo:** `/home/container/browserformobile`
**Origin:** `https://github.com/CloudCompile/browserformobile.git`
**Branch/HEAD:** `main` @ `935902d` ("Fall back to a download-capable server when the default is embed-only")
**Stack:** TypeScript + esbuild, Obsidian plugin (`isDesktopOnly: false`), ~9k LOC across 28 `src/` modules
**Runtime dependency:** `mux.js` only (small surface area)
**Build (`npm run build`):** PASS (tsc `-noEmit` + esbuild production)
**Lint (`npm run lint`, eslint + obsidianmd):** PASS
**Automated tests:** NONE — no `test` script, no test files (see §5)

**Verified by:** Forge (clone/build/lint/path), Prism (code review below). Atlas (README-vs-code pre-digest) and Muse (docs/copy) are queued after this and may append files to `review/`.

**Verdict: Ship-with-conditions.** Top two conditions: (1) resolve manifest authorship/metadata and (2) remove the maintainer-controlled Cloudflare Worker from the default proxy fallback chain (or gate it behind an explicit opt-in). Additional blocker on the copyrighted catalogue is a product/legal call that should be settled by maintainers before community-plugin submission.

---

## A. Blockers (ship-stoppers)

### A1 — Maintainer-controlled Cloudflare Worker is a default proxy fallback
- **Severity:** High (privacy / trust boundary)
- **Evidence:** `src/proxy.ts:44-72` (`FALLBACK_PROXIES`), README Privacy section lists `cors-proxy.christopher-j-hauser2025.workers.dev` as fallback #1; hardcoded default path passed to users. Triggered whenever `proxyBase === DEFAULT_PROXY_BASE` (`src/proxy.ts:533-540`).
- **Why:** User URLs and page HTML are sent to a worker owned by the maintainer's personal domain (`christopher-j-hauser2025`) whenever the public proxy fails. Mitigation exists in code (user-set endpoint disables fallbacks) and in docs, but default behaviour silently mixes a maintainer endpoint into the chain with no SLA, no source link, no opt-in.
- **Acceptance check:** Either (a) remove the worker from defaults and publish its source + status page, or (b) make personal-worker fallback an explicit, off-by-default setting with a clear label. README note must state it is maintainer-operated.

### A2 — Anime downloader targets a third-party catalogue of copyrighted material
- **Severity:** High (legal / policy, product scope)
- **Evidence:** `src/animeApi.ts:8` `DEFAULT_API_BASE = 'https://animeapi.cjhauser.me'` "fronts the aniwaves.ru catalogue"; README Legal section acknowledges third-party copyrighted material; anime search/stream/downloader flows in `src/downloader.ts`, `animeApi.ts`.
- **Why:** README is honest about legality, but the feature is bundled in the default plugin and tied to a maintainer-operated API. For an Obsidian community-plugin submission this is likely a policy blocker; for private use it is the owner's risk.
- **Acceptance check:** Maintainers decide scope — (a) keep and clearly label experimental/opt-in, or (b) ship the browser without the downloader. Document the chosen scope in README + manifest description.

### A3 — Proxied pages run their own scripts by default
- **Severity:** Medium–High (security default)
- **Evidence:** `src/settings.ts` `runScripts: true` ("Off breaks every site that renders on the client"); `src/proxy.ts:226-233` `rewriteHtml(..., runScripts = false)` — when true, remote scripts are kept (only `integrity` stripped); `ProxyRenderer` frame sandbox `allow-scripts` (`src/renderer.ts:187`).
- **Why:** Default-on lets third-party analytics/tracking on proxied pages execute; a compromised or malicious page can make outbound network calls. Base + sandbox mitigate DOM access, but not exfiltration.
- **Acceptance check:** Decide whether the default should be `true` with a documented risk or `false` with a one-click toggle in the status bar. Add a one-line warning in settings copy (currently understates the exposure).

### A4 — Manifest author attribution is wrong
- **Severity:** Medium (metadata / release hygiene)
- **Evidence:** `manifest.json` `"author": "OpenHands"` while repo is `CloudCompile/browserformobile` and API domain is `cjhauser.me`; package name/`main.js`. Obsidian uses manifest `author` in community listing and updates.
- **Why:** Misattribution breaks trust, contact path, and author verification. Likely an artifact of an OpenHands-generated scaffold left in place.
- **Acceptance check:** Set `author`/`authorUrl` to the actual maintainer before any tagged release; verify `npm run version` flow (`version-bump.mjs`) keeps it consistent.

---

## B. Should-fix

### B1 — No automated test coverage
- **Severity:** High (process gap, not a single bug)
- **Evidence:** `package.json` scripts has no `test`; `find src -name '*.test.*'` returns 0; CI (`.github/workflows/lint.yml`) runs build+lint only.
- **Acceptance check:** Adopt a minimal strategy: pure-function unit tests for `framePolicyFromHeaders`, `rewriteHtml`, `renderTemplate`/`sanitizeName`, cookie matching. Until then record "no automated coverage" as an accepted risk with a manual smoke checklist (§5).

### B2 — External (out-of-vault) writes are not path-containment checked
- **Severity:** Medium
- **Evidence:** `src/destination.ts` `ExternalDestination.open` builds `joinPath(folder, path)` with only a leading-`/` strip; `validate` returns `null` for any non-empty name; `sanitizeName` is applied upstream in `downloader.ts`, but any other caller of `ExternalDestination` can pass `../`.
- **Why:** Not exploitable today because only downloader uses it through `buildFileName` → `sanitizeName` (which strips `/` and `\`), but the destination API itself lacks a guard, so a future caller reintroduces traversal.
- **Acceptance check:** Add `validate` enforcement in `ExternalDestination.open`/`write` rejecting paths that escape `folder` (normalise + prefix check) and add a unit test for `../`.

### B3 — Cookie jar is shared wholesale with the proxied frame
- **Severity:** Medium
- **Evidence:** `src/renderer.ts` `ProxyRenderer` passes `this.context.cookies` (full jar) as `BridgeConfig.cookies` and via `postCookiesToFrame`; scoping happens client-side in `bridge.ts` (`hostMatches`, `pathMatches`). Server/native side keeps all cookies in `data.json` (`BrowserData.cookies`).
- **Why:** Enforcement is in the injected bridge, so a page that disables or outlives the bridge can read what was shipped to it. Not an immediate break, but the defence is client-side only.
- **Acceptance check:** Filter the jar by host before injection (`compact` step in renderer/proxy), and document that `httpOnly` is a shim in this model.

### B4 — Direct iframe sandbox grants `allow-same-origin` + `allow-scripts`
- **Severity:** Medium (standard but worth noting)
- **Evidence:** `src/renderer.ts:68-73` sandbox string includes both; direct mode loads arbitrary origin into iframe.
- **Why:** Standard browser behaviour for a framed site, but combined with `allow-popups-to-escape-sandbox` and downloads it deserves a short note. Not a code change request unless Obsidian reviewers flag it.
- **Acceptance check:** Keep as-is; document rationale; no action unless review feedback.

### B5 — Proxy HTTP sanitisation is regex-based with no fuzz coverage
- **Severity:** Medium
- **Evidence:** `src/proxy.ts` `rewriteHtml`, `blockRemoteScripts`, `neutraliseMeta`, `stripIntegrity`, `transformOutsideOpaqueBlocks`. Complex manual HTML rewriting with no tests.
- **Why:** Edge cases (malformed tags, nested script strings, unusual quoting) could leak a remote script or break rendering. Observed code is careful (handles opaque blocks), but untested.
- **Acceptance check:** Fuzz/property tests against `rewriteHtml` for "no `<script src=...>` survives when `runScripts=false`" and "no restrictive meta survives".

---

## C. Nice-to-have (polish)

### C1 — README privacy wording vs. actual request
- **Severity:** Low
- **Evidence:** README: "Only the page HTML is requested", but proxy requests include the full target URL in the proxy query string, and r.jina.ai/jina fetches additional metadata. Cookies attached in `buildHeaders` when present.
- **Acceptance check:** Re-word to "the page address (and, in proxy mode, the page URL) is sent to the configured proxy; nothing else".

### C2 — `probeFramePolicy` GET fallback fetches full body on every origin
- **Severity:** Low (performance)
- **Evidence:** `src/proxy.ts:296-336` first HEAD then GET; GET returns full document but only headers are used; `framePolicyCache` mitigates per-origin only after first call.
- **Acceptance check:** Switch GET to `Range: bytes=0-0` or cap body read if Obsidian's API allows; measure first-load latency on mobile.

### C3 — CI Node versions include 24.x (pre-release-ish) with npm ci
- **Severity:** Low
- **Evidence:** `.github/workflows/lint.yml` matrix 20/22/24.
- **Acceptance check:** Keep matrix as-is or trim; not blocking.

---

## 4. Edge-case pass (requested)

| Area | Finding |
|---|---|
| Empty/unauthed state | Cookie jar loads from `data.json`; when `enableCookies` false, renderer passes `cookies=[]` and `ignoreCookies` logic skips attachment — OK. Library scan handles missing folder? `collectFiles` returns empty on failure mostly; verify in smoke test. |
| Concurrency | Downloader uses per-episode queues + segment pool with 429 backoff; appears well-engineered. No concurrency test. |
| Network degradation | `MAX_ATTEMPTS=3`, 429/408/transient handling, fallback endpoints; good. No offline cache for proxied pages (expected). |
| Timezones/mobile | Wake lock no-op on iOS documented; batch size derives from `navigator.deviceMemory`; good. |
| External path writes | See B2. |
| Proxy script toggle | README documents; default-on (see A3). |

## 5. No automated coverage — accepted risk + manual smoke checklist

**Risk statement:** There are no automated tests; correctness of proxy rewriting, cookie scoping, and download resume guards rests on manual verification. This is recorded as an accepted risk until B1 lands.

**Manual smoke checklist (run before any release):**
1. `npm run build` and `npm run lint` both PASS on a clean checkout (✓ verified 2026-10-23).
2. Install plugin in a real Obsidian vault (desktop + mobile where available).
3. Open browser → direct-mode site (e.g. example.com) renders; back/forward/reload work.
4. Proxy-mode site that refuses framing (e.g. news.ycombinator.com) auto-switches and renders; retry-with-proxy path works.
5. Set a **custom** Proxy endpoint → confirm no fallbacks are contacted (network trace).
6. Toggle **Run page scripts** off → client-rendered page blank/broken as documented; on → works.
7. Cookie jar: set cookie on origin A, confirm it is not sent to origin B; clear cookies flow prompts.
8. Bookmarks/history/search template produce expected URLs.
9. Anime downloader: search, pick series, single-episode download to default folder; file plays in library.
10. Cancel a download → staging file removed; fail a download → Resume/Discard both work; Download missing fills gaps.
11. Repair old videos command runs without crashing on an empty folder.
12. Library: scan, search, filter unwatched/in-progress, play, delete (with confirmation).
13. Settings: external-folder option visible only on desktop; vault-relative on mobile.
14. Uninstall/disable plugin → no lingering DOM errors in console.

## 6. Fold-in policy for parallel runs

Atlas (README-vs-code pre-digest) and Mike James (proxy/cost exposure rows) are running in parallel. Their artefacts, when written to `review/`, should be cross-referenced here; findings that duplicate A1–B5 should be merged rather than re-stated. Tempo's tracker should pull blockers from §A directly.

---

**End of Prism pass.** Final verdict remains **Ship-with-conditions** pending A1 (proxy fallback ownership), A4 (manifest author), and a maintainer decision on A2 (catalogue scope).

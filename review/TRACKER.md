# Review tracker — `browserformobile` (`/home/container/browserformobile`)

Bot/owner: **Tempo** (single source of truth). Repo at HEAD `935902d`, branch `main`. Build/lint per Forge: `npm run build` PASS, `npm run lint` PASS. Automated tests: NONE.

**Current ship status:** Ship-with-conditions (Prism verdict, 2026-10-23) — pending A1 (proxy fallback ownership), A4 (manifest author), and a maintainer decision on A2 (catalogue scope). Tracker seeded before Prism/Atlas ran; their reports are now on disk (`review/prism-review.md`, `review/atlas-predigest.md`) and rows reconciled opportunistically — statuses below are Tempo's reconciliation labels, not sign-offs.

**Legend — status:** `Waiting` = surfaced/not yet acted | `Reported` = review filed, not yet triaged by owner | `In progress` = being fixed | `Done` = acceptance check recorded | `Accepted risk` = logged as risk with follow-up.

## Table

| ID | Owner | Cat | Finding | Evidence (file/path) | Sev | Status | Acceptance check | Dependency / notes |
|---|---|---|---|---|---|---|---|---|
| F1 | Prism | a (blocker) | Public CORS-proxy fallbacks incl. maintainer Worker (`cors-proxy.christopher-j-hauser2025.workers.dev`) are default | `src/proxy.ts:44-72` (`FALLBACK_PROXIES`); `src/proxy.ts:533-540` trigger | High | Reported | Remove worker from defaults + publish source/status, OR gate behind explicit off-by-default setting; README must state maintainer-operated | Atlas doubles as A1 |
| F2 | Prism | a (blocker) | Proxied pages execute their own scripts by default | `src/settings.ts` `runScripts: true`; `src/proxy.ts:226-233` `rewriteHtml`; `src/renderer.ts:187` sandbox `allow-scripts` | Med-High | Reported | Decide default true-with-risk vs false-with-toggle; add warning line in settings copy | Atlas M1/M2: off toggle leaves inline scripts |
| F3 | Prism | a (blocker) | Manifest `author` = "OpenHands" vs actual publisher | `manifest.json` `author` | Medium | Reported | Set author/authorUrl to actual maintainer before tagged release; verify `version-bump.mjs` consistency | Atlas M5 confirms mismatch |
| F4 | Prism | a (blocker) | Downloader targets third-party catalogue of copyrighted material | `src/animeApi.ts:8` `DEFAULT_API_BASE`; `src/downloader.ts`; README Legal | High | Waiting (product/legal call) | Decide scope: keep + label experimental/opt-in, OR ship browser without downloader; document in README + manifest | Mike James money-side exposure |
| F5 | Prism | b (should-fix) | No automated test script or test files | `package.json` (no `test`); `src/` (no `*.test.*`); `.github/workflows/lint.yml` | High | Waiting | Adopt minimal unit-test strategy; manual smoke list (Prism §5) is gate until then | Accepted risk recorded |
| F6 | Prism | b (should-fix) | External (out-of-vault) writes not path-containment checked | `src/destination.ts` `ExternalDestination.open` / `validate` / `sanitizeName` | Medium | Waiting | Add `validate` enforcement in `open`/`write` rejecting escape paths; unit test for `../` | Only downloader uses it today |
| F7 | Prism | b (should-fix) | Cookie jar shared wholesale with proxied frame | `src/renderer.ts` `ProxyRenderer` → `BridgeConfig.cookies`; `bridge.ts` `hostMatches`/`pathMatches` | Medium | Waiting | Filter jar by host before injection (compact step); document `httpOnly` is a shim | Client-side enforcement today |
| F8 | Prism | c (document) | Direct iframe sandbox grants `allow-same-origin` + `allow-scripts` | `src/renderer.ts:68-73` sandbox string | Medium | Waiting | Keep as-is; document rationale; no code change unless reviewers flag | Standard behaviour |
| F9 | Prism | b (should-fix) | Proxy HTML sanitisation is regex-based with no fuzz coverage | `src/proxy.ts` `rewriteHtml`, `blockRemoteScripts`, `neutraliseMeta`, `stripIntegrity`, `transformOutsideOpaqueBlocks` | Medium | Waiting | Fuzz/property tests: no remote `<script src>` survives when `runScripts=false`; no restrictive meta survives | Affects trust boundary |
| F10 | Muse | c (nice-to-have) | README privacy wording vs actual request | README "Only the page HTML is requested" vs proxy query string + cookies on `buildHeaders` | Low | Waiting | Reword to "page address (and, in proxy mode, the page URL) is sent to configured proxy; nothing else" | Docs pass owns wording |
| F11 | Prism | c (nice-to-have) | `probeFramePolicy` GET fallback fetches full body on every origin | `src/proxy.ts:296-336`; `framePolicyCache` | Low | Waiting | Switch GET to `Range: bytes=0-0` or cap body read; measure first-load latency on mobile | Perf; non-blocking |
| F12 | Prism | c (nice-to-have) | CI matrix includes Node 24.x with npm ci | `.github/workflows/lint.yml` (20/22/24) | Low | Waiting | Keep or trim matrix; not blocking | Tooling hygiene |
| F13 | Mike James | a/b (money) | Proxy fallback hosts: billing/cost/uptime exposure | `src/proxy.ts` fallback set; `cors-proxy.christopher-j-hauser2025.workers.dev`; `r.jina.ai`, `api.cors.lol`, `allorigins.win` | Medium | Waiting | Money-side rows from Mike; billing endpoints/limits/owner documented | Mike James follow-up |
| F14 | Atlas | b (should-fix) | README cannot turn proxy off entirely in settings — no disable toggle; only clearing endpoint | `src/settings.ts` (`directFetch`, `proxyBase`); `src/proxy.ts:loadPage()` | Medium | Reported | Reword "turn off entirely" to "clear the proxy endpoint" OR add explicit toggle | Atlas M3; cross-checks F1 |
| F15 | Atlas | b (should-fix) | Rate-limit retry count mismatch: docs say 10, code uses 12 | `src/downloader.ts:69` `MAX_RATE_LIMIT_RETRIES = 12`; `:508` check `> 12` | Low | Reported | Update README to 12 retries or change code to 10 | Atlas M4 |
| F16 | Atlas | a (trust-boundary) | Sanitisation overstated: rewriteHtml only strips integrity, neutralises CSP/XFO/refresh meta, injects base, blocks remote scripts when runScripts===false; inline scripts always preserved | `src/proxy.ts:rewriteHtml`; default `src/settings.ts` | Medium | Reported | README wording confirm; acceptance with proxied page containing inline + remote scripts | Atlas M1/M2; cross-checks F2 |
| F17 | Prism | b (process) | Manual smoke checklist gate (14 steps) recorded as accepted risk | `review/prism-review.md` §5 | Medium | Waiting | Run 14-step checklist before any release (build/lint already ✓ 2026-10-23) | F5 pending |

## Coordination notes

- Prism verdict & top conditions: `review/prism-review.md` (Ship-with-conditions).
- Atlas claim-vs-code pre-digest: `review/atlas-predigest.md` (68 lines; M1-M5).
- Muse docs/copy pass and Mike James money rows still queued once audience/channel confirmed.
- Open question awaiting CJ Hauser: docs audience — end-users vs contributors, and channel (README / in-app notice / release note). Until answered, Muse and Mike James hold depth decisions.

## Follow-ups I own

1. Keep this file updated as F1-F17 move states; mark Done only after an acceptance check is actually recorded (tracker spec).
2. After Muse + Mike James land, append their rows here and reconcile duplicates via Atlas's merge policy (fold-ins, not re-statements).

---
*Tempo - Operations & Automation Lead - seeded 2026-10-23.*

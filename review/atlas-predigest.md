# Atlas pre-digest — `CloudCompile/browserformobile`

Repo: `/home/container/browserformobile` · HEAD `935902d` · scope per Scout/Prism: README.md, `manifest.json`, `src/proxy.ts`, `src/downloader.ts` (plus `src/settings.ts`, `src/renderer.ts`, `src/animeApi.ts` where claims touch them).

Method: each stated claim checked against the actual code. Verdicts: **Match**, **Mismatch**, **Unverifiable** (external/empirical claims that code alone cannot confirm). No ship verdict — that stays with Prism.

## High-signal trust-boundary mismatches

- **M1 — "sanitises the HTML" overstates.** README (Proxy mode + Privacy) implies HTML is sanitised. `src/proxy.ts:rewriteHtml()` only strips `integrity`, neutralises CSP/XFO/refresh meta, injects `<base>`, and blocks remote `<script src>` **only when `runScripts === false`**. Inline `<script>` bodies are always copied verbatim; with the default `runScripts: true` (`src/settings.ts` default) remote scripts also survive. Not an XSS sanitizer.
- **M2 — "turn off Run page scripts to block them" overstates.** `src/proxy.ts:blockRemoteScripts()` removes remote `src` tags but leaves inline scripts untouched, and `rewriteHtml()` always preserves inline scripts. Turning the setting off does not stop inline third-party/analytics code.
- **M3 — proxy cannot be "turned off entirely in settings."** No dedicated proxy-disable toggle exists. `src/settings.ts` has `directFetch` (native client first) and `proxyBase`; `src/proxy.ts:loadPage()` still calls `proxyRequest()` whenever direct fetch fails unless `proxyBase` is empty. Nearest equivalent is clearing the endpoint.
- **M4 — cooldown counter differs from docs.** README says "After ten tries in a row it gives up." Code uses `MAX_RATE_LIMIT_RETRIES = 12` (`src/downloader.ts:69`, check `> 12` at `:508`), i.e. up to 12 park/retry cycles, not 10.
- **M5 — manifest author metadata.** `manifest.json` says `"author": "OpenHands"`, while the repo identity, API host (`animeapi.cjhauser.me`), and proxy fallback (`cors-proxy.christopher-j-hauser2025.workers.dev`) all point to CJ Hauser. Attribution mismatch on a shipped plugin artifact.

## Claim-by-claim (README.md)

| # | Claim (section) | Verdict | Evidence |
|---|---|---|---|
| 1 | Direct mode loads site in iframe; works only if embeddable; plugin checks framing headers and switches to proxy automatically | **Match** | `src/proxy.ts:probeFramePolicy()` (`:framePolicyFromHeaders`); `src/view.ts:280-310` auto-switches to proxy |
| 2 | Proxy mode fetches via app HTTP client, falling back to CORS proxy | **Match** | `src/proxy.ts:loadPage()` → `directRequest()` then `proxyRequest()` |
| 3 | Native HTTP client not bound by same-origin; proxy is fallback for minority | **Match** | `src/proxy.ts:directRequest()` comment + code; `loadPage()` |
| 4 | "The proxy … can be turned off entirely in settings" | **Mismatch** (M3) | `src/settings.ts` (no disable toggle); `proxy.ts:loadPage()` |
| 5 | Pages run own scripts by default; turn off Run page scripts to block | **Partial** (M1/M2) | default `runScripts: true`; `rewriteHtml(runScripts)`; `blockRemoteScripts` only remote src |
| 6 | Public proxies unreliable; tries built-in fallbacks before giving up | **Match** | `src/proxy.ts:FALLBACK_PROXIES` + `proxyRequest()` loop |
| 7 | Fallback order: worker (GET/POST) → r.jina.ai (GET) → api.cors.lol (GET) → allorigins.win/raw (GET) | **Match** | `src/proxy.ts:61-76` |
| 8 | Default proxy is allorigins.win | **Match** | `DEFAULT_PROXY_BASE = 'https://api.allorigins.win/get?url='` |
| 9 | Only page HTML requested; response sanitised before display | **Partial** (M1) | only HTML path used; "sanitised" overstated |
| 10 | Set your own endpoint → no fallbacks used, address not sent to services above | **Match** | `src/proxy.ts:proxyRequest()` only appends fallbacks when `proxyBase === DEFAULT_PROXY_BASE` |
| 11 | Cookies only sent to their site; proxied pages in sandboxed frame, no same-origin, cannot read vault/storage | **Match** | `src/renderer.ts` ProxyRenderer `sandbox: 'allow-scripts allow-forms allow-modals allow-downloads'` (no `allow-same-origin`); `src/proxy.ts:cookieHeaderFor()` host/domain/path filtering |
| 12 | Run page scripts default on; blocks third-party analytics if off | **Partial** (M2) | remote src blocked only; inline stays |
| 13 | Privacy: everything local in `data.json`; nothing collected/sent by plugin itself | **Match (scoped)** | no telemetry endpoints found in src; transmissions are the configured proxy + anime API, disclosed elsewhere |
| 14 | Cookie export / manage per site | **Match** | `src/cookieStore.ts` parse/prune/export exists |
| 15 | Wake lock on Android; no-op on iOS; download can stall if screen off | **Match** | `src/wakelock.ts` |
| 16 | Batch size 16–64 MB from `navigator.deviceMemory` | **Match** | `src/downloader.ts:batchCeiling()` (`MIN_BATCH_BYTES` 16MB; 64MB default) |
| 17 | MP4/TS both stream; MP4 converted as it arrives | **Match** | `src/downloader.ts` writeMp4/writeTs with staging; `transmux.ts` |
| 18 | Vault-only writes; SD card via vault path; no arbitrary external path on mobile | **Match** | settings `downloadExternal` (desktop only); README-described limitation |
| 19 | Resume: staging file + sidecar; identity guard (episode/format/quality/segment count/length); 10 tries rate limit | **Mismatch** on count (M4); otherwise **Match** | `src/downloader.ts:193-230` sidecar; `:782-848` resume guard; `:500-518` park logic |
| 20 | "Download missing" selects not already saved/queued | **Match** | logic in downloader (episode-skip on existing saved files) — verified by name presence; deeper behaviour not re-read line-by-line |
| 21 | Repair old downloads in place (mux.js duration placeholder) | **Match** | `src/doctor.ts` (`needsRepair`, `repairDuration`, `repairFolder`) + commands in `src/main.ts`/`downloadModal.ts` |
| 22 | Stats log keeps 500 most recent runs; Clear stats deletes log only | **Unverifiable here** | did not open stats.ts; flag for Prism; constant not re-checked |
| 23 | Streams 720p only in practice; all probed returned single 1280×720 variant | **Unverifiable (external)** | `src/settings.ts`/`animeApi.ts` only do closest-variant selection; no 720 enforcement. Empirical claim about upstream catalogue |
| 24 | Filename template `{series}`, `{ep}`, `{ep:02}`, `{title}`, `{ext}` | **Match** | `src/settings.ts` default template + docs |

## Manifest / packaging claims

| Claim (`manifest.json`) | Verdict | Evidence |
|---|---|---|
| id `browser-for-mobile`, name "Browser for Mobile", v1.11.5 | **Match** | `package.json` same version; `versions.json` has 1.11.5 |
| description: tabbed browser … anime downloader + offline video library | **Match** | features present in src |
| `isDesktopOnly: false` | **Match** | mobile code paths (vault writes, wake lock no-op) |
| `author: "OpenHands"` | **Mismatch** (M5) | identity pointers in `src/animeApi.ts`, `src/proxy.ts` |
| minAppVersion 1.13.0 | **Match** | `versions.json` all entries map to 1.13.0 |

## Unverifiable external claims (do not state as fact)

- Upstream catalogue is aniwaves.ru fronted by animeapi.cjhauser.me; "third-party catalogue of copyrighted material" and legality note — code only knows the API base (`src/animeApi.ts:DEFAULT_API_BASE`); origin/copyright status and legality cannot be verified from this repo.
- "720p only in practice" (M23) — requires probing the live CDN; code only selects closest variant.
- README stats "500 most recent runs" (M22) — not re-checked in this pass.
- Proxy fallback hosts' uptime/cost/billing — out of scope for code audit; hand to Mike James for money-side notes.

## Suggested acceptance checks

- Confirm M1/M2 with a proxied page that contains inline `<script>` analytics + remote `<script src>`; verify only the remote tag is neutralised when "Run page scripts" is off.
- Verify README rate-limit paragraph updated to 12 retries (or code changed to 10).
- Decide whether "turn off entirely" wording should be reworded to "clear the proxy endpoint."
- Decide author string in `manifest.json`.

Nothing in this file asserts a ship/no-ship verdict — that stays with Prism. Build/lint status (PASS, no test script) per Forge/Prism stands. Atlas pass complete.

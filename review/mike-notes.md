# Mike James — money & cost-exposure notes (`browserformobile`)

Repo: `/home/container/browserformobile` · HEAD `935902d` · pass scope: external-cost, proxy/billing, and catalogue/CDN exposure. Source of grounding: `src/proxy.ts`, `README.md`, `manifest.json`; parts marked **evidence needed** could not be confirmed from the repo.

## Notes

**1. Proxy fallback chain is maintainer-funded infrastructure, not plugin-side billing.**
- Default `DEFAULT_PROXY_BASE` is `https://api.allorigins.win/get?url=` with 4 built-in fallbacks added only when the proxy is the shipped default (`src/proxy.ts` `proxyRequest()`), including `cors-proxy.christopher-j-hauser2025.workers.dev` (Cloudflare Worker, GET+POST), `r.jina.ai`, `api.cors.lol`, `allorigins.win/raw`.
- Client-side retry profile: `MAX_ATTEMPTS = 3`, `RETRY_DELAY_MS = 900`,sleep capped at 3× attempts with growing delay, per endpoint, across up to 5 endpoints (`src/proxy.ts` `MAX_ATTEMPTS`/`proxyRequest()` loop).
- Most traffic never hits proxies: `loadPage()` runs `directRequest()` (Obsidian native HTTP client) first and only falls back to proxy on failure or `directFetch === false`. So fallback-host load is a minority path.
- **Cost/abuse**: Cloudflare Workers pricing is the relevant line (free tier ~100k req/day, then paid per request). Traffic concentrates on the maintainer's Worker whenever users don't set their own endpoint. At scale that's a real bill and a single-point-of-failure; request volume/limits are **evidence needed** — no telemetry in the plugin (`README` Privacy: "Nothing is collected or sent anywhere by the plugin itself").

**2. Users can eliminate third-party exposure entirely (free, documented).**
- Setting a custom `proxyBase` disables all fallbacks; README documents this. No vendor contract cost. So the exposure is opt-in by default and avoidable — good for end-user cost, but the maintainer's default still carries load.

**3. Downloads land in the vault and follow vault sync — user-side storage/bandwidth cost.**
- README (Legal + "Where files are saved"): downloads are written inside the vault; "they sync with it if you sync your vault" — explicit user-side cost warning. Episodic 720p MP4s (README: single 1280×720 variant) via parallel segments (default 6, ~30 MB/s measured) implies tens-to-hundreds of MB per episode; full-series queues compound this.
- Sync target (Obsidian Sync or third-party) is the user's bill, not the plugin's. This is an evidențed README disclosure.

**4. Upstream catalogue / CDN economics are third-party-owned; legal exposure is not a dollar line.**
- `animeApi.ts` `DEFAULT_API_BASE` points at `animeapi.cjhauser.me` (per Atlas); actual CDN host, origin, copyright holder, and any licensing are **unverifiable from the repo** (Atlas pre-digest marks these unverifiable).
- The plugin supplies no CDN/infra and collects no revenue; the cost/risk here is legal (DMCA/copyright) borne by downloader users, not a billing line item. Flagged to Prism/decision-maker separately (F4).
- `mux.js` is the only runtime dep, so there's no paid SDK/embedded-service stack; zero third-party SaaS lock-in on the client side beyond the hardcoded proxy hosts above.

## Candidate tracker rows (for Tempo — fold in, don't duplicate F13)

| Suggested ID | Cat | Finding (title) | Evidence (file/path) | Sev | Status | Acceptance check |
|---|---|---|---|---|---|---|
| F13a (Mike James) | a/b (money) | Proxy fallback hosts: maintainer-operated Worker + 3 public proxies are default; 3× retries × up to 5 endpoints concentrate load/cost on maintainer Worker, with no usage telemetry | `src/proxy.ts` FALLBACK_PROXIES (`:63-71`), MAX_ATTEMPTS 3 (`:43`, `:588-626`), `DEFAULT_PROXY_BASE` (`:47`), README Privacy (`:281-294`) | Medium | Evidence needed | Document proxy host ownership/limits in README; either (i) confirm Cloudflare pricing/limits for Worker and set a free-tier guard in code/ops, or (ii) remove the Worker from defaults until owner confirms. Mark "evidenced" only once volume/limit data exists. |
| F13b (Mike James) | c (docs/cost) | Downloads sync with the vault: large library in a synced vault incurs cloud-sync storage/bandwidth on the user; README already warns | README "Where files are saved" (`:93-111`) — "they sync with it if you sync your vault" | Low | Evidenced | Keep the existing warning; acceptance = warning remains accurate after any future download-folder changes. |
| F13c (Mike James) | a (external) | Upstream catalogue/CDN cost & liability are third-party-owned; plugin has no revenue/infra role but distribution of downloader implies association; legal exposure tracked separately | `src/animeApi.ts` `DEFAULT_API_BASE` (only connection point, per Atlas); README Legal (`:208-213`) | High | Evidence needed | Get explicit decision on whether the downloader ships at all (Prism F4); if shipped, require opt-in + legal disclaimer confirmed against live upstream terms. Cost-of-hosting question stays "evidence needed" — no code available to verify. |

## Open to the team

- @Scout/@Prism: F4 scope decision (ship downloader or browser-only) is the precondition for F13c being anything other than "accepted risk."
- @Muse: if a doc pass happens, I'd like the proxy host list in README Privacy to include ownership notes (maintainer Worker vs generic public service) so users can route intelligently — not a blocker.
- Anyone wanting volume data: the plugin emits no telemetry, so exposure estimates need external (Cloudflare dashboard) data, which I don't have access to — hence two of three rows stay **evidence needed**.

— Mike James (Analysis, Finance & Metrics Lead)
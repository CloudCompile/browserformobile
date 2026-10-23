# animeapi.cjhauser.me — coverage review

Repo: `/home/container/browserformobile`. Probe date 2026-10-23. Base under test: `https://animeapi.cjhauser.me` (the only host referenced anywhere in the codebase; no alternate mirrors/configs exist).
Cross-check: code paths verified against the live service with real payloads. Provider note in `src/animeApi.ts` says "Only three endpoints exist" — it is actually four: `/api/search`, `/api/info`, `/api/episodes/:id`, `/api/stream`.

## Documented-vs-implemented matrix

| # | Endpoint | Used by | Implemented | Live-verified | Notes |
|---|----------|---------|-------------|---------------|-------|
| 1 | `GET /api/search?keyword=&page=&rated=` | `searchSeries` | yes | yes | Returns `{ success, results: { data[], totalPage } }`. ~22 rows/page. `rated=R_PLUS` accepted and surfaces 18+ titles (e.g. `dokyuu-hentai-hxeros-79815`). Fields match parser (`id`, `data_id`, `poster`, `title`, `japanese_title`, `tvInfo.{showType,sub,dub,eps}`). |
| 2 | `GET /api/info?id=` | `loadAnimeInfo` | yes | yes | Returns `{ success, results: { data, seasons } }`. Parser verified: `adultContent`, `title`, `japanese_title`, `poster`, `showType`, `animeInfo.{Type,Country,Premiered,Genre,Date aired,Status,Scores,Duration,Episodes,Studios,Producers,Overview,tvInfo}`, `metadata` (hoisted fields dropped), `recommended_data/related_data/popular_data`, `seasons`. Gap: `charactersVoiceActors` is present and ignored — out of scope, flag only. |
| 3 | `GET /api/episodes/:id` | `loadEpisodes` | yes | yes | Returns `{ success, results: { totalEpisodes, episodes[] } }`, fields `id`, `episode_no`, `title`, `filler`, `subbed`, `dubbed`. Parser match. Missing id yields 200 with empty list (not 404). |
| 4 | `GET /api/stream?id=&server=` | `loadStream` | yes | yes | Returns `{ success, results: { streamingLink, servers } }`. `streamingLink` has `server`, `link.file`, `iframe`. Alternate-server fallback by `serverName` (sub tracks first) verified against multi-server response. `server=` matched on `serverName`. |
| 5 | Over-page (`page=99`) | implicit | partial | yes | API responds `{ success:false, message:"Requested page exceeds total available pages." }` with no results. Parser reads undefined → `[]` and `Math.max(1,0)` => `1` totalPages. UI shows "Page 1 of 1" on empty. Flagged follow-up. |
| 6 | Empty/missing keyword | implicit | yes | n/a | Handled in code before request. |

## Multi-server note

There is no separate API mirror documented in the repo or code — only `animeapi.cjhauser.me` over HTTPS. "Multiple servers" means the streaming-servers list inside `/api/stream` (`servers: [{type, serverName, server_id, data_id}]`), which the implementation iterates (Vidplay etc.) plus the CDN host (`ru-ri-cdn3.echovideo.to`). The CDN requires `Referer: https://play.echovideo.ru/` — enforced in `loadStream`; without it segments 404.

The upstream legacy abhaythakur71181/Anime-API README documents a different API host (`api-anime-rouge.vercel.app`) with kebab-case `/aniwatch/...` routes and different field names — that is not this codebase's target. Our client targets the custom cjhauser instance exposing only the four endpoints above. No functionality missed relative to actual surface.

## Live probe log (representative)

- Search page 1: `/api/search?keyword=naruto&page=1` -> 200, 22 items, totalPage 1.
- Search page 2: `/api/search?keyword=naruto&page=2` -> success:false "Requested page exceeds total available pages."
- Search 18+: `/api/search?keyword=hentai&page=1&rated=R_PLUS` -> 2 (dokyuu-hentai-hxeros-*). Default search for that keyword returned empty-ish; rated param is the supported route and is what code sends. EVIDENCE NEEDED: whether default search hides 18+ titles or it is a catalog-size artifact.
- Info: `/api/info?id=naruto-76396` -> adultContent false, 23 seasons, 11 recommended, related groups Side Story/Sequel, 8 popular; studios from animeInfo.Studios.
- Info (rated): `/api/info?id=dokyuu-hentai-hxeros-79815` -> adultContent false reported even for an 18+ title. EVIDENCE NEEDED: whether adultContent ever evaluates true (only one 18+ title probed; need >=2 more).
- Episodes: `/api/episodes/naruto-76396` -> 220 episodes, parses `episode_no`, filler/subbed/dubbed.
- Episodes (missing): `/api/episodes/bogus-id-123` -> 200, totalEpisodes 0, episodes [].
- Stream: `/api/stream?id=naruto-76396?ep=76396_1` -> default server Vidplay, file URL, iframe null, servers lists Vidplay sub+dub.
- Info (missing): `/api/info?id=bogus-id-123` -> 200 data null, seasons [] -> code throws AnimeApiError "no details" (correct).

Latency all <1s. No auth/rate-limit encountered.

## Gaps / follow-ups (not patched)

1. Parsing robustness: over-page and empty results are not surfaced (UI shows "Page 1 of 1" on an error response). Suggest returning an error or clamping page.
2. Soft-fail path: `/api/episodes/:id` and `/api/info` return HTTP 200 with empty/null payloads instead of 404; episodes returns empty list silently vs info which throws.
3. Parity: `SeriesSummary` allows `adultContent`; `toSummary` in loadAnimeInfo does not copy it (only search path does). Minor inconsistency.
4. Cosmetic: header comment says "Only three endpoints exist" — actually four.
5. Untested in browser: detail stage, pagination, 18+ toggle rendering not exercised (no automated tests; manual smoke list in review/prism-review.md).

## Build/lint confirmation (untouched tree)

`npm run build` (tsc -noEmit + esbuild) and `npm run lint` (eslint) both exit 0. No code changed; only this document added.

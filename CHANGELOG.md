# Changelog

Every release, newest first. Each entry is a summary; the full notes live on the
release itself. Dates are the tag dates.

**Versioning.** User-facing improvements ship as a minor bump with a `.5` patch
(3.9.5 → 3.10.5); a plain `.0` minor is reserved for structural work. Two
numbers are skipped by design: `1.2.0` was reserved in `versions.json` but never
tagged, and `1.12.2` was never used. Unreleased work has no section here.

**Eras.** 1.0.x was a web browser; 1.1.0 added the anime downloader that became
the plugin; 3.0.0 removed the browser and renamed the product.

---

## 3.12.5 — 2026-11-12

- **Reorderable queue.** Queued and paused downloads carry move buttons, so the next episode to fetch is yours to choose. A move swaps with the nearest movable row; running and rate-limit-parked rows keep their places, and a parked row stays at the bottom until it retries.
- **Resume downloads on launch.** An opt-in setting continues queued downloads and revives paused ones with a partial on disk when Obsidian starts. Devices reporting a metered connection hold the resume until you start it yourself; iOS exposes no connection signal, so there it resumes regardless.
- **Per-series format and quality.** The episode picker's quality and format dropdowns set the choice for the series being picked, remembered per series, and each queued episode keeps the choice it was queued with — a later change never rewrites what is already waiting.
- **Grouped long episode lists.** A series longer than 50 episodes picks from collapsible numeric ranges (Episodes 1–50, 51–100, …) with per-group select and clear. The catalogue labels no seasons, so none are invented.
- **The finder reopens where you left it.** Source tab, section or genre, and page are remembered, with the 18+ tab restored only while its opt-in stands.

## 3.11.5 — 2026-11-12

- **Continue watching.** A strip above the library list shows half-watched episodes with their position and remaining time, most recently played first; tapping one resumes it.
- **Poster grid.** The library gains a grid view beside the filters, remembered between sessions. Posters come from catalogue answers already cached on the device; a series never browsed shows a fallback card.
- **Taste weighs how far you got.** An in-progress episode now counts in proportion to its watch fraction rather than raw seconds, so five minutes of a two-hour film is no longer the same signal as an hour.
- **Export and import.** New commands write watch progress and the download log to the download folder as JSON and CSV, and read them back behind a confirmation — replacing, not merging.
- **Not interested.** Recommendations can be dismissed from the card and brought back with one control at the top of the page.

## 3.10.5 — 2026-11-12

- **Subtitles as sidecar files.** When a stream carries a subtitle track, the downloader can save it as a WebVTT file next to the video and the player shows it automatically. Off by default (**Download subtitles**); the download resumes skip a track already fetched, and a stream with no subtitles makes no extra requests.
- **Prefer dub.** When the default server offers no downloadable file, the fallback can try dubbed servers first. Dub availability follows the catalogue — many series are subbed only.
- The README's rate-limit retry count matches the code (twelve, not ten).

## 3.9.5 — 2026-11-11

- **Export debug log.** The **Export debug log** command copies the plugin's debug log into the download folder as a markdown file, ready to attach to a bug report. The log is flushed first; an existing export is stamped rather than overwritten.

## 3.8.5 — 2026-11-11

- **Downloads organised into series folders.** The default template is now `{seriesFolder}/{series} - {ep:02} - {title}.{ext}`. Existing downloads are not moved; the download manager offers a migration, and the library reads both layouts.
- **Mobile debug diagnostics** — non-secret runtime details (platform, device memory, network quality, screen, view state) collected for a bug report.
- **Diagnostic logging for downloads**, written next to the plugin's data.
- The download manager shows downloaded videos on open instead of waiting for a scan.

## 3.7.5 — 2026-11-11

- **The download queue survives an Obsidian restart.** Queued and paused episodes are saved with their series and episode details and restored on load; failed episodes with a partial on disk were already recoverable.
- **Previous and Next in the player**, so watching a series does not mean closing the player to pick the next row.

## 3.6.5 — 2026-11-11

- **Memory guard for repair:** a conversion that cannot fit the device's memory budget is skipped with a clear message instead of an out-of-memory restart.
- **Free-space check before a download starts**, where the platform exposes a storage quota.
- The library, player, and download windows handle closing while a scan or job is in flight.

## 3.5.7 — 2026-11-11

- Re-packaging release: identical code to 3.5.6, rebuilt so the version metadata matches what shipped.

## 3.5.6 — 2026-11-11

- **Slow video scans are no longer marked failed.** A scan of a large library could outlast the failure notice; scans now report progress and complete.

## 3.5.5 — 2026-11-11

- **A repaired file is read once, not twice.** The download-manager scan seeds the repair ledger, so the first repair after a scan reads only the files the scan flagged.

## 3.5.4 — 2026-11-11

- **A repair pass skips files it has already cleared.** A ledger of `{size, mtime}` stamps is trusted only while both match; a re-download invalidates itself. A 20 fragmented + 20 healthy library goes from 40 reads unseeded to 20 after a scan.

## 3.5.3 — 2026-11-11

- **Batch repairs run together, and each file's boxes are parsed once**, so **Repair all** over a large library finishes noticeably sooner.

## 3.5.2 — 2026-11-11

- **Repair holds the file once, not twice.** Conversion streams straight through to the temp file, roughly halving peak memory on large libraries. Repairs are still never written in place.

## 3.5.1 — 2026-11-11

- **Repairs no longer rewrite a download in place.** Repairs write to a temp file and swap it in only when complete, so a failed repair cannot lose the original.
- Plugin buttons get explicit styling inside the plugin's scopes, so themes that override native buttons cannot break them.

## 3.5.0 — 2026-11-11

- Every plugin surface rebuilt on a shared design-token and primitive layer, with mobile tap-target and zoom fixes.

## 3.4.0 — 2026-11-11

- **Find anime** — browse the catalogue without a search: listing sections (most popular, top airing, top upcoming, recently added, completed, formats) and genre pages, then straight into the downloader.
- **An opt-in 18+ finder** with its own sections and genre list, behind the existing toggle.
- The downloader can be opened directly on a title, carrying its source.

## 3.3.0 — 2026-11-10

- **Support for the opt-in 18+ source.** Search, episodes, details, and stream requests tagged with the `hentaimama` provider route to its own endpoints and map into the existing shapes. The finder UI for it arrives in 3.4.0.

## 3.2.5 — 2026-10-27

- **MP4 downloads written progressively**: `ftyp`, media, then a real movie header with sample tables derived from the actual samples. mux.js only emits a *fragmented* movie, which a phone gallery, TV, QuickTime, and Windows read as a black rectangle.
- **Repairs convert legacy fragmented files in place** through the same writer.
- Decision-model blend weights tightened so the details page and the recommendations page rank identically.
- `tests/mp4.test.ts` covers the progressive writer, the resume index, and the doctor's conversion against a real mux.js fixture.

## 3.1.0 — 2026-10-27

- The in-process recommendation curator, shipped in a clean release. Content identical to 3.0.3, which was left in draft at the time.

## 3.0.3 — 2026-10-26

- **Curate with a language model:** a model server on your machine (Ollama, LM Studio, llama.cpp), a hosted API behind a **Jev API key**, or **In this plugin** — WebAssembly, on device, grammar-constrained decoding (~5× faster, cannot emit malformed JSON), hash-checked runtime.
- The model can re-order and remove but **never add**; every failure falls back to the catalogue ranking unchanged.
- Recommendations spread across the whole history: damped seed engagement and diversification, so one binge-watched series cannot fill the page.

## 3.0.2 — 2026-10-26

- **Recommendations now use your whole history.** The page mined only the first four series and silently ignored the rest.
- Seeds fetched four at a time; the grid fills in as results arrive. Shared blend weights across both ranking surfaces.

## 3.0.1 — 2026-10-26

- **Recommendations page** — a poster grid over the whole download history, answering "what to watch next", with a reason line, **Details**, and **Download** per card. Seeds are mined one lookup each; the page opens immediately and fills in.

## 3.0.0 — 2026-10-25

- **The browser is removed.** A plugin cannot embed a real engine on Obsidian mobile; the proxy/iframe rendering was never going to be reliable. Tabs, history, bookmarks, the cookie jar, proxy mode, and their settings are gone.
- **Series details page** (`/api/preview/:id`): score, rank, popularity, status, season, studios, source, synopsis, genres and themes, opening/ending themes, cast and staff, trailer, broadcast schedule.
- **Recommendations** in three modes: catalogue votes blended with a BM25 text match (default), a local TinyDecide model, or the hosted Jev model.
- **Glass effect** setting (desktop only).
- `downloadScanCache` gets a real persisted field, written through `saveSettings`.
- The plugin id and folder stay `browser-for-mobile`, so this installs over an existing browser install.

---

## 2.0.0 — 2026-10-25

- **Faster library scans:** one `stat` per file with bounded concurrency (8 at a time) instead of a round-trip per file; filename templates compiled once.
- **Watch progress can no longer be wiped by a bad scan:** `prune` runs only after a complete walk, so a briefly-missing folder no longer deletes every saved position.
- `ensureParents` remembers confirmed folders; `elapsedSeconds` caches cumulative playlist durations in a `WeakMap`.
- The framing-policy cache is capped (200 origins, 30 minutes) and expires.
- Fixed: the anime search requested the real last page instead of clamping to itself.

## 1.13.5 — 2026-10-24

- **Cache anime API responses:** details a week, episode lists 12 hours, search and stream URLs 10 minutes. Stream URLs stay memory-only — a link from a previous session is usually dead. Concurrent requests share one call; failures are never cached. Measured: search 405 ms → 0 ms on a repeat.

## 1.12.4 — 2026-10-23

- The scan no longer runs on view open; **Scan** inspects on demand, and **Fix needs-repair** repairs cached flagged files without a full rescan.

## 1.12.3 — 2026-10-23

- **The download manager's scan cache survives a reopen.** All settings writes preserve it, not just some.

## 1.12.1 — 2026-10-23

- Persistent scan cache (mtime + size), single-pass inspection, and throttled rendering for the download manager on large libraries (676+ files); first scan faster, reopens effectively instant.

## 1.12.0 — 2026-10-23

- Review follow-ups: path containment for external downloads (F6), proxy cookie jar host filtering (F7), the real maintainer in the manifest (F3), a `runScripts` risk warning (F2), and a TypeScript test runner (F5).

## 1.11.9 — 2026-10-23

- Live scan progress bar, cached and parallel inspection, incremental paint while scanning.

## 1.11.8 — 2026-10-23

- **Download manager workspace view:** a dedicated tab for listing, repairing, and deleting downloaded videos, with per-row actions, **Repair all**, refresh, and filters.

## 1.11.7 — 2026-10-23

- Fixed: the MP4 track (`tkhd`) duration was written in milliseconds instead of movie timebase ticks, so some players (Google Photos, Samsung Gallery) read ~15 s and rejected the file. Legacy files are repaired by the doctor.

## 1.11.6 — 2026-10-23

- Search paging with Prev/Next and a page indicator, an 18+ toggle above results, and a detail stage in the download modal. Live-verified endpoints: `/api/search`, `/api/info`, `/api/episodes`, `/api/stream`.

## 1.11.5 — 2026-10-21

- **Fall back to a download-capable server when the default is embed-only.** One Piece answered with DatSaV (embed-only) while the same response listed Vidplay and MyCloud, which do return a file. The downloader walks the servers by name, subbed tracks first.

## 1.10.5 — 2026-10-21

- Fixed: **Repair old videos** reported every file as failed on mobile. `VaultAdapter.list` returns vault-relative (rooted) paths and the walker joined the folder twice, producing `Anime//Anime/Ep 1.mp4`. The repair and library scans share one correct walker.
- The repair notice names the first failure reason instead of a count.

## 1.9.5 — 2026-10-21

- **Download statistics page:** totals (size, time, average and best speed), a bar per recent run, a per-series breakdown, and the individual runs newest first.
- **Per-run log** — series, episode, bytes transferred, duration, average and peak speed, format, quality, outcome. Failed and cancelled runs are counted but excluded from the speed totals. A resumed run counts only the bytes it actually fetched. The log keeps the 500 most recent runs.

## 1.8.5 — 2026-10-20

- **Honest speed and ETA.** Speed is a blend of a long-run average with the *median* of recent readings (the raw interval rate swings 2–70 MB/s and a mean chases the spikes); time remaining comes from the stream's bitrate and playlist durations. Against wall-clock truth: average error 51% → 42%, systematic bias +24% optimistic → ~1%.
- The downloader footer shows live network speed across the queue, a session average, and a peak reading.

## 1.7.0 — 2026-10-20

- **Pause and resume** for running or queued downloads, with a fresh retry budget on manual resume.
- **Crash-safe restore:** a killed app's queue is rebuilt from staging files on the next open, and a staging file longer than its sidecar describes is trimmed back, not discarded.
- **Rate-limit gate:** a 429 halves the concurrency target, which creeps back up and never past the level that failed. Measured on a 138-segment episode: a 12-parallel start went from ~242 s to ~9.5 s. Retries are automatic for transient errors and immediate for deterministic ones.
- The confirm dialogs use the plugin's own dialog and can be turned off.

## 1.6.0 — 2026-10-20

- **Video library:** browse every downloaded episode, play in-app, resume from the saved position, search, filter (all/unwatched/in progress), see progress at a glance, delete behind a confirmation.
- Fixed: the repair walk joined vault-relative listings wrong (`folder/folder/child`), reporting every file failed. Shared with the new library.

## 1.5.0 — 2026-10-20

- **Mobile UI overhaul:** bottom action bar, overflow and tab-switcher bottom sheets, keyboard-aware layout via the visual viewport, 44px targets, drag-to-dismiss sheets.

## 1.4.0 — 2026-10-20

- **Screen wake lock while a download runs** (Chromium-only; a no-op on iOS, documented as such). Reference-counted holds, re-acquired on show, released while parked on a rate limit.
- **Batch size follows device memory:** 16/32/64 MB ceilings from `navigator.deviceMemory`, full ceiling where it is absent.
- **Layout clears the notch:** `env(safe-area-*)` insets, `100dvh` full-screen modals, 16px inputs on touch devices to stop iOS zooming, sub-44px targets grown.
- Fixed: the format picker still claimed MP4 buffered the whole episode.

## 1.3.1 — 2026-10-20

- **The write path was the bottleneck, not the network.** Appending to a vault file rewrites it whole each time — an n-byte file moves ~n² bytes (an 800 MB movie moved ~10 GB). Desktop now writes through a real file handle and appends in O(1); mobile batches double.
- Parallel segments default rises 3 → 6, and concurrency becomes a target that sheds on a 429 and recovers after a cooldown.

## 1.3.0 — 2026-10-20

- **Resumable downloads:** staging `.part` file plus sidecar; resume offered per failed episode, as **Resume all**, and from the episode picker. Resume requires the episode, format, quality, segment count, and length to match — otherwise the partial is discarded rather than spliced. Cancel removes the partial; fail keeps it.
- **Large files no longer restart the phone:** the transmuxer is driven a window at a time (a 726 MB stream measured ~4 GB peak before), and MP4 streams to the staging file as it converts.
- **Rate-limited runs park, not fail:** moved to the bottom of the queue with a growing wait, keeping everything on disk.
- Downloader opens full screen by default; progress updates patch rows in place instead of rebuilding the list, fixing the freeze on phones; **Download missing** fills only the gaps.

## 1.1.1 — 2026-10-20

- Fixed: every video showed the same length (the unknown-duration sentinel clamped to 1:35:15 in players that read track headers); segments could land out of order or the first be dropped; the reported size counted received rather than written bytes.
- Writes are coalesced and MP4 streams to disk, roughly halving peak memory; **Parallel episodes** defaults to 1.

## 1.1.0 — 2026-10-19

- **The anime downloader.** Search the catalogue, pick episodes (all/none/invert/skip filler/range), download in the background. MP4 (converted) or TS (raw stream) output; quality picks the closest variant, since sources are 720p in practice. Vault-only saving on mobile, external on desktop. Verified end to end against the live API: a 138-segment episode (100.6 MB TS) and a transmuxed MP4 with correct codecs and duration.

---

## 1.0.6 — 2026-10-17

- Browser-era fix: fetches send a browser User-Agent and `Sec-Fetch` headers so search engines stop serving bot challenges; the default search engine moves to the server-rendered `html.duckduckgo.com`, with stored defaults migrated.

## 1.0.5 — 2026-10-17

- Browser-era fix: restores the framing-header preflight, probing with GET so servers that only send the header on a real navigation are still detected. A refusing site switches to the proxy instead of `ERR_BLOCKED_BY_RESPONSE`.

## 1.0.4 — 2026-10-16

- Browser-era fix: a page's own script errors no longer blank the page. Page script errors flag the tab and show a status instead of emptying the DOM; `window.parent`/`frameElement` are shimmed in the opaque-origin sandbox so framebusting reads resolve.

## 1.0.3 — 2026-10-16

- Browser-era change: proxied page scripts run by default, with a **Run page scripts** setting to block them. The bridge shims `localStorage`/`sessionStorage` and a non-zero viewport for the sandbox.

## 1.0.2 — 2026-10-16

- Browser-era fix: pages that write a script tag from JavaScript broke the rewriter (`document.write('<script …>')` matched as markup). The rewriter now walks the document like the parser; a neutralised script tag loses its `src` entirely.

## 1.0.1 — 2026-10-16

- Browser-era fixes: sites that refuse embedding are detected via framing headers and switch to the proxy; the proxy fallback chain (a Cloudflare Worker, `r.jina.ai`, `api.cors.lol`, `allorigins.win`) survives 5xx and 429. Custom endpoints disable the public fallbacks.

## 1.0.0 — 2026-10-14

- **First release: Browser for Mobile**, a tabbed web browser inside Obsidian, including on mobile. Tabs, address bar with search, per-tab and global history, bookmarks, a cookie jar with a manager, and two render modes: direct (iframe) and proxy (fetched, sanitised HTML). Responsive, touch-friendly layout.

---

*Unreleased changes are listed in the repository's commit history and issue
tracker, not here.*

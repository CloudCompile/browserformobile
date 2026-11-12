# Roadmap

Where the plugin is going, in the order it is going there. Every item below is a
GitHub issue with its milestone and labels attached; this file is the map, the
issues are the work.

- **Milestones are versions.** The plugin ships user-facing improvements as a
  minor bump with a `.5` patch (4.0.5 → 4.1.5), so milestone titles are the
  version they become; a plain `.0` minor marks structural work.
- **Dates are intentions, not promises.** A milestone slipping is answered by
  rescheduling it, not by shipping a rushed repair.
- **Nothing here lands without the gates:** `npm run build`, `npm run lint`, and
  `npm test` clean, plus a manual pass on a real phone for anything that touches
  downloads, the library, or memory.

## How to read this file

| Milestone | Due | Theme |
|---|---|---|
| [4.1.5 — Subtitles and next up](https://github.com/CloudCompile/browserformobile/milestone/6) | shipped 2026-11-12 | Playback polish that needs no new provider |
| [4.2.5 — Decisions](https://github.com/CloudCompile/browserformobile/milestone/7) | shipped 2026-11-12 | The questions 3.x deferred get answers |
| [5.0.0 — The local catalogue](https://github.com/CloudCompile/browserformobile/milestone/8) | shipped 2026-11-12 | Metadata lives on disk, not behind the API |
| [5.1.5 — Seasons](https://github.com/CloudCompile/browserformobile/milestone/9) | 2027-04-03 | Seasons when a provider honestly labels them |
| [6.0.0 — The player as a surface](https://github.com/CloudCompile/browserformobile/milestone/10) | 2027-05-01 | Playback stops being a modal |
| [Backlog](https://github.com/CloudCompile/browserformobile/milestone/5) | — | Real ideas, no committed version |

Shipped milestones stay in the table until the next rewrite; their issues are
closed and the CHANGELOG is the record.

## Shipped this line

- **4.1.5 — Subtitles and next up**: the sidecar subtitles the downloader saves
  gained preferences — on/off, text size, and a ±0.5 s delay stepper — and the
  player can hand you the next episode when one finishes. What was originally
  planned here (a second catalogue provider) moved to the backlog; the second
  source waits on API work outside this repository.
- **4.2.5 — Decisions**: what vault sync really carries, the watch-progress
  conflict rule (further position wins), TS repositioned as archive-only, and
  per-device download statistics.
- **5.0.0 — The local catalogue**: series metadata became a bounded store on
  disk; details pages paint offline and refresh in the background, the
  catalogue's own recommendations survive an unreachable API, and library rows
  show posters without a single network call at render time.

## 5.1.5 — Seasons

The small version between two structural ones, spent on the watching half.

- **Real seasons when a provider labels them** — [#38](https://github.com/CloudCompile/browserformobile/issues/38).
  Picker groups, the `{season}` filename token, and `inferSeason` follow the
  provider's own labels; a source without seasons keeps #13's honest numeric
  ranges unchanged.

## 6.0.0 — The player as a surface

Structural, and the destination of this roadmap: playback stops being a modal
that dies with the window and becomes the app's other room.

- **The player as a view** — [#40](https://github.com/CloudCompile/browserformobile/issues/40).
  Survives navigation, keeps its position across opens, reachable alongside the
  queue on a narrow screen. The modal remains as a wrapper, not a second
  implementation.
- **Continuous playback** — [#41](https://github.com/CloudCompile/browserformobile/issues/41).
  A series plays through in download order, skipping what the watched threshold
  already covers, resolving the next file at play time — never pre-loading one.
  The auto-advance from 4.1.5 is the single-episode seam of this.

## Backlog

Real ideas, promoted when there is a version to put them in.

- **A second catalogue provider behind the existing plumbing** — [#22](https://github.com/CloudCompile/browserformobile/issues/22).
  Blocked on API-side work outside this repository; the plugin side is nearly
  ready.
- **Provider-scoped identity** — [#31](https://github.com/CloudCompile/browserformobile/issues/31).
  Cache keys, details pages, and the download log carry the provider, so two
  sources handing out the same numeric id stay two different series.
- **Per-provider settings** — [#32](https://github.com/CloudCompile/browserformobile/issues/32).
  Each source's base URL and enablement live with the source; a disabled source
  leaves no orphaned tab, and a persisted finder state pointing at one falls
  back the same way the 18+ gate falls back.

## Non-goals

- **A built-in web browser.** Removed in 3.0.0 and not coming back: Obsidian
  mobile cannot host a real engine, and the proxy rendering it relied on was
  never reliable. The downloader and library do not need one.
- **Playback of formats the platform cannot decode.** No bundled codecs; the
  library tells the user rather than showing a black rectangle.
- **Anything that widens what the recommendation models send.** The hosted
  model sends the taste profile and candidate titles, stays off by default, and
  gains no additional fields.

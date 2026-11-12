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
| [4.0.0 — Foundations](https://github.com/CloudCompile/browserformobile/milestone/4) | shipped 2026-11-12 | Everything the 3.x line carried by hand |
| [4.1.5 — A second source](https://github.com/CloudCompile/browserformobile/milestone/6) | 2027-01-09 | The catalogue stops being single-provider |
| [4.2.5 — Decisions](https://github.com/CloudCompile/browserformobile/milestone/7) | 2027-02-06 | The questions 3.x deferred get answers |
| [5.0.0 — The local catalogue](https://github.com/CloudCompile/browserformobile/milestone/8) | 2027-03-06 | Metadata lives on disk, not behind the API |
| [5.1.5 — Watching gets smarter](https://github.com/CloudCompile/browserformobile/milestone/9) | 2027-04-03 | Seasons when they are real, subtitles that fit |
| [6.0.0 — The player as a surface](https://github.com/CloudCompile/browserformobile/milestone/10) | 2027-05-01 | Playback stops being a modal |
| [Backlog](https://github.com/CloudCompile/browserformobile/milestone/5) | — | Real ideas, no committed version |

Shipped milestones stay in the table until the next rewrite; their issues are
closed and the CHANGELOG is the record.

## 4.1.5 — A second source

The 18+ tab already proves the provider plumbing: two sources, one picker, one
downloader. What it does not prove is identity — and identity is where a second
provider bites.

- **A second catalogue provider behind the existing plumbing** — [#22](https://github.com/CloudCompile/browserformobile/issues/22).
  The API side has to exist first; the plugin side is nearly ready.
- **Provider-scoped identity** — [#31](https://github.com/CloudCompile/browserformobile/issues/31).
  Cache keys, details pages, and the download log carry the provider, so two
  sources handing out the same numeric id stay two different series.
- **Per-provider settings** — [#32](https://github.com/CloudCompile/browserformobile/issues/32).
  Each source's base URL and enablement live with the source; a disabled source
  leaves no orphaned tab, and a persisted finder state pointing at one falls
  back the same way the 18+ gate falls back.

## 4.2.5 — Decisions

Two questions the 3.x line kept deferring, answered with behaviour rather than
README paragraphs alone.

- **Document what syncs** — [#25](https://github.com/CloudCompile/browserformobile/issues/25).
  Downloads and `data.json` both live in the vault; say what that means on two
  devices, precisely.
- **Watch progress: the conflict rule** — [#33](https://github.com/CloudCompile/browserformobile/issues/33).
  A vault sync gives two devices a write to the same record; the rule (the
  further position wins, with a real `updatedAt`) is defined, implemented, and
  documented.
- **Decide the fate of TS output** — [#24](https://github.com/CloudCompile/browserformobile/issues/24).
  A maintainer decision, not code: streaming MP4 removed TS's memory advantage.
  Whatever the answer, the UI stops implying both formats are equals.
- **Statistics for a merged log** — [#34](https://github.com/CloudCompile/browserformobile/issues/34).
  Two devices downloading one series is two runs; the summary explains the
  double-count instead of hiding it.

## 5.0.0 — The local catalogue

Structural, and the reason this is a `.0`: series metadata becomes a store on
disk, not a cache of API answers. Everything that reads catalogue text reads the
store, and the API becomes a refresh rather than a dependency.

- **Persistent series metadata** — [#35](https://github.com/CloudCompile/browserformobile/issues/35).
  Bounded, persisted with every other store, documented in the privacy section:
  catalogue text on the device, nothing more.
- **Details pages offline** — [#37](https://github.com/CloudCompile/browserformobile/issues/37).
  Stale-while-revalidate: paint from the store, correct in the background.
- **Posters for library rows** — [#23](https://github.com/CloudCompile/browserformobile/issues/23).
  From the store, never from the network at render time, never an adapter call —
  the perf-budget suite holds this one to its word.

## 5.1.5 — Watching gets smarter

The small version between two structural ones, spent on the watching half.

- **Real seasons when a provider labels them** — [#38](https://github.com/CloudCompile/browserformobile/issues/38).
  Picker groups, the `{season}` filename token, and `inferSeason` follow the
  provider's own labels; a source without seasons keeps #13's honest numeric
  ranges unchanged.
- **Subtitle preferences in the player** — [#39](https://github.com/CloudCompile/browserformobile/issues/39).
  Size, delay, and on/off for the sidecar tracks #5 already saves; defaults in
  settings, controls on the existing overlay.

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

## Backlog

Real ideas, promoted when there is a version to put them in. The 4.x and 5.x
work above promoted the last four; the backlog starts empty by design.

## Non-goals

- **A built-in web browser.** Removed in 3.0.0 and not coming back: Obsidian
  mobile cannot host a real engine, and the proxy rendering it relied on was
  never reliable. The downloader and library do not need one.
- **Playback of formats the platform cannot decode.** No bundled codecs; the
  library tells the user rather than showing a black rectangle.
- **Anything that widens what the recommendation models send.** The hosted
  model sends the taste profile and candidate titles, stays off by default, and
  gains no additional fields.
- **Hiding the catalogue's limits.** Streams are 720p; filler and dub flags are
  unreliable; season labels exist only where a provider honestly provides them.
  The UI may group, but it never invents.
- **Sync services of our own.** The vault's sync is the sync; the plugin's job
  is to make its records survive it (4.2.5), not to replace it.

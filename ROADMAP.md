# Roadmap

Where the plugin is going, in the order it is going there. Every item below is a
GitHub issue with its milestone and labels attached; this file is the map, the
issues are the work.

- **Milestones are versions.** The plugin ships user-facing improvements as a
  minor bump with a `.5` patch (3.9.5 → 3.10.5), so milestone titles are the
  version they become.
- **Dates are intentions, not promises.** A milestone slipping is answered by
  rescheduling it, not by shipping a rushed repair.
- **Nothing here lands without the gates:** `npm run build`, `npm run lint`, and
  `npm test` clean, plus a manual pass on a real phone for anything that touches
  downloads, the library, or memory.

## How to read this file

| Milestone | Due | Theme |
|---|---|---|
| [3.10.5 — Subtitles and track choice](https://github.com/CloudCompile/browserformobile/milestone/1) | 2026-11-27 | Watch what the source actually serves |
| [3.11.5 — Library and taste](https://github.com/CloudCompile/browserformobile/milestone/2) | 2026-12-18 | The library learns how you watch |
| [3.12.5 — Catalogue depth](https://github.com/CloudCompile/browserformobile/milestone/3) | 2027-01-15 | Long series and big queues behave |
| [4.0.0 — Foundations](https://github.com/CloudCompile/browserformobile/milestone/4) | 2027-02-12 | Everything the 3.x line carried by hand |
| [Backlog](https://github.com/CloudCompile/browserformobile/milestone/5) | — | Real ideas, no committed version |

## 3.10.5 — Subtitles and track choice

The streams carry more than the plugin keeps. This version takes what is
already in the master playlist instead of building anything new.

- **Download subtitle tracks as sidecar files** — [#5](https://github.com/CloudCompile/browserformobile/issues/5).
  WebVTT renditions downloaded alongside the media, written next to the final
  file, picked up by the player automatically.
- **Prefer the dubbed audio track when asked** — [#6](https://github.com/CloudCompile/browserformobile/issues/6).
  A **Prefer dub** setting that steers server selection; documented honestly,
  since much of the catalogue is subbed-only.
- **README rate-limit retry count matches the code** — [#7](https://github.com/CloudCompile/browserformobile/issues/7).
  The README says ten tries, the code allows twelve. Small, real, and the kind
  of thing a new contributor can own.

## 3.11.5 — Library and taste

The library knows what was downloaded; the recommendations know what was
downloaded too. Neither knows what was *watched* — this version fixes that.

- **Continue-watching row** — [#8](https://github.com/CloudCompile/browserformobile/issues/8).
  In-progress episodes at the top of the library, most recent first.
- **Poster-grid view** — [#9](https://github.com/CloudCompile/browserformobile/issues/9).
  The same grid the recommendations page uses, over the library, falling back
  to text when the catalogue has no cover.
- **Watch-weighted recommendations** — [#10](https://github.com/CloudCompile/browserformobile/issues/10).
  Finished series outrank abandoned ones; the damped scale stays, so one binge
  can never dominate the page again.
- **Export watch progress and statistics** — [#11](https://github.com/CloudCompile/browserformobile/issues/11).
  JSON and CSV exports, restore behind the destructive-action gate.
- **Not-interested on recommendation cards** — [#12](https://github.com/CloudCompile/browserformobile/issues/12).
  Dismissals persist across refreshes and are clearable.

## 3.12.5 — Catalogue depth

Long series and large queues. Nothing here is glamorous; all of it is the
difference between a tool for a handful of episodes and one for a library.

- **Season grouping** — [#13](https://github.com/CloudCompile/browserformobile/issues/13).
  Grouped, collapsible episode selection when the API exposes seasons; honest
  numeric chunking when it does not.
- **Reorder the queue** — [#14](https://github.com/CloudCompile/browserformobile/issues/14).
  Move queued rows up and down; rate-limit parking stays load-bearing and
  non-overridable.
- **Auto-resume on launch** — [#15](https://github.com/CloudCompile/browserformobile/issues/15).
  The 3.7.5 persisted queue plus an opt-in setting that picks the work back up
  after the app was killed.
- **Per-series quality and format** — [#16](https://github.com/CloudCompile/browserformobile/issues/16).
  The picker remembers what a series used last; the global setting remains the
  default.
- **Finder remembers its place** — [#17](https://github.com/CloudCompile/browserformobile/issues/17).
  Source, section, and page restored on open; the 18+ tab never restores
  against its opt-in gate.

## 4.0.0 — Foundations

Work that makes the next three years cheaper than the last three months.

- **Release pipeline** — [#18](https://github.com/CloudCompile/browserformobile/issues/18).
  Tag to drafted release with assets and notes, automatically. This is the fix
  for how 18 duplicate drafts and a shelf of note-less releases happened.
- **iOS download resilience** — [#19](https://github.com/CloudCompile/browserformobile/issues/19).
  The wake lock is a no-op on iOS; make a suspended download leave a clean
  resumable partial and say exactly what iOS can and cannot do.
- **Performance budget and regression harness** — [#20](https://github.com/CloudCompile/browserformobile/issues/20).
  The 1.11.x scan fixes were won by hand against a 676-file library; a suite
  should lose them, not a user.
- **User guide with screenshots** — [#21](https://github.com/CloudCompile/browserformobile/issues/21).
  Split the audience: README to install, guide to use, CONTRIBUTING to build.

## Backlog

Real ideas, promoted when there is a version to put them in.

- **Second catalogue provider** — [#22](https://github.com/CloudCompile/browserformobile/issues/22).
  Blocked on the API side existing; the plugin is nearly ready.
- **Posters for library rows** — [#23](https://github.com/CloudCompile/browserformobile/issues/23).
  Lazy, cached, never blocking the list.
- **Decide the fate of TS output** — [#24](https://github.com/CloudCompile/browserformobile/issues/24).
  A maintainer decision, not code: streaming MP4 removed TS's memory advantage.
- **Document what syncs** — [#25](https://github.com/CloudCompile/browserformobile/issues/25).
  Downloads and `data.json` both live in the vault; say what that means on two
  devices.

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
  unreliable. The UI keeps saying so even when the API changes shape.

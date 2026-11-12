# Anime for Mobile — user guide

Everything a first-run user needs, in the order they will meet it. The
[README](../README.md) covers the feature overview and the technical detail;
[CONTRIBUTING](../CONTRIBUTING.md) covers the development side.

> **Screenshot placeholders.** This guide is written to be illustrated, and the
> phone-frame blocks below mark where each screenshot goes — they are
> placeholders, not the real interface. Real mobile screenshots will replace
> them one surface at a time; when a screenshot lands, the placeholder block is
> deleted and an annotated image takes its place.

---

## Install

1. Open **Settings → Community plugins** in Obsidian.
2. Turn off **Restricted mode** if it is on.
3. Choose **Browse**, search for **Anime for Mobile**, and select **Install**,
   then **Enable**.
4. The plugin adds two ribbon icons — a compass to find anime, and a download
   arrow for the downloader. Both are also commands in the command palette.

Manual installation (a release ZIP, or a sideload): copy `main.js`,
`manifest.json`, and `styles.css` into
`<Vault>/.obsidian/plugins/browser-for-mobile/`, then reload and enable the
plugin in **Settings → Community plugins**.

> 📱 **Screenshot placeholder** — *first launch: the two ribbon icons and the
> empty library, on a phone.*

## Finding something to watch

Two ways in, both from the ribbon or the command palette:

- **Search** (**Open anime downloader**) — type a title, pick it from the
  results.
- **Browse** (**Anime: find anime**) — page through listing sections (most
  popular, top airing, movies, …) or a genre page without typing a search.
  Whatever you open lands straight in the downloader.

The finder reopens where you left it: same section or genre, same page.

> 📱 **Screenshot placeholder** — *the finder's poster grid, with a section
> picker at the top.*

## Your first download

1. Open a series. The picker lists every episode with a checkbox.
2. Choose episodes individually, or use the chips: **Select all**, a numeric
   range such as `12–24`, or skip filler. On a long series the list is grouped
   into collapsible ranges (Episodes 1–50, 51–100, …), each with its own
   select and clear.
3. Pick **Format** and **Quality** for this series. MP4 is the one that plays
   everywhere; TS writes the raw stream. Your choice is remembered for this
   series only and does not change your defaults.
4. Select **Download**. The queue takes over: downloads continue in the
   background, survive a restart, and resume from the last segment after a
   failure. Queued and paused rows have move buttons, so the next episode to
   fetch is yours to choose.

Files land in your vault under **Download settings → Download folder**
(defaults to `Anime/`), named `Series - 01 - Episode title.mp4`.

> 📱 **Screenshot placeholder** — *the episode picker with a group collapsed,
> and the queue underneath with two episodes running.*

## Watching

Open **Anime: open video library** (ribbon or command palette). Everything the
downloader wrote is listed; anything half-watched also appears in a
**Continue watching** strip at the top, with the position and time left.

- Playback remembers where you stopped, per episode.
- A position within a second of the end resets instead of resuming.
- TS files do not play in the plugin — the player tells you instead of showing
  a black rectangle. Keep **Download format** on MP4 for in-plugin watching.
- Delete a file from its row; with confirmation on, you are asked first.

> 📱 **Screenshot placeholder** — *the library list with the continue-watching
> strip above it, and one row mid-playback.*

## Recommendations

Open **Anime: open recommendations**. It is a poster grid built from your whole
download history, with a "because you downloaded X" line on every entry, and a
details-and-download action on each.

- **Not interested** removes a card; a control at the top brings them all back.
- Ranking is the catalogue's own related votes by default. In settings you can
  hand the ranking to a small decision model that runs entirely on your device,
  or to a hosted one — both only ever re-order what the catalogue already
  suggested; they cannot add titles.

> 📱 **Screenshot placeholder** — *the recommendations grid with one card's
> "because you downloaded" line visible.*

## Statistics

Open **Anime: open download statistics** for the run log: size, speed, and time
across past downloads, with totals and a per-run breakdown. Resumed runs count
only the bytes they actually fetched. Exported data (from the export commands)
includes this log as CSV.

> 📱 **Screenshot placeholder** — *the statistics summary cards and the run
> list.*

## Repairing old downloads

Episodes downloaded by older versions can carry a duration every header-aware
player misreads (Samsung Gallery shows one length, VLC another). The repair
rewrites them in place:

1. Open the download manager (**Open download manager**), then **Repair old
   videos**, or run **Anime: repair downloaded videos** from the command
   palette.
2. The scan reads what it needs, fixes what it flags, and remembers files it
   has already verified — the next pass reads almost nothing.

Repair is idempotent: a second pass repairs nothing.

## Settings worth knowing

- **Resume downloads on launch** — continue queued downloads when Obsidian
  starts. Off by default; a connection the device reports as metered holds the
  resume until you start it yourself.
- **Download folder / external storage** — where files go. Mobile writes stay
  inside the vault.
- **Download subtitles** — saves a stream's subtitle track as a `.vtt` next to
  the video. Off by default.
- **Cache anime details** — remembers catalogue answers on disk, so reopening
  a series does not re-fetch it.

## Getting help

- Bugs: open a GitHub issue with the bug report template. For mobile-only
  problems, use **Export debug log** and attach the exported file.
- Feature ideas: the feature request template.
- The [README](../README.md) documents every setting and the technical
  constraints behind them.

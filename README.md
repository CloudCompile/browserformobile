# Anime for Mobile

Search, download and watch anime from inside Obsidian, on iOS and Android.

Obsidian has no video or catalogue tooling of its own, and on mobile the app
cannot host a full browser engine. This plugin does the parts that work well
natively instead: it searches a catalogue, downloads episodes in the background
with resume, keeps an offline library that plays them back, and shows a full
details page for each series with recommendations drawn from what you have
already downloaded.

It was a web browser in an earlier life. That part is gone — a plugin cannot
embed a real engine on mobile, so the proxy and iframe rendering it relied on
was never going to be reliable. What remains is the downloader and the library,
which do not need one.

**New here?** The [user guide](docs/user-guide.md) walks through installing,
your first download, watching, and the rest, in the order you will meet them.

## Features

- **Search and download** from an anime catalogue, with per-episode selection,
  ranges, skip-filler, and "download missing".
- **Find and browse** the catalogue without a search: pick a listing section
  (most popular, top airing, movies, …) or a genre page and page through the
  titles, then open one in the downloader.
- **Resumable downloads** that continue from the last segment after a failure.
- **An offline video library** that plays your episodes and remembers where you
  stopped.
- **A full details page** for any series: synopsis, genres, studios, cast and
  staff, theme songs, trailer, and airing schedule.
- **A recommendations page** built from your whole download history, as a
  poster grid with a "because you downloaded X" line on every entry, and a
  Details and Download action on each.
- **Recommendations** based on your download history, ranked either by the
  catalogue's own votes or by a decision model — a small one that runs entirely
  on your device, or a hosted one.
- **Download statistics** covering size, speed, and time across past runs.
- **Download manager** that scans your folder and repairs the duration of files
  written by older versions.
- **A responsive, touch-friendly layout** built for narrow screens, with
  safe-area insets for notched phones and larger tap targets on touch devices.

## Find anime



> Walkthrough: [Find anime](docs/user-guide.md#finding-something-to-watch) in the user guide.

Open it from the compass ribbon icon or the **Anime: find anime** command.

Instead of typing a search, browse the catalogue: pick a listing section (most
popular, top airing, top upcoming, recently added, completed, or a format such
as movies) or **Browse by genre**, then page through the poster grid. Selecting
a title opens it straight in the downloader, ready for episode selection. The
finder reopens where you left it — the same section or genre, and page.

The **18+** checkbox in the finder reveals a second tab backed by the adult
source, which has its own sections (monthly releases, all series) and its own
genre list. It uses the same grid and pager, so the browsing is identical; leave
the box off and only the normal catalogue is reachable. A restored finder obeys
the same gate: the adult tab comes back only if the box is still on.

## Anime downloader



> Walkthrough: [Anime downloader](docs/user-guide.md#your-first-download) in the user guide.

Open it from the download ribbon icon or the **Open anime downloader**
command.

Search for a series, pick it, then choose episodes. You can select all, select
none, invert the selection, skip filler, add a numeric range such as 12–24, or
**Download missing** to fill in only the episodes not already saved.
Downloads run in the background and keep going if you close the window.

A very long series groups its episode list into collapsible ranges —
Episodes 1–50, 51–100, and so on — each with its own select and clear beside the
global ones. The catalogue does not label seasons, so the groups are honest
number ranges, not invented seasons; a short series lists exactly as before.

Queued downloads can be reordered: queued and paused rows carry move buttons,
so the next episode to fetch is yours to choose. Running, parked, and finished
rows keep their places — a rate-limited row stays at the bottom until it
retries.

The window opens full screen, so a long queue and a long episode list both have
room. Use the button in the title bar to shrink it back to a popup.

Each episode is fetched from the stream catalogue, its quality variants are read
from the playlist, and the closest one to your preferred quality is downloaded.
While a download runs the queue shows its speed and an estimate of the time left.

### Caching

The anime API answers slowly: it runs without a persistent cache of its own, and
a single search fans out across several sources. The plugin therefore caches API
responses itself, so repeating a search or re-opening a series is instant.

Search results are kept for 10 minutes, episode lists for 12 hours, and series
details for a week — metadata barely changes, so it is held the longest. The
cache is stored in the same local `data.json` as everything else and is never
sent anywhere. Stream URLs are cached in memory only for 10 minutes: a link saved
from a previous session is usually dead by the next one.

Alongside the TTL cache there is a **persistent series metadata store**:
whenever a details page is fetched, the answer is kept until evicted by age or
size (200 series or 2 MB, oldest first). Details pages open from that copy
instantly and refresh in the background, the library's grid **and list** show
posters for anything browsed before, and the catalogue's own recommendation list
survives an unreachable API. It holds catalogue text and poster URLs — nothing
from your vault.

Turn caching off with **Cache anime details** in settings, or clear it at any
time with the **Clear anime cache** command — useful if a title's details were
corrected upstream, or if a cached stream URL has gone stale.

### Quality

Streams are **720p only** in practice. Every series and server probed returned a
single 1280×720 variant, so the quality setting picks the closest match rather
than promising a resolution the source does not have. Requesting 1080p or 480p
still downloads the 720p stream.

### Output format

- **MP4** produces one playable file. The stream is converted as it arrives, a
  batch at a time, so memory stays bounded even for a feature-length file. This
  is the format to pick for watching: the library plays it, phones list it, and
  the repair tool understands it.
- **TS** writes the raw stream straight to disk, a segment at a time. It is an
  archive copy — useful as source material to remux later, but a browser cannot
  play it, so the library refuses it with a message instead of a black rectangle.

Both formats keep memory low; pick **TS** only when you specifically want the
untouched stream, and **MP4** for everything else.

### Per-series choices

The quality and format dropdowns in the episode picker set the choice for the
series you are picking, not for the plugin: grab one long series as TS, or one
series at 480p, without touching your defaults. The choice is remembered per
series and rides with its queue entries — episodes queued earlier keep the
choice they were queued with, so a later change never rewrites what is already
waiting. **Download missing** also looks for files under the series' own format
choice.

### Subtitles

When the source stream carries a subtitle track, the downloader can save it as a
**WebVTT** sidecar next to the video — the same filename with the extension
changed. The player picks the sidecar up automatically and shows the subtitles.
The sidecar is off by default (**Download subtitles** in settings) because it
adds a second set of requests per episode. A stream with no subtitle track
downloads exactly as before, with no extra requests.

The player's bar has the subtitle controls when a sidecar exists: **on or off**
(remembered), text size (**S / M / L**), and a **±0.5 s delay** stepper for
tracks that run a beat ahead or behind — up to five seconds either way. The
choices persist and apply to every episode's sidecar.

When an episode finishes, the player can start the next one of the same series:
**Auto-play the next episode** in settings, off by default. The **Next** button
does the same thing by hand, and both stop honestly at the last episode.

### Where files are saved

A plugin can only write **inside the vault**. On mobile, Obsidian's app exposes
no absolute path, so the download folder is always vault-relative.

The vault itself can live on an SD card, and that is the supported way to keep a
large library off internal storage: point Obsidian's vault at the card, and
downloads are written there. No extra permission is needed, because the writes
go through Obsidian's own storage layer rather than a direct filesystem path.

What is not possible is writing to an arbitrary SD-card path **outside** the
vault: Android 11 and later blocks that unless the app holds
`MANAGE_EXTERNAL_STORAGE`, which Obsidian does not request.

On desktop you can turn on **Save outside the vault** and give an absolute path,
such as a mounted card. That option is hidden where it cannot work.

Because downloads land in the vault, they sync with it if you sync your vault.
That is worth remembering for a large library.

### Download settings

- **Cache anime details** — store API responses locally so repeat lookups are
  instant. On by default.
- **Anime API endpoint** — the catalogue used for search and streams.
- **Download quality** — preferred height; the closest available is used.
- **Download format** — MP4 or TS, as above.
- **Download folder** — where files go, relative to the vault.
- **Save outside the vault** — desktop only; write to an absolute path.
- **Filename template** — `{series}`, `{ep}`, `{ep:02}`, `{title}`, `{ext}`.
- **Download subtitles** — save the stream's subtitle track as a WebVTT sidecar
  next to the video. Off by default.
- **Prefer dub** — try dubbed servers first when the default one offers no
  downloadable file. Dub availability follows the catalogue: many series are
  subbed only, and for those this changes nothing.
- **Parallel segments** — segments fetched at once per episode. The default is
  6, which measured around 30 MB/s against the CDN. If the server starts
  refusing requests the download drops this on its own and creeps back up, so
  raising it is safe.
- **Parallel episodes** — episodes downloaded at once. The default is 1, which
  is the kindest setting on a phone; raise it on desktop.
- **Resume downloads on launch** — continue queued and paused downloads when
  Obsidian starts, instead of waiting for the queue to be opened. Off by
  default. Devices that report a metered connection (Android's data saver, or a
  cellular connection type) hold the resume until you start it yourself; iOS
  exposes no connection signal, so there it resumes regardless — keep the
  setting off if that is not wanted.

### Resuming a download

A download that fails partway — a dropped connection, a segment the CDN will not
serve — does not lose the work already done. The stream is written to a staging
file next to the final one, and its progress is recorded in a small sidecar
file, so a resumed download continues from the next missing segment instead of
starting over.

A failed episode in the queue shows how much is saved and offers **Resume** and
**Discard**. **Resume all** continues every failed episode at once. Re-enqueueing
a failed episode from the episode picker resumes it too.

The resume is only used when the stream is unchanged: the episode, format,
quality, and the playlist's segment count and length all have to match what was
recorded. If the source has changed, the partial file is discarded and the
episode is downloaded again from the start, rather than splicing two different
streams together. The same guard drops a staging file that does not match the
size its sidecar claims, which is what a crash mid-write leaves behind.

Cancelling a download is different from failing: it removes the staging file, so
a cancel does not leave work behind for a resume you did not ask for.

While a resume is in progress the queue shows **Resuming** before the segment
count. TS output resumes by appending to the staging file and then renaming it
into place. MP4 output appends the converted stream to the staging file, so it
resumes the same way without re-reading what is already written.

### Rate limiting

The stream CDN throttles bursts of requests. Concurrency is a target rather than
a fixed number of slots: when the CDN answers **429** the download lowers it by
one and waits out a short cooldown, then works back up, so raising **Parallel
segments** stays safe even if the limit returns. When a whole run is throttled
rather than one segment, the episode is not failed: it is parked at the bottom of
the queue and retried a minute later, keeping everything already on disk. Other
episodes get their turn while it waits, and the row shows **Rate limited** with a
countdown. After twelve tries in a row it gives up and fails normally, so it
cannot retry forever.

### Series finishers

**Download missing** selects only the episodes that are not already saved and not
already queued. When a run was interrupted and a few episodes are missing, open
the series, press **Download missing**, and it fills exactly those gaps without
re-fetching the rest.

### Repairing old downloads



> Walkthrough: [Repairing old downloads](docs/user-guide.md#repairing-old-downloads) in the user guide.

Files downloaded before 1.1.1 report the wrong length in players that read the
track headers — Samsung Gallery shows every file as **1:35:15**. mux.js left the
duration at its "unknown" placeholder, which those players clamp to that value.

The real length is still recorded elsewhere in the file, so the files can be
repaired in place, without downloading them again. Use **Repair old videos** in
the download window, or the **Repair downloaded videos** command. Both scan the
download folder and rewrite only the files that need it.

### Download statistics



> Walkthrough: [Download statistics](docs/user-guide.md#statistics) in the user guide.

The download window shows the live network speed for the whole queue, and the
per-episode rows show each run's speed and time remaining. Once a few episodes
have finished, open the statistics page from the **Open download statistics**
command or the chart ribbon icon for the record of past runs:

- **Downloaded** — total size of everything that finished, and how many episodes.
- **Time downloading** — the wall-clock time spent across those runs.
- **Average speed** — bytes transferred divided by time, across every run. A
  resumed run only counts the bytes it actually fetched, so resuming a download
  does not inflate the figure.
- **Best speed** — the fastest run's average rate, with the fastest instantaneous
  reading shown underneath when it is higher.

Below the totals are a bar per recent run, a per-series breakdown, and the
individual runs newest first, each flagged as done, failed, or cancelled. Failed
and cancelled runs are counted but excluded from the size and speed totals, so a
broken run cannot drag the average down.

The log keeps the 500 most recent runs and is stored alongside your settings.
**Clear statistics** deletes the log; your downloaded files are untouched.

### Legal

The downloader is pointed at a third-party catalogue of copyrighted material.
Downloading from it may be illegal where you live, and using it is your
responsibility. The plugin does not host, index, or vouch for any content.

## Video library



> Walkthrough: [Video library](docs/user-guide.md#watching) in the user guide.

The library lists the episodes you have downloaded and plays them inside
Obsidian. Open it from the film ribbon icon or the **Open video library**
command.

The list is built by scanning your download folder each time you open it, so a
file you add or remove by hand shows up without any re-import. Series, episode
number, and title are read back out of the filename using the same template the
downloader writes with, so a renamed template will not hide older files — a name
that does not match is kept whole as the title.

- **Play** starts a video, resuming from where you stopped last time.
- **Start over** clears the saved position and plays from the beginning.
- **Search** filters across series, episode number, and title.
- **Filters** narrow the list to everything, unwatched, or in progress.
- **Delete** removes the file from your vault after a confirmation.
- **Continue watching** — when episodes are half-watched, a strip above the list
  shows each one with its position and what is left, most recently played first.
  Tapping a card resumes it.
- **Grid view** — the toggle beside the filters switches the list to a poster
  grid. Posters come from catalogue answers already cached on your device, so a
  series you have never browsed shows a fallback card with its first letter
  instead. The choice is remembered.

Progress is saved every few seconds and when you close the player, and it is
stored with your other plugin data. The library marks a file **Watched** once
you reach the end.

### Formats and playback

MP4 files play directly. MPEG-TS files (the low-memory **TS** output) cannot be
played by a browser engine, so the library says so instead of showing a black
rectangle. If you want to watch in the library, keep the download format set to
**MP4**.

When an episode has a subtitle sidecar — see **Download subtitles** in the
downloader — the player loads it automatically. Deleting an episode deletes its
sidecar with it.

Only videos inside your vault are listed. Downloads saved outside the vault
(desktop only) are written where the plugin cannot enumerate them, so they do
not appear here.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` into
`<Vault>/.obsidian/plugins/browser-for-mobile/`, then enable **Anime for
Mobile** in **Settings → Community plugins**.

The plugin keeps its original folder and id, so an upgrade from the browser
version installs over the top of it.

## Use

Open the downloader from the download ribbon icon or the **Open anime
downloader** command. Search for a series, pick it, choose episodes, and start
the download; it keeps running if you close the window.

Open a series' details page from the info button on any library row, or with the
**Anime: open details page** command.

Open the recommendations page from the sparkles ribbon icon or the **Anime: open
recommendations** command. The **Download** button on a card opens the downloader
with that title already searched for.

## Details and recommendations

The details page gathers everything the API knows about a series in one place:
score, rank, popularity, status, season, studio, source material, synopsis,
genres and themes, opening and ending themes, cast and staff, a link to the
trailer, and the broadcast schedule.

Below the details are **recommendations**. These are seeded from the series you
are viewing plus everything else you have downloaded, so a series you have
watched a lot pulls the list harder than one you tried once.

### The recommendations page

The details page recommends more like the series you are looking at. The
recommendations page answers the other question — what to watch next — so no
series is privileged: the seeds are your download history itself.

Every series in your history is used as a seed — the more you have downloaded,
the wider the list. It shows a poster grid, one card per title, with the reason
it is there ("Because you downloaded Naruto and One Piece").

Mining the seeds takes a moment because each one is a separate lookup, so the
page appears immediately, shows which seed it is working on, and fills the grid
in as results arrive rather than staying blank until the last one is read. If a
seed cannot be read, the list still appears and says it may be missing titles
rather than quietly looking complete. **Refresh** rebuilds it.

The list is spread across your history rather than dominated by one series. A
series you watched all the way through still counts for more than one you tried
once, but only somewhat more, and no single series can fill the page. An episode
you are part-way through counts in proportion to how far you got, so five
minutes of a two-hour film is not the same signal as an hour.

### Not interested

A card's **Not interested** action removes it and keeps it out of future lists —
including the details page's "more like this" — until you bring the titles back
with **Restore dismissed** at the top of the page. Dismissals are remembered
with your other plugin data and capped at the most recent 200.

### Letting a language model choose

**Curate with a language model** in settings hands the candidate list to a small
instruction model, which re-orders and prunes it. Off by default; nothing is sent
anywhere unless you turn it on.

- **Model server on my machine** runs the model yourself, through Ollama, LM
  Studio or llama.cpp's server. Everything stays on your network, and it works on
  mobile as long as the server is reachable. Liquid AI's LFM2.5 builds are a good
  fit — 230M is 149 MB and quick, 1.2B is noticeably better at judgement.
- **Hosted API** needs no local setup, but your viewing history and the candidate
  titles are sent to that provider.
- **In this plugin** runs the model inside Obsidian, through WebAssembly. Nothing
  leaves your device and there is no server to run — the trade is size and speed.
  The runtime is about 9 MB, downloaded once and cached, and the model is a
  separate one-time download (149 MB for the smallest). It is the only mode that
  works offline.

The two tools below are for the server and API modes. The in-process mode looks
catalogue facts up in advance instead, because a model small enough to run in
Obsidian is not reliable at deciding when to call a tool.

The model gets two tools. One looks series up on your own anime API, so it can
read a synopsis and genre list before deciding rather than guessing from a title.
The other is web search, off by default because it is the one part that sends a
query to a third party of your choosing.

The model can re-order and remove, but never add: any title it returns that was
not in the list is discarded, so a made-up series cannot reach the page. If the
model is off, unreachable, or answers with something unusable, you get the
catalogue ranking unchanged.

Three ranking modes, chosen with **Recommendation model** in settings:

- **Catalogue only** (default) uses the upstream site's own related-series votes
  plus a text match against your history. No download, no key, no network beyond
  the catalogue itself.
- **Local decision model** downloads a small model once (about 6 MB) and runs it
  entirely on your device, so nothing about your viewing leaves it.
- **Hosted decision model** sends your download history and the candidate titles
  to TypeSafe (typesafe.ai) and needs a **Jev API key**. Only the taste profile
  and titles are sent — no file contents, no paths.

Any model failure falls back to the catalogue ordering rather than showing an
error, so recommendations always appear.

## Settings

- **Anime API endpoint** — the catalogue used for search, details, and streams.
- **Cache anime details** — store API responses locally so repeat lookups are
  instant. On by default.
- **Download quality** — preferred height; the closest available is used.
- **Download format** — MP4 or TS, as described below.
- **Download folder** — where files go, relative to the vault.
- **Save outside the vault** — desktop only; write to an absolute path.
- **Filename template** — `{series}`, `{ep}`, `{ep:02}`, `{title}`, `{ext}`.
- **Parallel segments** — segments fetched at once per episode.
- **Parallel episodes** — episodes downloaded at once.
- **Recommendation model** — catalogue only, local, or hosted, as above.
- **Jev API key** — only used by the hosted model.
- **Glass effect** — a translucent surface on the plugin's panels. Desktop only.
- **Confirm destructive actions** — confirm before deleting a file or clearing
  the download log.

## Privacy

Everything is stored locally in the plugin's `data.json` inside your vault.
Nothing is collected or sent anywhere by the plugin itself. The download
statistics log — series names, episode labels, sizes, and speeds — is kept in the
same file and never leaves your device; **Clear statistics** deletes it.

Cached anime API responses are stored there too: search results, series details,
and episode lists, with the stream URLs you have used kept in memory only. This
data never leaves your device. The persistent series metadata store keeps the
same kind of data — details text and poster URLs for series you have browsed —
in the same file, so details pages, posters, and the catalogue's own
recommendations still render offline. **Clear anime cache** deletes it, and
turning off **Cache anime details** stops it being written at all.

The recommendation models are the only feature that can send anything off your
device, and only when you switch one on:

- **Local** runs on your device. Nothing is sent.
- **Hosted** sends your download history and the candidate titles to TypeSafe.
  It stays off until you choose it and supply a key.

## Commands

All actions are available from the command palette: open the anime downloader,
open the video library, open the download manager, open download statistics,
open the recommendations page, open a series' details page, repair downloaded
videos, clear the anime cache, and export or import your watch progress and
statistics.

## Backing up data

**Export watch progress and statistics** writes two files into the download
folder: `anime-data-export.json` (every resume position and the whole download
run log) and `anime-statistics.csv` (the same log, readable by a spreadsheet).
**Import watch progress and statistics** reads the JSON back and, after a
confirmation, *replaces* the current progress and run log with it — a snapshot
from another device overwrites rather than merges. Both commands need downloads
saved inside the vault, and the files live in your vault like any other note, so
syncing the vault syncs the backup.

### What syncs

Everything the plugin keeps lives in two places inside the vault, so a vault
sync (Obsidian Sync, iCloud, Syncthing, a git repo) carries all of it:

- **The download folder** — the videos, subtitle sidecars, and the two export
  files above. These are ordinary files; every sync service moves them as they
  are.
- **`.obsidian/plugins/browser-for-mobile/data.json`** — your settings, watch
  progress, download-run statistics, the per-series quality and format choices,
  and the cached catalogue details. Some sync services skip `.obsidian` by
  default; include it or settings and progress will not follow you.

Two caveats for multi-device vaults:

- **data.json is written whole.** Two devices saving at the same moment is a
  last-writer-wins race on the file. Watch progress is merged per file on every
  save — the further position wins, so a phone's viewing is not dropped when a
  laptop's sync lands afterwards — but anything else that changed on both
  devices at once (a setting, an in-flight queue) keeps only one side.
- **Downloads in flight do not sync.** A partial `.part` staging file is
  device-local state; if a sync moves one, the receiving device discards it and
  the episode restarts from zero.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # production build
npm run lint     # must be clean (0 errors, 0 warnings)
npm test         # vitest, the committed gate
```

The constraints the code follows — memory bounds, ordered writes, what may
leave the device — are in [CONTRIBUTING.md](CONTRIBUTING.md). The direction of
travel is [ROADMAP.md](ROADMAP.md), whose items are the issue tracker's
milestones. Every release is summarised in [CHANGELOG.md](CHANGELOG.md); the
full notes live on each release. Security-relevant details are in
[SECURITY.md](SECURITY.md).

## On mobile

- **The screen stays awake while a download runs**, so a long episode is not
  frozen when the phone sleeps. This uses the Screen Wake Lock API, which is
  available in Android's WebView.
- **On iOS there is no wake-lock support** — the platform exposes no way to
  keep the screen on programmatically. Instead the plugin pauses the queue when
  the app is hidden and resumes it on return, so a screen-off download leaves a
  clean partial with no lost bytes instead of a stalled connection, and the
  first download of a session shows a one-time hint to keep the app open while
  a run is going. Keep the screen on manually for the longest episodes.
- **Batch size follows the device's memory.** Downloads are written in batches
  (16-64 MB) sized from `navigator.deviceMemory`, so a low-memory phone is not
  pushed into an out-of-memory restart by a batch meant for a 4 GB device.
- **MP4 and TS both stream.** MP4 is converted as it downloads rather than held
  whole in memory, so either format is safe on a phone; MP4 is the one that
  plays anywhere.

## Limitations

- Playback uses the platform's own video element, so a format it cannot decode
  (MPEG-TS) will not play inside the plugin. Keep **Download format** on MP4 if
  you want to watch in the library.
- The catalogue is a third-party source. If it changes shape or goes away, search
  and downloads stop working until the API is updated.
- Recommendations are only as good as the history they are given. With an empty
  history the list falls back to the catalogue's own related-series votes.

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

## Features

- **Search and download** from an anime catalogue, with per-episode selection,
  ranges, skip-filler, and "download missing".
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

## Anime downloader

Open it from the download ribbon icon or the **Open anime downloader**
command.

Search for a series, pick it, then choose episodes. You can select all, select
none, invert the selection, skip filler, add a numeric range such as 12–24, or
**Download missing** to fill in only the episodes not already saved.
Downloads run in the background and keep going if you close the window.

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
  batch at a time, so memory stays bounded even for a feature-length file.
- **TS** writes the raw stream straight to disk, a segment at a time. The result
  plays in most players but is not an MP4.

Both formats keep memory low; **MP4** is the one to pick for a single playable
file.

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
- **Parallel segments** — segments fetched at once per episode. The default is
  6, which measured around 30 MB/s against the CDN. If the server starts
  refusing requests the download drops this on its own and creeps back up, so
  raising it is safe.
- **Parallel episodes** — episodes downloaded at once. The default is 1, which
  is the kindest setting on a phone; raise it on desktop.

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
countdown. After ten tries in a row it gives up and fails normally, so it cannot
retry forever.

### Series finishers

**Download missing** selects only the episodes that are not already saved and not
already queued. When a run was interrupted and a few episodes are missing, open
the series, press **Download missing**, and it fills exactly those gaps without
re-fetching the rest.

### Repairing old downloads

Files downloaded before 1.1.1 report the wrong length in players that read the
track headers — Samsung Gallery shows every file as **1:35:15**. mux.js left the
duration at its "unknown" placeholder, which those players clamp to that value.

The real length is still recorded elsewhere in the file, so the files can be
repaired in place, without downloading them again. Use **Repair old videos** in
the download window, or the **Repair downloaded videos** command. Both scan the
download folder and rewrite only the files that need it.

### Download statistics

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

Progress is saved every few seconds and when you close the player, and it is
stored with your other plugin data. The library marks a file **Watched** once
you reach the end.

### Formats and playback

MP4 files play directly. MPEG-TS files (the low-memory **TS** output) cannot be
played by a browser engine, so the library says so instead of showing a black
rectangle. If you want to watch in the library, keep the download format set to
**MP4**.

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
once, but only somewhat more, and no single series can fill the page.

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
data never leaves your device. **Clear anime cache** deletes it, and turning off
**Cache anime details** stops it being written at all.

The recommendation models are the only feature that can send anything off your
device, and only when you switch one on:

- **Local** runs on your device. Nothing is sent.
- **Hosted** sends your download history and the candidate titles to TypeSafe.
  It stays off until you choose it and supply a key.

## Commands

All actions are available from the command palette: open the anime downloader,
open the video library, open the download manager, open download statistics,
open the recommendations page, open a series' details page, repair downloaded
videos, and clear the anime cache.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # production build
npm run lint
```

## On mobile

- **The screen stays awake while a download runs**, so a long episode is not
  frozen when the phone sleeps. This uses the Screen Wake Lock API, which is
  available in Android's WebView; on iOS it is a no-op and a download can stall
  if the screen turns off.
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

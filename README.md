# Browser for Mobile

A tabbed web browser that runs inside Obsidian, including on iOS and Android.

Obsidian's desktop app ships a web viewer, but the mobile app does not. This
plugin fills that gap with a browser pane you can open from the ribbon or the
command palette. It supports tabs, back and forward history, bookmarks, a
persistent cookie jar, and two rendering modes so it can cope with sites that
refuse to be embedded.

## What works, and what does not

This is important to understand before you install it.

Obsidian mobile is not built on Electron, so there is no embedded Chromium you
can drive the way the desktop app can. A plugin can only load a page in two
ways:

- **Direct mode** loads the site in an iframe. The platform handles cookies and
  sessions normally, so logins work. It only works for sites that allow being
  embedded. Sites that send `X-Frame-Options` or a strict
  `Content-Security-Policy` will show an error instead. The plugin checks those
  headers before loading and switches to proxy mode automatically when a site
  refuses to be embedded, so you do not have to retry by hand.
- **Proxy mode** fetches the page with the app's own HTTP client, falling back to
  a CORS proxy when needed, sanitises the HTML, and renders it in a locked-down
  frame. This works for most sites, including ones that block framing, but it is
  a snapshot: it is not suitable for sites that require a real login. Pages run
  their own scripts so client-rendered sites work; turn off **Run page scripts**
  to block them instead.

The HTTP client Obsidian exposes to plugins is a native one, so it is not bound
by the browser's same-origin rules. Most pages therefore load with no third
party involved at all. The proxy is a fallback for the minority of sites that
refuse the direct request, and it can be turned off entirely in settings. Public
proxies are unreliable, so when the configured proxy keeps failing the plugin
tries a small set of built-in fallbacks before giving up.

There is no way to build a full Chromium browser inside an Obsidian plugin on
mobile. If a site needs a real engine, use **Open in system browser**.

## Features

- Tabs with titles, close buttons, and a scrolling tab strip that fits a phone.
- Address bar that accepts URLs or search terms.
- Back, forward, reload, home, and open-in-system-browser.
- Per-tab history, plus a searchable global history.
- Bookmarks with a fuzzy search picker.
- A cookie jar that proxied pages can read and write, with a manager to inspect,
  export, and clear cookies per site.
- Responsive, touch-friendly layout built for narrow screens.
- An anime downloader: search a catalogue, pick episodes, and save them to disk.

## Anime downloader

The downloader is a separate tool from the browser. Open it from the download
ribbon icon or the **Open anime downloader** command.

Search for a series, pick it, then choose episodes. You can select all, select
none, invert the selection, skip filler, add a numeric range such as 12–24, or
**Download missing** to fill in only the episodes not already saved.
Downloads run in the background and keep going if you close the window.

The window opens full screen, so a long queue and a long episode list both have
room. Use the button in the title bar to shrink it back to a popup.

Each episode is fetched from the stream catalogue, its quality variants are read
from the playlist, and the closest one to your preferred quality is downloaded.
While a download runs the queue shows its speed and an estimate of the time left.

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

- **Anime API endpoint** — the catalogue used for search and streams.
- **Download quality** — preferred height; the closest available is used.
- **Download format** — MP4 or TS, as above.
- **Download folder** — where files go, relative to the vault.
- **Save outside the vault** — desktop only; write to an absolute path.
- **Filename template** — `{series}`, `{ep}`, `{ep:02}`, `{title}`, `{ext}`.
- **Parallel segments** — segments fetched at once per episode. The stream CDN
  starts refusing requests above four, so the default is 3.
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

The stream CDN throttles bursts of requests. When a whole run is throttled rather
than one segment, the episode is not failed: it is parked at the bottom of the
queue and retried a minute later, keeping everything already on disk. Other
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

### Legal

The downloader is pointed at a third-party catalogue of copyrighted material.
Downloading from it may be illegal where you live, and using it is your
responsibility. The plugin does not host, index, or vouch for any content.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` into
`<Vault>/.obsidian/plugins/browser-for-mobile/`, then enable **Browser for
Mobile** in **Settings → Community plugins**.

## Use

Open the browser from the ribbon globe icon or the **Open browser** command.
Type an address or a search phrase and press enter.

If a page cannot be embedded, the plugin switches to the proxy automatically.
If it still will not load, choose **Retry with proxy**, or open it in your
system browser.

## Settings

- **Home page** — loaded for new tabs.
- **Search template** — use `%s` where the search terms go.
- **Fetch pages directly** — use the built-in HTTP client before the proxy.
- **Proxy endpoint** — the fallback CORS proxy. The default is allorigins.win, with built-in fallbacks.
- **Always use proxy** — route everything through the proxy.
- **Run page scripts** — let proxied pages run their own scripts. On by default; without it, sites that render in the browser (search engines, apps) come up blank or broken.
- **Enable cookie jar** — store cookies locally and share them with proxied pages.
- **Confirm destructive actions** — confirm before clearing data.
- **Open external links in system browser** — hand off links that cannot be shown.

## Privacy

Everything is stored locally in the plugin's `data.json` inside your vault.
Nothing is collected or sent anywhere by the plugin itself.

When proxy mode is used, the address you are visiting is sent to the configured
proxy service so it can fetch the page for you. The default is `allorigins.win`,
a public service. Because public proxies are unreliable, when the default keeps
failing the plugin also tries these fallbacks, in order:

1. `cors-proxy.christopher-j-hauser2025.workers.dev` (a Cloudflare Worker, GET and POST)
2. `r.jina.ai` (GET)
3. `api.cors.lol` (GET)
4. `allorigins.win/raw` (GET)

Only the page HTML is requested; the response is sanitised before display. Set
your own **Proxy endpoint** to use a single, trusted service instead: when the
endpoint is not the shipped default, no fallbacks are used and your address is
never sent to any of the services above.

Cookies saved by the plugin are only sent to the site they belong to. Proxied
pages run in a sandboxed frame without same-origin access, so they cannot read
your vault or the plugin's storage. By default they also run their own scripts,
which is what makes client-rendered sites work but also lets third-party
analytics on those pages run; turn off **Run page scripts** to block them.

## Commands

All actions are available from the command palette: open browser, new tab, close
tab, next and previous tab, back, forward, reload, focus address bar, toggle
proxy rendering, bookmark page, open bookmarks, open history, manage cookies, go
home, clear browsing data, open the anime downloader, and repair downloaded
videos.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # production build
npm run lint
```

## Limitations

- Some sites still cannot be shown, either because they block embedding or
  because they need a full browser engine. Use the system browser for those.
- Proxy mode shows a copy of a page fetched for you, not a live session. It is
  best-effort: sites that rely on cross-origin requests or complex scripting may
  still render imperfectly.
- Cross-origin frames cannot be inspected, so the plugin relies on the injected
  bridge for titles and navigation rather than reading the frame directly.
- A page script that fails is reported in the status bar (**page error**) but
  does not replace the page, since the document has already rendered. The bridge
  presents the proxied frame as top-level so framebusting checks that read
  `window.parent.document` do not abort a page's own startup.


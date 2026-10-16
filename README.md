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
home, and clear browsing data.

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


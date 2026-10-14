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
  `Content-Security-Policy` will show an error instead.
- **Proxy mode** fetches the page with the app's own HTTP client, falling back to
  a CORS proxy when needed, sanitises the HTML, and renders it in a locked-down
  frame. This works for most sites, including ones that block framing, but it is
  a snapshot: it is not suitable for sites that require a real login, and remote
  scripts are stripped for safety.

The HTTP client Obsidian exposes to plugins is a native one, so it is not bound
by the browser's same-origin rules. Most pages therefore load with no third
party involved at all. The proxy is a fallback for the minority of sites that
refuse the direct request, and it can be turned off entirely in settings.

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

If a page shows "Site blocked embedding", choose **Retry with proxy** to load it
through the proxy, or open it in your system browser.

## Settings

- **Home page** — loaded for new tabs.
- **Search template** — use `%s` where the search terms go.
- **Fetch pages directly** — use the built-in HTTP client before the proxy.
- **Proxy endpoint** — the fallback CORS proxy. The default is allorigins.win.
- **Always use proxy** — route everything through the proxy.
- **Enable cookie jar** — store cookies locally and share them with proxied pages.
- **Confirm destructive actions** — confirm before clearing data.
- **Open external links in system browser** — hand off links that cannot be shown.

## Privacy

Everything is stored locally in the plugin's `data.json` inside your vault.
Nothing is collected or sent anywhere by the plugin itself.

When proxy mode is used, the address you are visiting is sent to the configured
proxy service so it can fetch the page for you. The default proxy is
`allorigins.win`, a public service. If you would rather not use a third party,
turn off **Fetch pages directly** only if you have set your own proxy, or leave
the default so most pages never touch a third party.

Cookies saved by the plugin are only sent to the site they belong to. Remote
scripts are stripped from proxied pages so third-party tracking code cannot run.

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
- Proxy mode shows a sanitised, script-limited copy of a page, not a live session.
- Cross-origin frames cannot be inspected, so the plugin relies on the injected
  bridge for titles and navigation rather than reading the frame directly.


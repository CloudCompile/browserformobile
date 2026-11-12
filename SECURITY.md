# Security Policy

## Supported versions

Only the latest release is supported with fixes.

## Reporting a vulnerability

Please use GitHub's private security advisories for this repository rather than
a public issue: **Security → Report a vulnerability**. Include the plugin
version, platform (iOS / Android / desktop), Obsidian version, and anything you
observed. A fix will be released as a patch and noted in the changelog.

## What this plugin does with your data

- Everything it stores lives in the plugin's `data.json` inside your vault:
  settings, watch progress, the download run log (500 most recent runs), cached
  anime API responses, and the repair ledger. Nothing is collected, and nothing
  is sent anywhere by the plugin itself.
- Downloaded videos are written into the vault, and inherit whatever syncing
  your vault has.
- The only network traffic is to the configured anime API (default
  `animeapi.cjhauser.me`) and the stream CDN it points at, plus — only if you
  switch a recommendation model on — the taste profile and candidate titles,
  either to a server you run yourself or to the hosted provider. File contents,
  vault contents, and paths are never sent.
- The debug log contains non-secret runtime details (platform, memory, network
  quality, view state) and download progress lines. It is written to the plugin
  folder and only leaves your device if you export it yourself.
- The plugin does not fetch or execute remote code. The in-process
  recommendation runtime (WebAssembly) and model files are hash-checked against
  pinned values before use.

## Scope notes

- The downloader points at a third-party catalogue of copyrighted material;
  that is a legal question for your jurisdiction, not a vulnerability in the
  plugin.
- The in-process model runtime is fetched once and verified; if the pinned
  hashes ever fail in your copy, do not work around them — report it.

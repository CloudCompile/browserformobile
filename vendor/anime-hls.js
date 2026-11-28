/**
 * GENERATED from packages/hls/src/index.js — do not edit.
 *
 * The standalone plugin mirror has no packages/ directory, so this copy is what
 * it builds against. `npm run vendor` (scripts/vendor-shared.mjs) rewrites it
 * from the monorepo's copy, and `npm test` fails if the two have drifted;
 * scripts/check-shared.mjs proves the generated branch leaves no @anime import
 * in main.js.
 */
/**
 * HLS playlist handling with no I/O.
 *
 * Three apps need this and each had its own copy:
 *
 * - `apps/api/src/catalogue/manifest.js` walks master → variant → media to build
 *   a download plan.
 * - `apps/api/src/catalogue/download.js` attaches the per-CDN `Referer` that a
 *   segment CDN demands.
 * - `apps/reader/app/api/anime/hls/` relays a playlist and rewrites every child
 *   URI so the player only ever talks to its own origin.
 *
 * Nothing here touches the network, so it is testable offline and safe to call
 * from a Worker, a plugin, or a plain Node process.
 *
 * Two traps this file exists to keep people out of:
 *
 * 1. When a `#EXT-X-STREAM-INF` line is read, the cursor must move past the
 *    variant URI line. Otherwise those URIs are also collected as segments and a
 *    download silently fetches playlist text as video.
 * 2. `link.type` is not trustworthy for deciding playlist-vs-file: some mirrors
 *    serve files from extensionless paths. Treat a URL as a file first and
 *    confirm with a HEAD content type (`mpegurl` means it is a playlist).
 */

/** Content types that mean "this body is a playlist". */
const PLAYLIST_CONTENT_TYPES = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "application/mpegurl",
];

/** Parse `KEY=VALUE,KEY="quoted,value"` attribute lists. */
function parseAttributes(input) {
  const out = {};
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function heightOf(resolution) {
  if (typeof resolution !== "string") return null;
  const [width, height] = resolution.split("x");
  const parsed = Number(height ?? width);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `"master"`, `"media"` or `"unknown"`. */
export function classifyPlaylist(text) {
  const body = String(text ?? "");
  if (/^#EXT-X-STREAM-INF:/m.test(body)) return "master";
  if (/^#EXTINF:/m.test(body) || /^#EXT-X-TARGETDURATION:/m.test(body)) return "media";
  return "unknown";
}

export function isPlaylistContentType(contentType) {
  const value = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  return PLAYLIST_CONTENT_TYPES.includes(value);
}

/**
 * Parse a master playlist into variants and alternate renditions.
 *
 * The loop advances the cursor past each variant URI line, which is the trap
 * noted at the top of this file.
 */
export function parseMasterPlaylist(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const variants = [];
  const renditions = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      if (attributes.URI) {
        renditions.push({
          type: attributes.TYPE ?? null,
          groupId: attributes["GROUP-ID"] ?? null,
          name: attributes.NAME ?? null,
          language: attributes.LANGUAGE ?? null,
          uri: attributes.URI,
        });
      }
      continue;
    }

    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    const attributes = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
    const uri = (lines[i + 1] ?? "").trim();
    // Consume the URI line whether or not it is usable, so a comment between
    // the tag and its URI cannot turn the next segment into a variant.
    i += 1;
    if (!uri || uri.startsWith("#")) continue;

    variants.push({
      uri,
      bandwidth: toNumber(attributes.BANDWIDTH),
      averageBandwidth: toNumber(attributes["AVERAGE-BANDWIDTH"]),
      resolution: attributes.RESOLUTION ?? null,
      height: heightOf(attributes.RESOLUTION),
      codecs: attributes.CODECS ?? null,
      audioGroup: attributes.AUDIO ?? null,
    });
  }

  return { variants, renditions };
}

/** Parse a media playlist into segments, keys and playlist metadata. */
export function parseMediaPlaylist(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const segments = [];
  const keys = [];
  let duration = null;
  let mediaSequence = 0;
  let targetDuration = null;
  let endList = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = toNumber(line.slice("#EXT-X-MEDIA-SEQUENCE:".length)) ?? 0;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = toNumber(line.slice("#EXT-X-TARGETDURATION:".length));
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-KEY:".length));
      keys.push({
        method: attributes.METHOD ?? null,
        uri: attributes.URI ?? null,
        keyFormat: attributes.KEYFORMAT ?? null,
        iv: attributes.IV ?? null,
      });
      continue;
    }
    if (line === "#EXT-X-ENDLIST") {
      endList = true;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      duration = toNumber(line.slice("#EXTINF:".length).split(",")[0]);
      continue;
    }
    if (line.startsWith("#")) continue;

    segments.push({ index: segments.length, uri: line, duration, sequence: mediaSequence + segments.length });
    duration = null;
  }

  return { segments, keys, mediaSequence, targetDuration, endList };
}

/** Resolve a playlist-relative URI against the playlist's own URL. */
export function resolveUri(baseUrl, uri) {
  const value = String(uri ?? "").trim();
  if (!value) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

/**
 * Pick one variant.
 *
 * `maxHeight` is a ceiling, not an exact match: the closest variant at or below
 * it wins, and when every variant is above the ceiling the shortest one is
 * chosen rather than the tallest (a phone should degrade, not stall).
 */
export function selectVariant(variants, { maxHeight = null } = {}) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const sized = variants.filter((variant) => Number.isFinite(variant?.height));

  if (sized.length === 0) {
    return variants.reduce((best, variant) =>
      (variant?.bandwidth ?? 0) > (best?.bandwidth ?? 0) ? variant : best,
    );
  }

  if (Number.isFinite(maxHeight)) {
    const underCeiling = sized.filter((variant) => variant.height <= maxHeight);
    if (underCeiling.length > 0) {
      return underCeiling.reduce((best, variant) => (variant.height > best.height ? variant : best));
    }
    return sized.reduce((best, variant) => (variant.height < best.height ? variant : best));
  }

  return sized.reduce((best, variant) => (variant.height > best.height ? variant : best));
}

/** Turn parsed segments into absolute URLs with a running total. */
export function planSegments(media, baseUrl) {
  const segments = (media?.segments ?? []).map((segment) => ({
    index: segment.index,
    duration: segment.duration,
    url: resolveUri(baseUrl, segment.uri),
  }));
  const totalDuration = segments.reduce((sum, segment) => sum + (segment.duration ?? 0), 0);
  return {
    segments,
    totalDuration,
    endList: Boolean(media?.endList),
    targetDuration: media?.targetDuration ?? null,
    keys: (media?.keys ?? []).map((key) => ({ ...key, url: key.uri ? resolveUri(baseUrl, key.uri) : null })),
  };
}

/**
 * Build a complete download plan.
 *
 * Pass a media playlist for the simple case, or a master plus the media playlist
 * already fetched for the chosen variant. `playlistUrl` is `baseUrl` resolved
 * against the selected variant when a master was supplied.
 */
export function planDownload({ masterText, mediaText, baseUrl, maxHeight = null }) {
  const single = mediaText ?? (classifyPlaylist(masterText) === "media" ? masterText : null);
  if (!single) {
    const master = parseMasterPlaylist(masterText);
    const variant = selectVariant(master.variants, { maxHeight });
    if (!variant) throw new Error("no variants in master playlist");
    return {
      variant,
      playlistUrl: resolveUri(baseUrl, variant.uri),
      segments: [],
      totalDuration: 0,
      endList: false,
      targetDuration: null,
      keys: [],
      needsMediaPlaylist: true,
    };
  }

  const media = parseMediaPlaylist(single);
  const master = masterText && classifyPlaylist(masterText) === "master" ? parseMasterPlaylist(masterText) : null;
  const variant = master ? selectVariant(master.variants, { maxHeight }) : null;

  return {
    variant,
    playlistUrl: baseUrl ?? null,
    ...planSegments(media, baseUrl),
    needsMediaPlaylist: false,
  };
}

/**
 * Rewrite every URI a playlist mentions, keeping all tags intact.
 *
 * This is what makes a same-origin relay possible: segment lines, `EXT-X-KEY`
 * and `EXT-X-MEDIA` URIs all point back at the relay, so the player never
 * contacts the CDN directly.
 */
export function rewritePlaylistUris(text, rewrite) {
  if (typeof rewrite !== "function") throw new TypeError("rewritePlaylistUris needs a rewrite function");
  return String(text ?? "")
    .split(/\r?\n/)
    .map((rawLine) => {
      const line = rawLine.trim();
      if (!line) return rawLine;
      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]*)"/g, (_match, uri) => `URI="${rewrite(uri)}"`);
      }
      return rewrite(line);
    })
    .join("\n");
}

/**
 * The player origin a request claims when its host is not in the table.
 *
 * It is the same origin the web proxy and the plugin have always used; the API
 * passes its own fallback (`https://megaplay.buzz/`) because that is what its
 * providers expect.
 */
export const STREAM_REFERER = "https://play.echovideo.ru/";

/**
 * Hosts that refuse a request without a player origin as `Referer`.
 *
 * An entry is keyed by the host actually being fetched, not by the player. A CDN
 * edge (`nexabloom.top`) asks for the player it belongs to
 * (`https://megaplay.buzz/`), and a player host that requires its own origin
 * (`megaplay.buzz`) is simply an entry that maps to itself.
 *
 * This is the union of the three tables the API, the web app and the plugin each
 * carried. `apps/api` cannot import this package (its deploy root is `apps/api`,
 * so `packages/` is outside its build context and image), so it keeps a copy in
 * `src/catalogue/download.js` that `tests/referers.test.js` holds to this list.
 *
 * Kept as data so a caller can extend it: `createRefererResolver` takes its own
 * table and its own fallback.
 */
export const DEFAULT_REFERERS = [
  { host: "megaplay.buzz", referer: "https://megaplay.buzz/" },
  { host: "hentaimama.io", referer: "https://hentaimama.io/" },
  { host: "nexabloom.top", referer: "https://megaplay.buzz/" },
  { host: "hentaidoge.org", referer: "https://hentaimama.io/" },
  { host: "gdvid.info", referer: "https://hentaimama.io/" },
  { host: "dpopdrop89.store", referer: "https://play.echovideo.ru/" },
  { host: "roburnt10.store", referer: "https://play.echovideo.ru/" },
  { host: "crystaldrift.world", referer: "https://megaplay.buzz/" },
];

/**
 * Build a resolver. The returned function accepts a full URL or a bare hostname
 * and answers with the table's referer, or `fallback` when the host is unknown.
 */
export function createRefererResolver(entries = DEFAULT_REFERERS, fallback = null) {
  const table = entries
    .map((entry) => ({ host: String(entry.host).toLowerCase(), referer: entry.referer }))
    .sort((a, b) => b.host.length - a.host.length);

  return function refererFor(target) {
    let hostname;
    try {
      const text = String(target).trim();
      hostname = text.includes("://") ? new URL(text).hostname.toLowerCase() : text.toLowerCase();
    } catch {
      return fallback;
    }
    if (!hostname) return fallback;
    const match = table.find((entry) => hostname === entry.host || hostname.endsWith(`.${entry.host}`));
    return match ? match.referer : fallback;
  };
}

/** The shared table's answer for one URL. */
export const refererFor = createRefererResolver(DEFAULT_REFERERS);

// ---------------------------------------------------------------------------
// The downloader's playlist model
// ---------------------------------------------------------------------------
//
// `apps/plugin/src/hls.ts` and `apps/web/src/lib/download/hls.ts` each carried a
// parser that also answers two questions the plan-shaped API above does not:
// how long each segment is (needed for an ETA and a resume point) and whether
// the host serves subtitle renditions. That parser lives here now, and the
// plugin's tests are what hold it to the CDN's real playlists.
//
// It stays deliberately separate from `parseMediaPlaylist`: that one returns the
// raw playlist (keys, sequences, `#EXTM3U` handling) for a plan, while this one
// returns a ready-to-download list with absolute URLs, which is what an engine
// iterates over.

/**
 * Parse a media playlist into absolute segment URLs with their durations.
 *
 * @returns {{segments: string[], durations: number[], duration: number, targetDuration: number}}
 */
export function parseDownloadPlaylist(text, baseUrl) {
  const lines = String(text ?? "").split(/\r?\n/);
  const segments = [];
  const durations = [];
  let duration = 0;
  let targetDuration = 0;
  let pending = 0;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      pending = Number.parseFloat(line.slice("#EXTINF:".length)) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number.parseFloat(line.slice("#EXT-X-TARGETDURATION:".length)) || 0;
      continue;
    }
    if (line.startsWith("#")) continue;
    segments.push(resolveUri(baseUrl, line));
    durations.push(pending);
    duration += pending;
    pending = 0;
  }
  return { segments, durations, duration, targetDuration };
}

/**
 * Resolve a URL without throwing. A mirror can publish a link that `new URL`
 * refuses on its own (a bare `//` path, a stray space), and one bad link should
 * not fail a whole stream lookup with an exception the caller cannot explain.
 */
export function resolveUrl(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return uri;
  }
}

/**
 * Parse a master playlist into the quality variants a downloader chooses
 * between, sorted best first. `height` is 0 when the playlist omits RESOLUTION,
 * which is what a single-file mirror looks like.
 */
export function parseVariantPlaylist(text, baseUrl) {
  const lines = String(text ?? "").split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !line.startsWith("#EXT-X-STREAM-INF")) continue;
    const uri = lines[index + 1];
    if (!uri || uri.startsWith("#")) continue;
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0);
    const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(line);
    variants.push({
      width: resolution ? Number(resolution[1]) : 0,
      height: resolution ? Number(resolution[2]) : 0,
      bandwidth,
      url: resolveUrl(uri, baseUrl),
    });
  }
  return variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

/**
 * The variant matching a requested height, falling back to the closest at or
 * below it, then to the best available. Sources are frequently single-variant
 * (720p), so a request for 1080p must not fail the download.
 */
export function selectVariantFor(variants, preferredHeight) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const exact = variants.find((variant) => variant.height === preferredHeight);
  if (exact) return exact;
  const atOrBelow = variants.filter((variant) => variant.height > 0 && variant.height <= preferredHeight);
  if (atOrBelow.length > 0) return atOrBelow[0];
  return variants[0];
}

// ---------------------------------------------------------------------------
// Stream request core
// ---------------------------------------------------------------------------
//
// Resolving "this episode, on this server" into a playable file is the same
// sequence of API calls in the web app and in the plugin; only the transport
// differs (page `fetch` versus Obsidian's `requestUrl`, which bypasses CORS).
// The sequence lives here so both walk it identically, and so the plugin's
// tests, which encode the traps, cover web too.

/**
 * Servers that hand back a direct manifest, best first. Anything unlisted sorts
 * last so a new upstream server is still tried, just after the known ones.
 */
export const SERVER_PREFERENCE = ["Vidplay", "MyCloud", "DatSaV", "BYFMS", "DGHG"];

/**
 * Unique server names from the API's `servers` list, ordered by track type so a
 * fallback keeps the same audio track the default response used. The list
 * repeats a server once per track type, so duplicates are dropped.
 *
 * Deliberately not filtered by track type: the upstream labels every entry
 * `sub` (newer ones `ssub`) even when the server serves a dub, so a `type`
 * filter would leave a dub with no candidates at all.
 */
export function serverNames(servers, preferDub = false) {
  if (!Array.isArray(servers)) return [];
  const subbed = [];
  const dubbed = [];
  const rest = [];
  const seen = new Set();
  for (const entry of servers) {
    const record = (entry && typeof entry === "object" ? entry : {}) ;
    const name = asText(record.serverName) || asText(record.server_name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const type = asText(record.type);
    if (type === "sub") subbed.push(name);
    else if (type === "dub" && preferDub) dubbed.push(name);
    else rest.push(name);
  }
  return preferDub ? [...dubbed, ...subbed, ...rest] : [...subbed, ...rest];
}

/** All servers ordered by `SERVER_PREFERENCE`, excluding `exclude`. */
export function rankServers(servers, exclude) {
  const rank = (server) => {
    const index = SERVER_PREFERENCE.indexOf(server?.serverName);
    return index === -1 ? SERVER_PREFERENCE.length : index;
  };
  return (Array.isArray(servers) ? servers : [])
    .filter((server) => server?.serverName && server.serverName !== exclude)
    .sort((a, b) => rank(a) - rank(b));
}

function asText(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The request headers a manifest and its segments need.
 *
 * The API publishes the headers its current CDN demands, and the player origin
 * moves with the CDN, so its answer is forwarded verbatim and the shared referer
 * is only a fallback. A request without the right referer is answered 403.
 */
export function streamHeaders(value) {
  const headers = {};
  if (value && typeof value === "object") {
    for (const [key, raw] of Object.entries(value)) {
      const text = asText(raw);
      if (key && text) headers[key] = text;
    }
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "referer")) {
    headers.Referer = STREAM_REFERER;
  }
  return headers;
}

/**
 * Pull the usable link out of a `/api/stream` answer.
 *
 * The API's default server does not always serve a file — some series answer
 * with an embed-only player while the same response's `servers` list also names
 * servers that do return one — so the caller is told both what it got and what
 * else can be tried.
 */
export function readStreamLink(result) {
  const record = result && typeof result === "object" ? result : {};
  const link = record.streamingLink;
  const chosen = (Array.isArray(link) ? link[0] : link) || {};
  return {
    file: asText(chosen.link?.file) || null,
    iframe: asText(chosen.iframe) || null,
    server: asText(chosen.server) || null,
    headers: streamHeaders(chosen.headers),
    servers: Array.isArray(record.servers) ? record.servers : [],
  };
}

/**
 * Resolve an episode to a downloadable manifest URL, walking the API's
 * alternate servers when the default only offers an embed.
 *
 * `request(path)` fetches one path against the API and returns the parsed
 * `results` payload, or null. Every alternate is isolated: one server failing
 * on its own (500, timeout) must not abort the search, so the next is tried.
 *
 * @param {{id: string, server?: string|null, preferDub?: boolean, includeAdult?: boolean}} options
 * @param {(path: string) => Promise<unknown>} request
 */
export async function resolveStream(options, request) {
  const { id, server = null, preferDub = false, includeAdult = false } = options || {};
  if (!id) throw new TypeError("resolveStream needs an episode id");
  if (server) {
    const chosen = readStreamLink(await request(`/api/stream?id=${encodeURIComponent(id)}`));
    return { ...chosen, triedFallbacks: false };
  }

  // Adult titles the MAL mirror indexes stream only when the caller opts in;
  // without this the API answers 502 and the job fails for nothing.
  const adultQuery = includeAdult ? "&includeAdult=1" : "";
  const first = readStreamLink(
    await request(`/api/stream?id=${encodeURIComponent(id)}${adultQuery}`),
  );
  if (first.file) return { ...first, triedFallbacks: false };

  const tried = new Set([server, first.server]);
  // Subbed tracks first so a fallback keeps the audio track the default used;
  // the preference order only breaks ties inside each track.
  for (const name of serverNames(first.servers, preferDub)) {
    if (tried.has(name)) continue;
    tried.add(name);
    try {
      const candidate = readStreamLink(
        await request(
          `/api/stream?id=${encodeURIComponent(id)}${adultQuery}&server=${encodeURIComponent(name)}`,
        ),
      );
      if (candidate.file) return { ...candidate, triedFallbacks: true };
    } catch {
      // Try the next server.
    }
  }

  // Every candidate was tried. If one is known to be preference-first, report
  // that one rather than whichever happened to be the default.
  for (const candidate of rankServers(
    first.servers.map((entry) => ({ serverName: asText(entry?.serverName) })),
    first.server,
  )) {
    if (!candidate.serverName) continue;
    try {
      const next = readStreamLink(
        await request(
          `/api/stream?id=${encodeURIComponent(id)}${adultQuery}&server=${encodeURIComponent(candidate.serverName)}`,
        ),
      );
      if (next.servers.length || next.file || next.iframe) return { ...next, triedFallbacks: true };
    } catch {
      // Try the next one.
    }
  }
  return { ...first, triedFallbacks: false };
}

/**
 * Adaptive concurrency decision for a segment download.
 *
 * The CDN refuses us *right now* on a 429, so shedding one worker at a time
 * converges far too slowly from a high setting, and every worker that keeps
 * firing while it converges earns another 429 — a 138-segment episode measured
 * 242 s starting at 12 workers versus 9 s at 3. So a 429 halves the target and
 * makes the level that just failed a ceiling the pool may not climb back past;
 * recovery then adds one worker per cooldown and stops at the ceiling, settling
 * near the rate the CDN will actually sustain instead of oscillating.
 *
 * The waiting itself is the caller's: this module has no timers, so a Node test
 * can drive it with a clock and the apps can use whichever sleep they have.
 */

/** Cooldown between two concurrency increases. */
export const GATE_COOLDOWN_MS = 5000;
/** How often a worker parked by the gate re-checks the target. */
export const GATE_POLL_MS = 50;

/**
 * @param {number} workers initial concurrency
 * @param {() => number} [now]
 * @returns {{target: number, ceiling: number, recoverAt: number, limited: boolean, now: () => number}}
 */
export function createGateState(workers, now = () => Date.now()) {
  const start = Math.max(1, Math.floor(workers));
  return { target: start, ceiling: start, recoverAt: 0, limited: false, now };
}

/** A 429 was seen: halve the target, cap the ceiling below it, cool down. */
export function shedConcurrency(state) {
  state.ceiling = Math.max(1, state.target - 1);
  state.target = Math.max(1, Math.floor(state.target / 2));
  state.recoverAt = state.now() + GATE_COOLDOWN_MS;
  state.limited = true;
}

/**
 * Wait until the pool may start another segment.
 *
 * Returns true when it is this call that raised the target, so the caller can
 * release one worker instead of several at once.
 */
export async function nextGate(state, wait, signal, onAbort = () => new Error("Download cancelled.")) {
  while (state.target < state.ceiling) {
    if (signal?.aborted) throw onAbort();
    if (state.now() >= state.recoverAt) {
      state.target += 1;
      // Hold the next increment back by another cooldown so the pool climbs
      // gradually instead of all at once.
      state.recoverAt = state.now() + GATE_COOLDOWN_MS;
      return true;
    }
    await wait(GATE_POLL_MS, signal);
  }
  return false;
}

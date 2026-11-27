/**
 * GENERATED from packages/hls/src/index.d.ts — do not edit.
 * Types for the vendored copy in the standalone plugin mirror.
 */
export interface HlsVariant {
  uri: string;
  bandwidth: number | null;
  averageBandwidth: number | null;
  resolution: string | null;
  height: number | null;
  codecs: string | null;
  audioGroup: string | null;
}

export interface HlsRendition {
  type: string | null;
  groupId: string | null;
  name: string | null;
  language: string | null;
  uri: string;
}

export interface HlsMaster {
  variants: HlsVariant[];
  renditions: HlsRendition[];
}

export interface HlsSegment {
  index: number;
  uri: string;
  duration: number | null;
  sequence: number;
}

export interface HlsKey {
  method: string | null;
  uri: string | null;
  keyFormat: string | null;
  iv: string | null;
}

export interface HlsMedia {
  segments: HlsSegment[];
  keys: HlsKey[];
  mediaSequence: number;
  targetDuration: number | null;
  endList: boolean;
}

export interface PlannedSegment {
  index: number;
  duration: number | null;
  url: string;
}

export interface DownloadPlan {
  variant: HlsVariant | null;
  playlistUrl: string | null;
  segments: PlannedSegment[];
  totalDuration: number;
  endList: boolean;
  targetDuration: number | null;
  keys: (HlsKey & { url: string | null })[];
  /** True when a master was supplied but its media playlist was not. */
  needsMediaPlaylist?: boolean;
}

export interface RefererEntry {
  host: string;
  referer: string;
}

export function classifyPlaylist(text: string): "master" | "media" | "unknown";
export function isPlaylistContentType(contentType: string | null | undefined): boolean;
export function parseMasterPlaylist(text: string): HlsMaster;
export function parseMediaPlaylist(text: string): HlsMedia;
export function resolveUri(baseUrl: string, uri: string): string;
export function selectVariant(variants: HlsVariant[], options?: { maxHeight?: number | null }): HlsVariant | null;
export function planSegments(media: HlsMedia, baseUrl: string): Omit<DownloadPlan, "variant" | "playlistUrl">;
export function planDownload(options: {
  masterText?: string;
  mediaText?: string;
  baseUrl?: string;
  maxHeight?: number | null;
}): DownloadPlan;
export function rewritePlaylistUris(text: string, rewrite: (uri: string) => string): string;
export function createRefererResolver(entries?: RefererEntry[]): (url: string) => string | null;
export const DEFAULT_REFERERS: RefererEntry[];
export const refererFor: (url: string) => string | null;

// ---------------------------------------------------------------------------
// The downloader's playlist model
// ---------------------------------------------------------------------------

export interface DownloadPlaylist {
  /** Absolute segment URLs in playback order. */
  segments: string[];
  /** Duration of each segment in seconds, in the same order. */
  durations: number[];
  /** Total duration in seconds, from the `#EXTINF` values. */
  duration: number;
  targetDuration: number;
}

export interface DownloadVariant {
  height: number;
  width: number;
  bandwidth: number;
  url: string;
}

export function parseDownloadPlaylist(text: string, baseUrl: string): DownloadPlaylist;
export function resolveUrl(uri: string, baseUrl: string): string;
export function parseVariantPlaylist(text: string, baseUrl: string): DownloadVariant[];
export function selectVariantFor(variants: DownloadVariant[], preferredHeight: number): DownloadVariant | null;

// ---------------------------------------------------------------------------
// Stream request core
// ---------------------------------------------------------------------------

/** The fields `serverNames`/`rankServers` read. Any extra fields are preserved. */
export interface StreamServerRow {
  type?: string | null;
  serverName?: string | null;
  server_name?: string | null;
}

export interface StreamLink {
  /** Manifest (or single-file mirror) URL, or null when only an embed exists. */
  file: string | null;
  iframe: string | null;
  server: string | null;
  /** Headers the manifest and its segments require. */
  headers: Record<string, string>;
  /** The API's server list, for a picker or a fallback walk. */
  servers: StreamServerRow[];
}

export interface ResolvedStream extends StreamLink {
  /** True when an alternate server answered because the default was embed-only. */
  triedFallbacks: boolean;
}

export function serverNames(servers: unknown, preferDub?: boolean): string[];
export function rankServers<T extends StreamServerRow>(servers: T[], exclude?: string | null): T[];
export function streamHeaders(value: unknown): Record<string, string>;
export function readStreamLink(result: unknown): StreamLink;
export function resolveStream(
  options: { id: string; server?: string | null; preferDub?: boolean; includeAdult?: boolean },
  request: (path: string) => Promise<unknown>,
): Promise<ResolvedStream>;
export const SERVER_PREFERENCE: string[];
export const STREAM_REFERER: string;

// ---------------------------------------------------------------------------
// Adaptive concurrency
// ---------------------------------------------------------------------------

export interface GateState {
  target: number;
  ceiling: number;
  recoverAt: number;
  /** True once a 429 has been seen; the caller reports a rate limit at the end. */
  limited: boolean;
  now: () => number;
}

export const GATE_COOLDOWN_MS: number;
export const GATE_POLL_MS: number;
export function createGateState(workers: number, now?: () => number): GateState;
export function shedConcurrency(state: GateState): void;
export function nextGate(
  state: GateState,
  wait: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
  onAbort?: () => Error,
): Promise<boolean>;

import type { CookieRecord } from './types';

/** Messages sent from the sandboxed page to the plugin. */
export type BridgeMessage =
	| { type: 'ready' }
	| { type: 'title'; title: string }
	| { type: 'navigate'; url: string; method?: string; body?: string; contentType?: string }
	| { type: 'openExternal'; url: string }
	| { type: 'cookie'; raw: string; url: string }
	| { type: 'error'; message: string };

type Handler = (message: BridgeMessage) => void;

const handlers = new Map<string, Handler>();
let listening = false;

function isBridgeMessage(data: unknown): data is BridgeMessage & { __bfm: true; channel: string } {
	if (!data || typeof data !== 'object') return false;
	const record = data as Record<string, unknown>;
	return record.__bfm === true && typeof record.channel === 'string' && typeof record.type === 'string';
}

function ensureListener(): void {
	if (listening) return;
	listening = true;
	activeWindow.addEventListener('message', (event: MessageEvent) => {
		const data: unknown = event.data;
		if (!isBridgeMessage(data)) return;
		const handler = handlers.get(data.channel);
		if (!handler) return;
		handler(data);
	});
}

/** Register a message handler for a view instance. */
export function registerBridgeChannel(channel: string, handler: Handler): void {
	ensureListener();
	handlers.set(channel, handler);
}

export function unregisterBridgeChannel(channel: string): void {
	handlers.delete(channel);
}

/** Push the current cookie jar into a rendered page. */
export function postCookiesToFrame(frame: HTMLIFrameElement, channel: string, cookies: CookieRecord[]): void {
	const win = frame.contentWindow;
	if (!win) return;
	win.postMessage({ __bfmHost: true, channel, type: 'cookies', cookies }, '*');
}

export interface BridgeConfig {
	channel: string;
	host: string;
	path: string;
	baseUrl: string;
	cookies: CookieRecord[];
}

/**
 * Build the script injected into proxied documents. It shims `document.cookie`
 * against the plugin's cookie jar and forwards navigation back to the plugin,
 * because a sandboxed frame cannot load cross-origin pages on its own.
 */
export function buildBridgeScript(config: BridgeConfig): string {
	const json = JSON.stringify(config).replace(/</g, '\\u003c');
	const lines = [
		'(function () {',
		"  'use strict';",
		`  var CONFIG = ${json};`,
		'  var jar = (CONFIG.cookies || []).slice();',
		'  function post(type, data) {',
		'    var msg = { __bfm: true, channel: CONFIG.channel, type: type };',
		'    if (data) { for (var k in data) { if (Object.prototype.hasOwnProperty.call(data, k)) { msg[k] = data[k]; } } }',
		"    try { (window.parent || window.top).postMessage(msg, '*'); } catch (e) {}",
		'  }',
		'  function now() { return Date.now(); }',
		'  function host() { return (CONFIG.host || "").toLowerCase(); }',
		'  function pathname() { return CONFIG.path || "/"; }',
		'  function hostMatches(c) {',
		"    var d = String(c.domain || '').replace(/^\\./, '').toLowerCase();",
		'    if (c.hostOnly) { return host() === d; }',
		"    return host() === d || host().slice(-(d.length + 1)) === '.' + d;",
		'  }',
		'  function pathMatches(c) {',
		"    return pathname().indexOf(c.path || '/') === 0;",
		'  }',
		'  function active() {',
		'    return jar.filter(function (c) {',
		'      if (c.expires && c.expires <= now()) { return false; }',
		'      return hostMatches(c) && pathMatches(c);',
		'    });',
		'  }',
		'  function readCookie() {',
		"    return active().map(function (c) { return c.name + '=' + c.value; }).join('; ');",
		'  }',
		'  function applyRaw(raw) {',
		"    var parts = String(raw).split(';');",
		'    var first = parts.shift() || "";',
		'    var eq = first.indexOf("=");',
		'    if (eq < 0) { return; }',
		'    var name = first.slice(0, eq).trim();',
		'    var value = first.slice(eq + 1).trim();',
		'    if (!name) { return; }',
		'    var attrs = {};',
		'    parts.forEach(function (p) {',
		'      var i = p.indexOf("=");',
		'      if (i < 0) { attrs[p.trim().toLowerCase()] = ""; }',
		'      else { attrs[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim(); }',
		'    });',
		'    var domain = (attrs["domain"] || host()).replace(/^\\./, "").toLowerCase();',
		'    var hostOnly = !attrs["domain"];',
		'    if (attrs["domain"] && host() !== domain && host().slice(-(domain.length + 1)) !== "." + domain) { return; }',
		'    var expires = null;',
		'    if (attrs["max-age"] !== undefined) {',
		'      var s = parseInt(attrs["max-age"], 10);',
		'      if (isFinite(s)) { expires = now() + s * 1000; }',
		'    } else if (attrs["expires"]) {',
		'      var t = Date.parse(attrs["expires"]);',
		'      if (isFinite(t)) { expires = t; }',
		'    }',
		'    var path = attrs["path"] || "/";',
		'    jar = jar.filter(function (c) { return !(c.name === name && c.domain === domain && (c.path || "/") === path); });',
		'    if (expires !== null && expires <= now()) { return; }',
		'    jar.push({ name: name, value: value, domain: domain, path: path, expires: expires, secure: attrs["secure"] !== undefined, httpOnly: false, hostOnly: hostOnly });',
		'  }',
		'  function writeCookie(value) {',
		'    try { applyRaw(value); post("cookie", { raw: String(value), url: location.href }); } catch (e) {}',
		'  }',
		'  try {',
		'    Object.defineProperty(document, "cookie", { get: readCookie, set: writeCookie, configurable: true });',
		'  } catch (e) {',
		'    try { Object.defineProperty(Document.prototype, "cookie", { get: readCookie, set: writeCookie, configurable: true }); } catch (e2) {}',
		'  }',
		'  function inMemoryStorage() {',
		'    var data = {};',
		'    var api = {',
		'      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },',
		'      setItem: function (k, v) { data[String(k)] = String(v); },',
		'      removeItem: function (k) { delete data[String(k)]; },',
		'      clear: function () { data = {}; },',
		'      key: function (i) { return Object.keys(data)[i] || null; },',
		'    };',
		'    Object.defineProperty(api, "length", { get: function () { return Object.keys(data).length; } });',
		'    return api;',
		'  }',
		// Opaque-origin frames throw on storage access, which crashes framework boot.
		// Fall back to an in-memory store so pages that read storage keep working.
		'  function safeStorage(name) {',
		'    var real = null;',
		'    try { real = window[name]; if (real) { real.getItem("__bfm_probe__"); real.removeItem("__bfm_probe__"); return real; } }',
		'    catch (e) {}',
		'    var fake = inMemoryStorage();',
		'    try { Object.defineProperty(window, name, { get: function () { return fake; }, configurable: true }); } catch (e) {}',
		'    return fake;',
		'  }',
		'  safeStorage("localStorage");',
		'  safeStorage("sessionStorage");',
		// Cross-origin frames report a 0x0 viewport; a plausible size keeps layout code from bailing out.
		'  try {',
		'    if (window.innerWidth === 0) {',
		'      Object.defineProperty(window, "innerWidth", { get: function () { return 1024; }, configurable: true });',
		'      Object.defineProperty(window, "innerHeight", { get: function () { return 768; }, configurable: true });',
		'    }',
		'  } catch (e) {}',
		'  function absolute(href) {',
		'    try { return new URL(href, document.baseURI || CONFIG.baseUrl || location.href).href; } catch (e) { return null; }',
		'  }',
		'  function isHttp(u) { return /^https?:/i.test(u); }',
		'  document.addEventListener("click", function (ev) {',
		'    if (ev.defaultPrevented) { return; }',
		'    if (typeof ev.button === "number" && ev.button !== 0) { return; }',
		'    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) { return; }',
		'    var el = ev.target;',
		'    while (el && el.tagName !== "A") { el = el.parentElement; }',
		'    if (!el) { return; }',
		'    var href = el.getAttribute("href");',
		'    if (!href || href.charAt(0) === "#") { return; }',
		'    var url = absolute(href);',
		'    if (!url || !isHttp(url)) { return; }',
		'    ev.preventDefault();',
		'    ev.stopPropagation();',
		'    if (el.target === "_blank") { post("openExternal", { url: url }); }',
		'    else { post("navigate", { url: url, method: "GET" }); }',
		'  }, true);',
		'  document.addEventListener("submit", function (ev) {',
		'    var form = ev.target;',
		'    if (!form || form.tagName !== "FORM") { return; }',
		'    var method = (form.getAttribute("method") || "GET").toUpperCase();',
		'    var url = absolute(form.getAttribute("action") || location.href);',
		'    if (!url || !isHttp(url)) { return; }',
		'    var data = new FormData(form);',
		'    ev.preventDefault();',
		'    if (method === "GET") {',
		'      var params = new URLSearchParams();',
		'      data.forEach(function (v, k) { params.append(k, typeof v === "string" ? v : v.name); });',
		'      var q = params.toString();',
		'      if (q) { url += (url.indexOf("?") === -1 ? "?" : "&") + q; }',
		'      post("navigate", { url: url, method: "GET" });',
		'    } else {',
		'      var pairs = [];',
		'      data.forEach(function (v, k) { pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(typeof v === "string" ? v : v.name)); });',
		'      post("navigate", { url: url, method: method, body: pairs.join("&"), contentType: "application/x-www-form-urlencoded" });',
		'    }',
		'  }, true);',
		'  window.open = function (u) { if (u) { var url = absolute(u); if (url && isHttp(url)) { post("openExternal", { url: url }); } } return null; };',
		'  function reportTitle() { if (document.title) { post("title", { title: document.title }); } }',
		'  window.addEventListener("message", function (ev) {',
		'    var d = ev.data;',
		'    if (!d || d.__bfmHost !== true || d.channel !== CONFIG.channel) { return; }',
		'    if (d.type === "cookies" && Array.isArray(d.cookies)) { jar = d.cookies.slice(); }',
		'  });',
		'  if (document.readyState === "loading") {',
		'    document.addEventListener("DOMContentLoaded", function () { reportTitle(); post("ready", {}); });',
		'  } else { reportTitle(); post("ready", {}); }',
		'  window.addEventListener("load", reportTitle);',
		'  window.addEventListener("error", function (e) { if (e && e.message) { post("error", { message: String(e.message) }); } });',
		'})();',
	];
	return `<script data-bfm-bridge="1">${lines.join('\n')}</script>`;
}

/** Inject the bridge script into a rewritten document. */
export function injectBridge(html: string, config: BridgeConfig): string {
	const script = buildBridgeScript(config);
	const headOpen = /<head\b[^>]*>/i.exec(html);
	if (headOpen && headOpen.index >= 0) {
		const at = headOpen.index + headOpen[0].length;
		return `${html.slice(0, at)}${script}${html.slice(at)}`;
	}
	const htmlOpen = /<html\b[^>]*>/i.exec(html);
	if (htmlOpen && htmlOpen.index >= 0) {
		const at = htmlOpen.index + htmlOpen[0].length;
		return `${html.slice(0, at)}<head>${script}</head>${html.slice(at)}`;
	}
	return `${script}${html}`;
}

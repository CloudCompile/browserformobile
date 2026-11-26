import { requestUrl } from 'obsidian';

/**
 * Native HTTP for the browser.
 *
 * CapacitorHttp is the verified path on Obsidian Android: it uses the native
 * HTTP stack, so pages and their subresources are not subject to CORS. The
 * desktop build has no Capacitor, so Obsidian's `requestUrl` is the fallback.
 */

export interface NativeRequestOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | null;
}

export interface NativeResponse {
	status: number;
	statusText: string;
	url: string;
	headers: Record<string, string>;
	bytes: Uint8Array;
}

interface CapacitorHttpResult {
	status?: number;
	statusText?: string;
	url?: string;
	headers?: Record<string, string | string[]>;
	data?: unknown;
}

interface CapacitorHttpPlugin {
	request(options: Record<string, unknown>): Promise<CapacitorHttpResult>;
}

interface CapacitorGlobal {
	Plugins?: Record<string, unknown>;
}

const REQUEST_TIMEOUT_MS = 45_000;

function capacitorHttp(): CapacitorHttpPlugin | null {
	const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
	const plugin = capacitor?.Plugins?.CapacitorHttp;
	if (!plugin || typeof plugin !== 'object') return null;
	const request = (plugin as { request?: unknown }).request;
	return typeof request === 'function' ? (plugin as CapacitorHttpPlugin) : null;
}

export function normalizeHeaders(headers: Record<string, string | string[]> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
	}
	return out;
}

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
	return headers[name.toLowerCase()];
}

function bytesFromData(data: unknown): Uint8Array {
	if (data == null) return new Uint8Array(0);
	if (typeof data === 'string') {
		try {
			return base64ToBytes(data);
		} catch {
			return new TextEncoder().encode(data);
		}
	}
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
	}
	try {
		return new TextEncoder().encode(JSON.stringify(data));
	} catch {
		return new Uint8Array(0);
	}
}

export function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value.replace(/\s+/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	}
	return btoa(binary);
}

/** Decode text honouring the response charset, then a meta charset, then UTF-8. */
export function decodeText(bytes: Uint8Array, contentType?: string): string {
	let charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
	if (!charset) {
		const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
		charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
	}
	try {
		return new TextDecoder(charset || 'utf-8').decode(bytes);
	} catch {
		return new TextDecoder('utf-8').decode(bytes);
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: number | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = window.setTimeout(() => reject(new Error('The request timed out.')), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) window.clearTimeout(timer);
	});
}

async function capacitorRequest(
	plugin: CapacitorHttpPlugin,
	options: NativeRequestOptions,
	headers: Record<string, string>,
): Promise<NativeResponse> {
	const method = (options.method ?? 'GET').toUpperCase();
	let data: unknown = options.body ?? undefined;
	if (typeof data === 'string') {
		const type = headers['content-type'] ?? '';
		if (/x-www-form-urlencoded/i.test(type)) {
			const params = new URLSearchParams(data);
			const object: Record<string, string> = {};
			params.forEach((value, key) => {
				object[key] = value;
			});
			data = object;
		} else if (/json/i.test(type)) {
			try {
				data = JSON.parse(data);
			} catch {
				/* Send the string as-is when it is not valid JSON. */
			}
		}
	}
	const response = await plugin.request({
		url: options.url,
		method,
		headers,
		data,
		responseType: 'blob',
		connectTimeout: 20_000,
		readTimeout: 45_000,
	});
	return {
		status: Number(response.status ?? 0),
		statusText: response.statusText ?? '',
		url: response.url || options.url,
		headers: normalizeHeaders(response.headers),
		bytes: bytesFromData(response.data),
	};
}

async function obsidianRequest(
	options: NativeRequestOptions,
	headers: Record<string, string>,
): Promise<NativeResponse> {
	const method = (options.method ?? 'GET').toUpperCase();
	const response = await withTimeout(
		requestUrl({
			url: options.url,
			method,
			headers,
			body: options.body ?? undefined,
			throw: false,
		}),
		REQUEST_TIMEOUT_MS,
	);
	return {
		status: response.status,
		statusText: '',
		// requestUrl does not report the final URL after redirects.
		url: options.url,
		headers: normalizeHeaders(response.headers),
		bytes: new Uint8Array(response.arrayBuffer),
	};
}

/** Perform one native request. Returns the body as bytes, never decoded. */
export async function nativeRequest(options: NativeRequestOptions): Promise<NativeResponse> {
	const headers = normalizeHeaders(options.headers);
	const capacitor = capacitorHttp();
	if (capacitor) return capacitorRequest(capacitor, options, headers);
	return obsidianRequest(options, headers);
}

export interface DebugAdapter {
	appendBinary?(path: string, data: ArrayBuffer): Promise<void>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	mkdir?(path: string): Promise<void>;
}

/** Non-secret runtime details useful when reproducing a mobile-only issue. */
export function machineInfo(): Record<string, unknown> {
	const nav = typeof navigator === 'undefined'
		? null
		: navigator as Navigator & {
			deviceMemory?: number;
			connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
			userAgentData?: { platform?: string };
		};
	const screenInfo = typeof screen === 'undefined' ? null : screen;
	return {
		userAgent: nav?.userAgent ?? null,
		platform: nav?.userAgentData?.platform ?? null,
		language: nav?.language ?? null,
		languages: nav?.languages ?? [],
		onLine: nav?.onLine ?? null,
		hardwareConcurrency: nav?.hardwareConcurrency ?? null,
		deviceMemoryGb: nav?.deviceMemory ?? null,
		maxTouchPoints: nav?.maxTouchPoints ?? null,
		connection: nav?.connection ? {
			effectiveType: nav.connection.effectiveType ?? null,
			downlinkMbps: nav.connection.downlink ?? null,
			rttMs: nav.connection.rtt ?? null,
			saveData: nav.connection.saveData ?? null,
		} : null,
		screen: screenInfo ? {
			width: screenInfo.width,
			height: screenInfo.height,
			availWidth: screenInfo.availWidth,
			availHeight: screenInfo.availHeight,
			pixelDepth: screenInfo.pixelDepth,
			orientation: screenInfo.orientation?.type ?? null,
		} : null,
		window: typeof window === 'undefined' ? null : {
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			devicePixelRatio: window.devicePixelRatio,
			visibility: typeof document === 'undefined' ? null : document.visibilityState,
		},
	};
}

/** Small append-only logger for diagnosing mobile download and repair runs. */
export class DebugLogger {
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly adapter: DebugAdapter,
		private readonly path: string,
		private readonly enabled: () => boolean,
	) {}

	log(message: string, details?: unknown): void {
		if (!this.enabled()) return;
		const suffix = details === undefined ? '' : ` ${this.stringify(details)}`;
		const line = `${new Date().toISOString()} ${message}${suffix}\n`;
		this.queue = this.queue.then(async () => {
			try {
				const data = new TextEncoder().encode(line);
				if (this.adapter.appendBinary) {
					await this.adapter.appendBinary(this.path, data.buffer);
				} else {
					await this.adapter.writeBinary(this.path, data.buffer);
				}
			} catch {
				// Debug logging must never interrupt a download or repair.
			}
		});
	}

	logMachineInfo(): void {
		this.log('machine.info', machineInfo());
	}

	private stringify(value: unknown): string {
		try {
			return JSON.stringify(value);
		} catch {
			return JSON.stringify(String(value));
		}
	}
}

export interface DebugAdapter {
	appendBinary?(path: string, data: ArrayBuffer): Promise<void>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	mkdir?(path: string): Promise<void>;
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

	private stringify(value: unknown): string {
		try {
			return JSON.stringify(value);
		} catch {
			return JSON.stringify(String(value));
		}
	}
}

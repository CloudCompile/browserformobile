/**
 * Minimal type surface for the parts of mux.js this plugin uses. The package
 * ships no types of its own.
 */
declare module 'mux.js' {
	interface TransmuxerSegment {
		initSegment?: Uint8Array;
		data: Uint8Array;
		captions?: unknown[];
	}

	interface TransmuxerOptions {
		keepOriginalTimestamps?: boolean;
		remux?: boolean;
		alignGopsAtEnd?: boolean;
	}

	class Transmuxer {
		constructor(options?: TransmuxerOptions);
		on(event: 'data', handler: (segment: TransmuxerSegment) => void): void;
		on(event: 'done', handler: () => void): void;
		push(data: Uint8Array): void;
		flush(): void;
		setBaseMediaDecodeTime(baseMediaDecodeTime: number): void;
	}

	const muxjs: {
		mp4: {
			Transmuxer: typeof Transmuxer;
		};
	};

	export default muxjs;
	export { Transmuxer };
}

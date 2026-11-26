import { describe, expect, it } from 'vitest';

import {
	extensionOf,
	filenameFor,
	isHlsUrl,
	kindForUrl,
	normalizeBrowserInput,
	normalizeDirectUrl,
	parseContentDisposition,
	parseContentRange,
	selectSrcset,
} from '../src/browser/media';

describe('browser URL input', () => {
	it('searches free text and opens dotted hosts', () => {
		expect(normalizeBrowserInput('cats', 'https://duckduckgo.com/?q=')).toBe(
			'https://duckduckgo.com/?q=cats',
		);
		expect(normalizeBrowserInput('example.com/watch', 'https://duckduckgo.com/?q=')).toBe(
			'https://example.com/watch',
		);
		expect(normalizeBrowserInput('localhost:8080', 'https://duckduckgo.com/?q=')).toBe(
			'http://localhost:8080',
		);
	});

	it('accepts only direct URLs for the download dialog', () => {
		expect(normalizeDirectUrl('example.com/video.mp4')).toBe('https://example.com/video.mp4');
		expect(normalizeDirectUrl('//cdn.example.com/video.mp4')).toBe(
			'https://cdn.example.com/video.mp4',
		);
		expect(normalizeDirectUrl('search for cats')).toBeNull();
	});
});

describe('browser media classification', () => {
	it('reads extensions over query strings and recognises HLS', () => {
		expect(extensionOf('https://cdn.example.com/a.MP4?token=1#t=2')).toBe('mp4');
		expect(kindForUrl('https://cdn.example.com/a.mp4')).toBe('video');
		expect(kindForUrl('https://cdn.example.com/live/index.m3u8?token=1')).toBe('hls');
		expect(isHlsUrl('https://cdn.example.com/live/index.m3u8')).toBe(true);
		expect(kindForUrl('https://cdn.example.com/photo', 'image/webp')).toBe('image');
		expect(kindForUrl('https://cdn.example.com/archive.zip')).toBe('file');
	});
});

describe('download filenames', () => {
	it('prefers an explicit name, then Content-Disposition, then the URL', () => {
		expect(filenameFor('mine.mp4', 'https://cdn.example.com/a.mp4', 'video/mp4', undefined, 'video')).toBe(
			'mine.mp4',
		);
		expect(
			filenameFor(
				undefined,
				'https://cdn.example.com/download',
				'video/mp4',
				'attachment; filename="clip.mp4"',
				'video',
			),
		).toBe('clip.mp4');
		expect(
			filenameFor(
				undefined,
				'https://cdn.example.com/download',
				'video/mp4',
				undefined,
				'video',
			),
		).toBe('download.mp4');
	});

	it('decodes RFC 5987 filenames and converts HLS to MP4', () => {
		expect(parseContentDisposition("attachment; filename*=UTF-8''my%20video.mp4")).toBe(
			'my video.mp4',
		);
		expect(filenameFor(undefined, 'https://cdn.example.com/index.m3u8', 'video/mp4', undefined, 'hls')).toBe(
			'index.mp4',
		);
	});

	it('strips path separators from a requested name', () => {
		const name = filenameFor('../evil.mp4', 'https://cdn.example.com/a.mp4', 'video/mp4', undefined, 'video');
		expect(name.includes('/')).toBe(false);
		expect(name.endsWith('.mp4')).toBe(true);
	});
});

describe('range and srcset helpers', () => {
	it('reads the total from a Content-Range header', () => {
		expect(parseContentRange('bytes 0-1048575/9000000')).toEqual({
			start: 0,
			end: 1048575,
			total: 9000000,
		});
		expect(parseContentRange('bytes 0-0/*')).toEqual({ start: 0, end: 0, total: null });
		expect(parseContentRange('not a range')).toBeNull();
	});

	it('picks the largest srcset candidate', () => {
		expect(selectSrcset('small.jpg 320w, medium.jpg 640w, large.jpg 1280w')).toBe(
			'large.jpg',
		);
		expect(selectSrcset('one.jpg 1x, two.jpg 2x')).toBe('two.jpg');
	});
});

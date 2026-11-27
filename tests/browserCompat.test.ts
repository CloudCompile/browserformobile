import { describe, expect, it } from 'vitest';

import { framingAllowed, looksBlank, parseMetaRefresh } from '../src/browser/compat';

describe('browser compatibility mode', () => {
	it('allows framing only when the page does not deny it', () => {
		expect(framingAllowed({})).toBe(true);
		expect(framingAllowed({ 'x-frame-options': 'DENY' })).toBe(false);
		expect(framingAllowed({ 'x-frame-options': 'SAMEORIGIN' })).toBe(false);
		expect(
			framingAllowed({
				'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
			}),
		).toBe(false);
		expect(
			framingAllowed({
				'content-security-policy': 'default-src *; frame-ancestors *',
			}),
		).toBe(true);
	});

	it('reads meta refresh targets and clamps their delay', () => {
		expect(parseMetaRefresh("0; url='/next'", 'https://example.com/start')).toEqual({
			url: 'https://example.com/next',
			delayMs: 0,
		});
		expect(parseMetaRefresh('120;URL=https://example.com/next', 'https://example.com/')).toEqual({
			url: 'https://example.com/next',
			delayMs: 30_000,
		});
		expect(parseMetaRefresh('0; url=javascript:alert(1)', 'https://example.com/')).toBeNull();
	});

	it('flags only pages with neither text nor interactive or media content', () => {
		expect(looksBlank(0, 0)).toBe(true);
		expect(looksBlank(12, 0)).toBe(true);
		expect(looksBlank(12, 1)).toBe(false);
		expect(looksBlank(120, 0)).toBe(false);
	});
});

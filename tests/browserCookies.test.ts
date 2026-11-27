import { describe, expect, it } from 'vitest';

import { BrowserCookieJar, cookieHeader, parseSetCookie } from '../src/browser/cookies';

describe('browser cookies', () => {
	it('parses Set-Cookie attributes without losing an Expires date', () => {
		const cookie = parseSetCookie(
			'session=abc123; Domain=example.com; Path=/app; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure; HttpOnly; SameSite=Lax',
			'https://www.example.com/app/login',
		);
		expect(cookie).toEqual({
			name: 'session',
			value: 'abc123',
			domain: 'example.com',
			path: '/app',
			expires: Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'),
			secure: true,
			httpOnly: true,
			sameSite: 'Lax',
			hostOnly: false,
		});
	});

	it('uses host-only and default-path rules when attributes are absent', () => {
		const cookie = parseSetCookie('theme=dark', 'https://news.example.com/section/page');
		expect(cookie).toMatchObject({
			domain: 'news.example.com',
			path: '/section',
			hostOnly: true,
			expires: null,
		});
	});

	it('sends only matching, unexpired cookies and puts longer paths first', () => {
		const now = Date.now();
		const cookies = [
			parseSetCookie('a=root; Path=/', 'https://example.com/')!,
			parseSetCookie('a=deep; Path=/app', 'https://example.com/app')!,
			parseSetCookie('gone=x; Max-Age=-60', 'https://example.com/')!,
			parseSetCookie('secure=s; Secure', 'https://example.com/')!,
		];
		expect(cookieHeader(cookies, 'https://example.com/app/page', now)).toBe(
			'a=deep; a=root; secure=s',
		);
		expect(cookieHeader(cookies, 'http://example.com/app/page', now)).toBe('a=deep; a=root');
	});

	it('stores, replaces and exposes non-HttpOnly cookies to page script', () => {
		const jar = new BrowserCookieJar();
		jar.store('token=one; Path=/', 'https://example.com/');
		jar.store('token=two; Path=/', 'https://example.com/');
		jar.store('secret=hidden; HttpOnly', 'https://example.com/');
		expect(jar.headerFor('https://example.com/')).toBe('token=two; secret=hidden');
		expect(jar.headerFor('https://example.com/', false)).toBe('token=two');
		expect(jar.persisted()).toEqual([]);
	});

	it('persists only cookies with an expiry', () => {
		const jar = new BrowserCookieJar();
		jar.store('short=1; Max-Age=3600', 'https://example.com/');
		jar.store('session=1', 'https://example.com/');
		expect(jar.persisted()).toHaveLength(1);
		expect(jar.persisted()[0]?.name).toBe('short');
	});
});

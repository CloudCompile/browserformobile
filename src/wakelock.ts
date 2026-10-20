/**
 * Keeps the screen awake while a download is running.
 *
 * On Android the WebView is suspended when the screen turns off, which stops a
 * download mid-episode: the process is frozen, the network requests stall, and
 * on a long episode the OS may reclaim the app entirely. A wake lock does not
 * make the download faster, it stops it dying when the user puts the phone down.
 *
 * The Screen Wake Lock API is Chromium-only, so this is a no-op on iOS and on
 * any WebView without it. A lock is also dropped whenever the page is hidden,
 * so it has to be re-acquired when the view becomes visible again.
 */

/** The subset of the Screen Wake Lock API this module uses. */
interface WakeLockSentinel {
        released: boolean;
        release(): Promise<void>;
        addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockApi {
        request(type: 'screen'): Promise<WakeLockSentinel>;
}

function wakeLockApi(): WakeLockApi | null {
        const nav = navigator as Navigator & { wakeLock?: WakeLockApi };
        return nav.wakeLock ?? null;
}

/**
 * Holds at most one screen wake lock while there is something to keep awake.
 * Callers `acquire()` when work starts and `release()` when it stops; the
 * reference count means several downloads share a single lock.
 */
export class ScreenWakeLock {
        private sentinel: WakeLockSentinel | null = null;
        private wanted = 0;
        private listenerAttached = false;
        private disposed = false;
        /**
         * The request currently in flight, if any. `acquire()` can be called
         * several times before the first request resolves — concurrent downloads
         * start together — and without this each call would issue its own
         * request, leaving all but the last lock untracked and so never released.
         */
        private pending: Promise<void> | null = null;

        /**
         * The document is resolved lazily rather than defaulted in the parameter
         * list: a default of the global `document` is evaluated when the lock is
         * constructed, which throws anywhere without a DOM (a Node harness, a
         * non-browser context) even when no lock is ever taken.
         */
        constructor(private readonly doc?: Document) {}

        private get target(): Document {
                return this.doc ?? document;
        }

        /** Ask for the lock, keeping it until the matching `release()`. */
        acquire(): void {
                this.wanted++;
                if (!this.listenerAttached) {
                        this.listenerAttached = true;
                        // The browser drops the lock when the page is hidden and
                        // does not restore it, so re-request on return.
                        this.target.addEventListener('visibilitychange', this.onVisibility);
                }
                void this.ensure();
        }

        /** Drop one hold; the lock is released when none are left. */
        release(): void {
                if (this.wanted > 0) this.wanted--;
                if (this.wanted === 0) void this.drop();
        }

        /** Release everything and stop listening. Safe to call twice. */
        dispose(): void {
                this.disposed = true;
                this.wanted = 0;
                if (this.listenerAttached) {
                        this.target.removeEventListener('visibilitychange', this.onVisibility);
                        this.listenerAttached = false;
                }
                void this.drop();
        }

        private readonly onVisibility = (): void => {
                if (this.disposed || this.wanted === 0) return;
                if (this.target.visibilityState === 'visible') void this.ensure();
        };

        private async ensure(): Promise<void> {
                if (this.disposed || this.wanted === 0) return;
                if (this.sentinel && !this.sentinel.released) return;
                // Coalesce concurrent acquires onto one in-flight request.
                if (this.pending) return this.pending;
                this.pending = this.requestLock();
                try {
                        await this.pending;
                } finally {
                        this.pending = null;
                }
        }

        private async requestLock(): Promise<void> {
                const api = wakeLockApi();
                if (!api) return;
                try {
                        const sentinel = await api.request('screen');
                        // A release may have raced the await: if the lock is no
                        // longer wanted, hand it straight back.
                        if (this.disposed || this.wanted === 0) {
                                void sentinel.release();
                                return;
                        }
                        this.sentinel = sentinel;
                        sentinel.addEventListener('release', () => {
                                if (this.sentinel === sentinel) this.sentinel = null;
                        });
                } catch {
                        // Denied, unsupported, or the page is hidden. Not fatal:
                        // the download still runs, it just may not survive sleep.
                }
        }

        private async drop(): Promise<void> {
                const sentinel = this.sentinel;
                this.sentinel = null;
                if (!sentinel || sentinel.released) return;
                try {
                        await sentinel.release();
                } catch {
                        /* Already gone. */
                }
        }
}

/**
 * Per-site storage for pages rendered in the browser's `srcdoc` frame.
 *
 * The frame inherits the app's origin, so its `localStorage`, `sessionStorage`
 * and `indexedDB` are Obsidian's. Every site would otherwise share one store
 * with the app and with each other. This module gives each page a namespaced
 * view of the real stores: keys and database names carry the page's origin, so
 * a page reads and writes only its own data, while the WebView keeps handling
 * quotas, structured clone, transactions, indexes and cursors.
 *
 * `browserStorageScript` is serialised with `toString()` and injected into the
 * document, so it may only use its own parameters and browser globals: a
 * closure over this module would not survive the injection. It runs before any
 * page script. The same views are installed into same-origin child frames and
 * blob workers, so a nested realm cannot reach the app's unprefixed store
 * either.
 */

/** Prefixes the page script needs, computed where the page URL is known. */
export interface BrowserStorageConfig {
	/** The page's origin, or `other` when it has none. */
	origin: string;
	/** The page URL, reported by the synthetic `storage` event. */
	url: string;
	/** Key prefix for `localStorage`; shared by every tab of the site. */
	local: string;
	/** Key prefix for `sessionStorage`; includes the tab. */
	session: string;
	/** Database-name prefix for `IndexedDB`. */
	idb: string;
}

/** The version marker in every key and database name this plugin owns. */
export const STORAGE_PREFIX = 'bfm:v1';

/**
 * A stable label for a page. The origin, not the host: ports and schemes are
 * part of a browser origin, and two origins must never share storage.
 */
export function storageOrigin(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
	} catch {
		/* A srcdoc or blob page has no origin of its own. */
	}
	return 'other';
}

/**
 * The three prefixes for one page. `session` is the plugin run and `tab` is the
 * browser tab, so two tabs of one site get separate `sessionStorage` while
 * sharing `localStorage`, the way a browser does.
 */
export function storagePrefixes(url: string, session: string, tab: string): BrowserStorageConfig {
	const origin = storageOrigin(url);
	return {
		origin,
		url,
		local: `${STORAGE_PREFIX}:l:${origin}:`,
		session: `${STORAGE_PREFIX}:s:${origin}:${session}:${tab}:`,
		idb: `${STORAGE_PREFIX}:i:${origin}:`,
	};
}

/** The part of `value` that follows `prefix`, or null when it is foreign. */
export function stripPrefix(prefix: string, value: string): string | null {
	return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

/**
 * Installs the scoped views. Serialised, so it must stay self-contained.
 */
export function browserStorageScript(cfg: BrowserStorageConfig): void {
	const patchedDocuments = new WeakSet<Document>();
	const patchedPrototypes = new WeakSet<object>();
	const patchedFactories = new WeakSet<object>();
	const watchedFrames = new WeakSet<Element>();
	const wrappedConstructors = new WeakSet<object>();
	const relayedWindows = new WeakSet<Window>();
	// Prepended to a child frame's srcdoc so its own scripts start after the shim.
	const SRCDOC_HOOK = '<script>try{parent.__bfmStorageInstall(window)}catch(e){}</script>';
	// A view carries the prefix it serves. A srcdoc navigation keeps the Window,
	// so the next install must recognise its own view instead of layering a
	// second prefix on top of it. The native store is never exposed.
	const VIEW = Symbol.for('bfm.storage.view');
	let readingFrame = false;

	/** A store that accepts writes, or null for the in-memory fallback. */
	const probe = (storage: Storage | null): Storage | null => {
		if (!storage) return null;
		try {
			// Outside every site prefix, so the probe never reaches a page's events.
			storage.setItem('bfm:v1:probe:', '1');
			storage.removeItem('bfm:v1:probe:');
			return storage;
		} catch {
			return null;
		}
	};

	/**
	 * A `Storage` view over one prefix. Named properties (`storage.theme`) and
	 * `Object.keys` behave like a browser's, while `clear()` only clears this
	 * site. Without a usable native store the data lives in memory for the life
	 * of the document, which keeps the page working without persisting anything.
	 */
	const makeStorage = (native: Storage | null, prefix: string, prototype: object): Storage => {
		const memory = native ? null : new Map<string, string>();
		const keys = (): string[] => {
			if (!native) {
				const names: string[] = [];
				memory?.forEach((_value, key) => names.push(key));
				return names;
			}
			const names: string[] = [];
			for (let index = 0; index < native.length; index++) {
				const key = native.key(index);
				if (key !== null && key.startsWith(prefix)) names.push(key.slice(prefix.length));
			}
			return names;
		};
		const read = (key: string): string | null => {
			if (native) return native.getItem(prefix + key);
			const value = memory?.get(key);
			return value === undefined ? null : value;
		};
		const write = (key: string, value: string): void => {
			if (native) native.setItem(prefix + key, value);
			else memory?.set(key, value);
		};
		const remove = (key: string): void => {
			if (native) native.removeItem(prefix + key);
			else memory?.delete(key);
		};
		const isMethod = (property: string): boolean =>
			property === 'key' ||
			property === 'getItem' ||
			property === 'setItem' ||
			property === 'removeItem' ||
			property === 'clear';
		const methods: Record<string, unknown> = {
			key: (index: number): string | null => keys()[index] ?? null,
			getItem: (key: string): string | null => read(String(key)),
			setItem: (key: string, value: string): void => write(String(key), String(value)),
			removeItem: (key: string): void => remove(String(key)),
			clear: (): void => {
				for (const key of keys()) remove(key);
			},
		};
		return new Proxy({} as Storage, {
			get: (_target, property) => {
				if (property === Symbol.toStringTag) return 'Storage';
				if (property === VIEW) return prefix;
				if (typeof property !== 'string') return undefined;
				if (property === 'length') return keys().length;
				if (isMethod(property)) return methods[property];
				return read(property) ?? undefined;
			},
			set: (_target, property, value) => {
				if (typeof property === 'string' && property !== 'length' && !isMethod(property)) {
					write(property, String(value));
				}
				return true;
			},
			has: (_target, property) =>
				typeof property === 'string' &&
				(property === 'length' || isMethod(property) || read(property) !== null),
			deleteProperty: (_target, property) => {
				if (typeof property === 'string' && property !== 'length' && !isMethod(property)) {
					remove(property);
				}
				return true;
			},
			ownKeys: () => keys(),
			getOwnPropertyDescriptor: (_target, property) => {
				if (typeof property !== 'string' || property === 'length' || isMethod(property)) {
					return undefined;
				}
				const value = read(property);
				return value === null ? undefined : { configurable: true, enumerable: true, writable: true, value };
			},
			defineProperty: (_target, property, descriptor) => {
				if (
					typeof property === 'string' &&
					property !== 'length' &&
					!isMethod(property) &&
					'value' in descriptor
				) {
					write(property, String(descriptor.value));
				}
				return true;
			},
			getPrototypeOf: () => prototype,
		});
	};

	/**
	 * Native storage events fire for the app origin, so they carry Obsidian's
	 * keys and the other sites' keys too. Drop those and hand the page a
	 * `StorageEvent` that looks like the site's own.
	 */
	const relayStorageEvents = (target: Window, localView: Storage, sessionView: Storage): void => {
		if (relayedWindows.has(target)) return;
		relayedWindows.add(target);
		const view = target as Window & typeof window;
		target.addEventListener(
			'storage',
			(storageEvent) => {
				const key = storageEvent.key;
				// The app and other sites share the store; their events are not ours.
				storageEvent.stopImmediatePropagation();
				if (typeof key !== 'string') return;
				const isLocal = key.startsWith(cfg.local);
				const prefix = isLocal ? cfg.local : key.startsWith(cfg.session) ? cfg.session : null;
				if (!prefix) return;
				try {
					view.dispatchEvent(
						new view.StorageEvent('storage', {
							key: key.slice(prefix.length),
							oldValue: storageEvent.oldValue,
							newValue: storageEvent.newValue,
							url: cfg.url,
							storageArea: isLocal ? localView : sessionView,
						}),
					);
				} catch {
					/* A missing StorageEvent constructor is not worth breaking the page. */
				}
			},
			true,
		);
	};

	const prefixOf = (storage: Storage | null): string | null => {
		if (!storage) return null;
		const marker = (storage as unknown as Record<symbol, unknown>)[VIEW];
		return typeof marker === 'string' ? marker : null;
	};

	const installStorages = (target: Window): boolean => {
		const view = target as Window & typeof window;
		let storagePrototype: object = Storage.prototype;
		try {
			storagePrototype = view.Storage.prototype;
		} catch {
			/* Keep the parent realm's prototype. */
		}
		let existingLocal: Storage | null = null;
		let existingSession: Storage | null = null;
		try {
			existingLocal = view.localStorage;
		} catch {
			existingLocal = null;
		}
		try {
			existingSession = view.sessionStorage;
		} catch {
			existingSession = null;
		}
		// This window already carries this site's views; nothing to replace.
		if (prefixOf(existingLocal) === cfg.local && prefixOf(existingSession) === cfg.session) return true;
		// A shim from another site means the Window was reused unexpectedly. Do not
		// wrap it: nesting two prefixes would hide the real store instead of using it.
		const usableLocal = prefixOf(existingLocal) === null ? existingLocal : null;
		const usableSession = prefixOf(existingSession) === null ? existingSession : null;
		const localView = makeStorage(probe(usableLocal), cfg.local, storagePrototype);
		const sessionView = makeStorage(probe(usableSession), cfg.session, storagePrototype);
		try {
			Object.defineProperty(target, 'localStorage', {
				configurable: true,
				enumerable: true,
				get: () => localView,
			});
			Object.defineProperty(target, 'sessionStorage', {
				configurable: true,
				enumerable: true,
				get: () => sessionView,
			});
		} catch {
			return false;
		}
		relayStorageEvents(target, localView, sessionView);
		return true;
	};

	interface MutableFactory {
		open: (this: IDBFactory, name: string, version?: number) => IDBOpenDBRequest;
		deleteDatabase: (this: IDBFactory, name: string) => IDBOpenDBRequest;
		databases?: (this: IDBFactory) => Promise<IDBDatabaseInfo[]>;
	}

	const patchIndexedDb = (target: Window): void => {
		const view = target as Window & typeof window;
		try {
			const proto = view.IDBFactory.prototype;
			if (!proto || patchedFactories.has(proto)) return;
			patchedFactories.add(proto);
			const factory = proto as unknown as MutableFactory;
			const open = factory.open;
			const removeDatabase = factory.deleteDatabase;
			const databases = factory.databases;
			factory.open = function (this: IDBFactory, name: string, version?: number): IDBOpenDBRequest {
				const renamed = cfg.idb + String(name);
				if (arguments.length > 1) return open.call(this, renamed, version as number);
				return open.call(this, renamed);
			};
			factory.deleteDatabase = function (this: IDBFactory, name: string): IDBOpenDBRequest {
				return removeDatabase.call(this, cfg.idb + String(name));
			};
			if (typeof databases === 'function') {
				factory.databases = function (this: IDBFactory): Promise<IDBDatabaseInfo[]> {
					return databases.call(this).then((entries) =>
						entries.flatMap((entry) => {
							const name = entry.name;
							if (typeof name !== 'string' || !name.startsWith(cfg.idb)) return [];
							return [{ ...entry, name: name.slice(cfg.idb.length) }];
						}),
					);
				};
			}
			const descriptor = Object.getOwnPropertyDescriptor(view.IDBDatabase.prototype, 'name');
			if (descriptor?.get) {
				Object.defineProperty(view.IDBDatabase.prototype, 'name', {
					configurable: true,
					enumerable: descriptor.enumerable,
					get(this: IDBDatabase): string {
						const name = String(descriptor.get!.call(this));
						return name.startsWith(cfg.idb) ? name.slice(cfg.idb.length) : name;
					},
				});
			}
		} catch {
			/* A realm without IndexedDB keeps whatever the WebView gives it. */
		}
	};

	const installFrame = (frame: Element): void => {
		if (!frame || frame.tagName !== 'IFRAME') return;
		const element = frame as HTMLIFrameElement;
		watchFrame(element);
		const win = frameWindow(element);
		if (!win) return;
		try {
			void win.document;
		} catch {
			// A frame at another origin owns its storage already.
			return;
		}
		installRealm(win);
	};

	const frameWindow = (frame: HTMLIFrameElement): Window | null => {
		readingFrame = true;
		try {
			return frame.contentWindow;
		} catch {
			return null;
		} finally {
			readingFrame = false;
		}
	};

	const watchFrame = (frame: HTMLIFrameElement): void => {
		if (watchedFrames.has(frame)) return;
		watchedFrames.add(frame);
		try {
			frame.addEventListener('load', () => installFrame(frame));
		} catch {
			/* Detached frames ignore listeners. */
		}
	};

	const patchFrames = (target: Window): void => {
		const view = target as Window & typeof window;
		try {
			const proto = view.HTMLIFrameElement.prototype as unknown as Record<string, unknown>;
			if (patchedPrototypes.has(proto)) return;
			patchedPrototypes.add(proto);
			const windowDescriptor = Object.getOwnPropertyDescriptor(proto, 'contentWindow');
			if (windowDescriptor?.get) {
				Object.defineProperty(proto, 'contentWindow', {
					configurable: true,
					enumerable: windowDescriptor.enumerable,
					get(this: HTMLIFrameElement): Window | null {
						const win = windowDescriptor.get!.call(this) as Window | null;
						if (win && !readingFrame) installFrame(this);
						return win;
					},
				});
			}
			const documentDescriptor = Object.getOwnPropertyDescriptor(proto, 'contentDocument');
			if (documentDescriptor?.get) {
				Object.defineProperty(proto, 'contentDocument', {
					configurable: true,
					enumerable: documentDescriptor.enumerable,
					get(this: HTMLIFrameElement): Document | null {
						if (!readingFrame) installFrame(this);
						return documentDescriptor.get!.call(this) as Document | null;
					},
				});
			}
			const srcdocDescriptor = Object.getOwnPropertyDescriptor(proto, 'srcdoc');
			if (srcdocDescriptor?.get && srcdocDescriptor.set) {
				Object.defineProperty(proto, 'srcdoc', {
					configurable: true,
					enumerable: srcdocDescriptor.enumerable,
					get(this: HTMLIFrameElement): string {
						const value = String(srcdocDescriptor.get!.call(this));
						return value.startsWith(SRCDOC_HOOK) ? value.slice(SRCDOC_HOOK.length) : value;
					},
					set(this: HTMLIFrameElement, value: string): void {
						// The child is same-origin: its first script asks this frame's
						// installer for the site's views before the page's own scripts run.
						srcdocDescriptor.set!.call(this, `${SRCDOC_HOOK}${String(value)}`);
					},
				});
			}
		} catch {
			/* Older WebViews expose these prototypes differently. */
		}
	};

	const patchInsertion = (target: Window): void => {
		try {
			const proto = (target as Window & typeof window).Node.prototype as unknown as Record<string, unknown>;
			if (patchedPrototypes.has(proto)) return;
			patchedPrototypes.add(proto);
			const scan = (node: Node): void => {
				if (node.nodeType !== 1) return;
				const element = node as Element;
				if (element.tagName === 'IFRAME') installFrame(element);
				const frames = element.querySelectorAll?.('iframe');
				if (!frames) return;
				for (const frame of Array.from(frames)) installFrame(frame);
			};
			for (const name of ['appendChild', 'insertBefore', 'replaceChild']) {
				const original = proto[name];
				if (typeof original !== 'function') continue;
				const wrapped = function (this: Node, ...args: unknown[]): unknown {
					const result = (original as (...inner: unknown[]) => unknown).apply(this, args);
					for (const argument of args) {
						if (argument && typeof argument === 'object' && (argument as Node).nodeType === 1) {
							scan(argument as Node);
						}
					}
					return result;
				};
				proto[name] = wrapped;
			}
		} catch {
			/* Patching DOM methods is best effort; the observer still runs. */
		}
	};

	const watchMutations = (target: Window): void => {
		try {
			const view = target as Window & typeof window;
			const doc = target.document;
			const observer = new view.MutationObserver((records) => {
				for (const record of records) {
					if (record.type === 'attributes') {
						const element = record.target as Element;
						if (element.tagName === 'IFRAME') installFrame(element);
						continue;
					}
					for (const node of Array.from(record.addedNodes)) {
						if (node.nodeType !== 1) continue;
						const element = node as Element;
						if (element.tagName === 'IFRAME') installFrame(element);
						const frames = element.querySelectorAll?.('iframe');
						if (!frames) continue;
						for (const frame of Array.from(frames)) installFrame(frame);
					}
				}
			});
			observer.observe(doc.documentElement ?? doc, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['src', 'srcdoc'],
			});
			for (const frame of Array.from(doc.querySelectorAll('iframe'))) installFrame(frame);
		} catch {
			/* Without an observer, direct contentWindow access still installs. */
		}
	};

	/** A worker has no `localStorage`, but it does have the app-origin IndexedDB. */
	const workerScope = (settings: { idb: string }): void => {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name');
			if (descriptor?.get) {
				Object.defineProperty(IDBDatabase.prototype, 'name', {
					configurable: true,
					enumerable: descriptor.enumerable,
					get(this: IDBDatabase): string {
						const name = String(descriptor.get!.call(this));
						return name.startsWith(settings.idb) ? name.slice(settings.idb.length) : name;
					},
				});
			}
			const factory = IDBFactory.prototype as unknown as MutableFactory;
			const open = factory.open;
			const removeDatabase = factory.deleteDatabase;
			const databases = factory.databases;
			factory.open = function (this: IDBFactory, name: string, version?: number): IDBOpenDBRequest {
				const renamed = settings.idb + String(name);
				if (arguments.length > 1) return open.call(this, renamed, version as number);
				return open.call(this, renamed);
			};
			factory.deleteDatabase = function (this: IDBFactory, name: string): IDBOpenDBRequest {
				return removeDatabase.call(this, settings.idb + String(name));
			};
			if (typeof databases === 'function') {
				factory.databases = function (this: IDBFactory): Promise<IDBDatabaseInfo[]> {
					return databases.call(this).then((entries) =>
						entries.flatMap((entry) => {
							const name = entry.name;
							if (typeof name !== 'string' || !name.startsWith(settings.idb)) return [];
							return [{ ...entry, name: name.slice(settings.idb.length) }];
						}),
					);
				};
			}
		} catch {
			/* A worker realm without IndexedDB. */
		}
	};

	const installWorkers = (target: Window): void => {
		const view = target as Window & typeof window;
		const NativeWorker = view.Worker;
		if (typeof NativeWorker === 'function' && !wrappedConstructors.has(NativeWorker)) {
			wrappedConstructors.add(NativeWorker);
			const Wrapped = function (this: Worker, url: string | URL, options?: WorkerOptions): Worker {
				const source = String(url);
				// Only blob scripts can be wrapped without changing where a relative
				// import resolves; a site URL cannot load from this origin anyway.
				if (!/^blob:/i.test(source)) return new NativeWorker(url, options);
				const module = Boolean(options && options.type === 'module');
				const body = module
					? `(${workerScope.toString()})(${JSON.stringify({ idb: cfg.idb })});\nimport ${JSON.stringify(source)};`
					: `(${workerScope.toString()})(${JSON.stringify({ idb: cfg.idb })});\nimportScripts(${JSON.stringify(source)});`;
				const blob = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
				try {
					return new NativeWorker(blob, options);
				} catch (error) {
					URL.revokeObjectURL(blob);
					throw error;
				}
			} as unknown as typeof Worker;
			Wrapped.prototype = NativeWorker.prototype;
			try {
				Object.defineProperty(view, 'Worker', {
					configurable: true,
					writable: true,
					value: Wrapped,
				});
			} catch {
				/* A frozen window keeps the native constructor. */
			}
		}
		const NativeShared = view.SharedWorker;
		if (typeof NativeShared === 'function' && !wrappedConstructors.has(NativeShared)) {
			wrappedConstructors.add(NativeShared);
			const Wrapped = function (this: SharedWorker, url: string | URL, options?: string | WorkerOptions): SharedWorker {
				const source = String(url);
				if (!/^blob:/i.test(source)) return new NativeShared(url, options);
				const type = typeof options === 'string' ? options : options?.type;
				const module = type === 'module';
				const body = module
					? `(${workerScope.toString()})(${JSON.stringify({ idb: cfg.idb })});\nimport ${JSON.stringify(source)};`
					: `(${workerScope.toString()})(${JSON.stringify({ idb: cfg.idb })});\nimportScripts(${JSON.stringify(source)});`;
				const blob = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
				try {
					return new NativeShared(blob, options);
				} catch (error) {
					URL.revokeObjectURL(blob);
					throw error;
				}
			} as unknown as typeof SharedWorker;
			Wrapped.prototype = NativeShared.prototype;
			try {
				Object.defineProperty(view, 'SharedWorker', {
					configurable: true,
					writable: true,
					value: Wrapped,
				});
			} catch {
				/* A frozen window keeps the native constructor. */
			}
		}
	};

	const installRealm = (target: Window): void => {
		let doc: Document;
		try {
			doc = target.document;
		} catch {
			return;
		}
		if (!doc || patchedDocuments.has(doc)) return;
		patchedDocuments.add(doc);
		if (!installStorages(target)) return;
		patchIndexedDb(target);
		patchFrames(target);
		patchInsertion(target);
		watchMutations(target);
		installWorkers(target);
		try {
			(target as Window & { __bfmStorageInstall?: (win: Window) => void }).__bfmStorageInstall = (
				win: Window,
			) => installRealm(win);
		} catch {
			/* The page can live without the srcdoc hook. */
		}
	};

	try {
		installRealm(window);
	} catch {
		/* Storage isolation is best effort; the page still loads. */
	}
}

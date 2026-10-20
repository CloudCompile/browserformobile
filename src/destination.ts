import { FileSystemAdapter, Platform, normalizePath } from 'obsidian';

/**
 * Where a download is written.
 *
 * On mobile, plugins can only write inside the vault: Obsidian's mobile adapter
 * exposes no absolute path, and Android 11+ blocks writes to a removable SD
 * card unless the app holds `MANAGE_EXTERNAL_STORAGE`, which Obsidian does not.
 * A folder inside the vault is therefore the only location that works
 * everywhere. On desktop an absolute path outside the vault (for example a
 * mounted SD card) is also supported through Node's `fs`.
 */

export class DownloadWriteError extends Error {}

export interface FileWriter {
        /** Append a chunk. The first call creates the file, unless opened to append. */
        write(chunk: Uint8Array): Promise<void>;
        /** Finish the file. */
        close(): Promise<void>;
        /** Wait for queued writes without treating a failure as fatal. */
        settle(): Promise<void>;
        /** Remove a partial file after a failure or cancellation. */
        abort(): Promise<void>;
}

export interface OpenOptions {
        /** Continue an existing file instead of creating or truncating it. */
        append?: boolean;
}

export interface Destination {
        /** Short description shown in the UI. */
        readonly label: string;
        /** True when paths are absolute rather than vault-relative. */
        readonly isExternal: boolean;
        /** Reject a path the destination cannot represent. */
        validate(path: string): string | null;
        /** The full path a file will be written to, for display. */
        displayPath(path: string): string;
        open(path: string, options?: OpenOptions): Promise<FileWriter>;
        exists(path: string): Promise<boolean>;
        /** Size in bytes, or null when the file does not exist. */
        size(path: string): Promise<number | null>;
        /** Whole-file read, or null when the file does not exist. */
        read(path: string): Promise<Uint8Array | null>;
        /** Replace a file's contents in one write. */
        write(path: string, data: Uint8Array): Promise<void>;
        /** Delete a file, ignoring a missing one. */
        remove(path: string): Promise<void>;
        /** Move a file, replacing any file already at the target. */
        rename(from: string, to: string): Promise<void>;
}

interface NodeRequire {
        (id: string): unknown;
}

interface NodeFs {
        promises: {
                mkdir(path: string, options: { recursive: boolean }): Promise<void>;
                writeFile(path: string, data: Uint8Array): Promise<void>;
                appendFile(path: string, data: Uint8Array): Promise<void>;
                readFile(path: string): Promise<Uint8Array>;
                stat(path: string): Promise<{ size: number }>;
                rename(from: string, to: string): Promise<void>;
                unlink(path: string): Promise<void>;
                access(path: string): Promise<void>;
        };
}

function loadNodeFs(): NodeFs | null {
        if (!Platform.isDesktopApp) return null;
        const req = (window as unknown as { require?: NodeRequire }).require;
        if (!req) return null;
        try {
                return req('node:fs') as NodeFs;
        } catch {
                return null;
        }
}

/** Strip characters that are invalid in a filename on common filesystems. */
export function sanitizeName(name: string): string {
        let cleaned = '';
        for (const char of name) {
                const code = char.codePointAt(0) ?? 0;
                // Control characters and the characters Windows reserves.
                const invalid = code < 0x20 || '<>:"/\\|?*'.includes(char);
                cleaned += invalid ? '_' : char;
        }
        cleaned = cleaned.replace(/\.+$/, '').trim();
        return cleaned || 'untitled';
}

class VaultWriter implements FileWriter {
        private created: boolean;
        /** Serialises writes so an append can never land before the create. */
        private queue: Promise<void> = Promise.resolve();
        private failed = false;

        constructor(
                private readonly adapter: {
                        writeBinary(path: string, data: ArrayBuffer): Promise<void>;
                        appendBinary(path: string, data: ArrayBuffer): Promise<void>;
                        remove(path: string): Promise<void>;
                },
                private readonly path: string,
                append = false,
        ) {
                this.created = append;
        }

        private enqueue(task: () => Promise<void>): Promise<void> {
                const next = this.queue.then(async () => {
                        if (this.failed) return;
                        try {
                                await task();
                        } catch (error) {
                                this.failed = true;
                                throw error;
                        }
                });
                // Keep the chain alive after a rejection so later writes do not
                // surface the same error again.
                this.queue = next.catch(() => undefined);
                return next;
        }

        write(chunk: Uint8Array): Promise<void> {
                const buffer = toArrayBuffer(chunk);
                return this.enqueue(async () => {
                        if (!this.created) {
                                this.created = true;
                                await this.adapter.writeBinary(this.path, buffer);
                                return;
                        }
                        await this.adapter.appendBinary(this.path, buffer);
                });
        }

        async close(): Promise<void> {
                await this.queue;
                if (this.failed) throw new DownloadWriteError('The file could not be written.');
        }

        async settle(): Promise<void> {
                await this.queue.catch(() => undefined);
        }

        async abort(): Promise<void> {
                await this.queue.catch(() => undefined);
                if (!this.created) return;
                try {
                        await this.adapter.remove(this.path);
                } catch {
                        /* The file may never have been created. */
                }
        }
}

class ExternalWriter implements FileWriter {
        private created: boolean;
        private queue: Promise<void> = Promise.resolve();
        private failed = false;

        constructor(
                private readonly fs: NodeFs,
                private readonly path: string,
                append = false,
        ) {
                this.created = append;
        }

        private enqueue(task: () => Promise<void>): Promise<void> {
                const next = this.queue.then(async () => {
                        if (this.failed) return;
                        try {
                                await task();
                        } catch (error) {
                                this.failed = true;
                                throw error;
                        }
                });
                this.queue = next.catch(() => undefined);
                return next;
        }

        write(chunk: Uint8Array): Promise<void> {
                return this.enqueue(async () => {
                        if (!this.created) {
                                this.created = true;
                                await this.fs.promises.writeFile(this.path, chunk);
                                return;
                        }
                        await this.fs.promises.appendFile(this.path, chunk);
                });
        }

        async close(): Promise<void> {
                await this.queue;
                if (this.failed) throw new DownloadWriteError('The file could not be written.');
        }

        async settle(): Promise<void> {
                await this.queue.catch(() => undefined);
        }

        async abort(): Promise<void> {
                await this.queue.catch(() => undefined);
                if (!this.created) return;
                try {
                        await this.fs.promises.unlink(this.path);
                } catch {
                        /* Ignore a missing partial file. */
                }
        }
}

export class VaultDestination implements Destination {
        readonly label: string;
        readonly isExternal = false;

        constructor(
                private readonly adapter: {
                        writeBinary(path: string, data: ArrayBuffer): Promise<void>;
                        appendBinary(path: string, data: ArrayBuffer): Promise<void>;
                        readBinary(path: string): Promise<ArrayBuffer>;
                        remove(path: string): Promise<void>;
                        rename(from: string, to: string): Promise<void>;
                        mkdir(path: string): Promise<void>;
                        exists(path: string): Promise<boolean>;
                        stat(path: string): Promise<{ size: number } | null>;
                },
                private readonly folder: string,
        ) {
                this.label = folder || 'Vault root';
        }

        validate(path: string): string | null {
                if (!path.trim()) return 'Choose a filename.';
                if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
                        return 'Absolute paths are not available on mobile. Use a folder inside the vault.';
                }
                return null;
        }

        /** Resolve a filename against the configured folder. */
        private fullPath(path: string): string {
                return normalizePath(joinPath(this.folder, path));
        }

        displayPath(path: string): string {
                return this.fullPath(path);
        }

        async open(path: string, options?: OpenOptions): Promise<FileWriter> {
                const normalized = this.fullPath(path);
                await this.ensureParents(normalized);
                return new VaultWriter(this.adapter, normalized, options?.append ?? false);
        }

        async exists(path: string): Promise<boolean> {
                try {
                        return await this.adapter.exists(this.fullPath(path));
                } catch {
                        return false;
                }
        }

        async size(path: string): Promise<number | null> {
                try {
                        const stat = await this.adapter.stat(this.fullPath(path));
                        return stat ? stat.size : null;
                } catch {
                        return null;
                }
        }

        async read(path: string): Promise<Uint8Array | null> {
                try {
                        return new Uint8Array(await this.adapter.readBinary(this.fullPath(path)));
                } catch {
                        return null;
                }
        }

        async write(path: string, data: Uint8Array): Promise<void> {
                const normalized = this.fullPath(path);
                await this.ensureParents(normalized);
                await this.adapter.writeBinary(normalized, toArrayBuffer(data));
        }

        async remove(path: string): Promise<void> {
                try {
                        await this.adapter.remove(this.fullPath(path));
                } catch {
                        /* A missing file is not an error. */
                }
        }

        async rename(from: string, to: string): Promise<void> {
                const target = this.fullPath(to);
                await this.ensureParents(target);
                // Obsidian's rename will not replace an existing file, so clear
                // the target first. The final name should not exist, but a stale
                // one must not block finalising a resumed download.
                await this.remove(to);
                await this.adapter.rename(this.fullPath(from), target);
        }

        private async ensureParents(normalizedPath: string): Promise<void> {
                const parts = normalizedPath.split('/');
                parts.pop();
                let current = '';
                for (const part of parts) {
                        current = current ? `${current}/${part}` : part;
                        if (!(await this.adapter.exists(current))) {
                                try {
                                        await this.adapter.mkdir(current);
                                } catch {
                                        /* A concurrent download may have created it. */
                                }
                        }
                }
        }
}

export class ExternalDestination implements Destination {
        readonly label: string;
        readonly isExternal = true;

        constructor(
                private readonly fs: NodeFs,
                private readonly folder: string,
        ) {
                this.label = folder;
        }

        validate(path: string): string | null {
                if (!path.trim()) return 'Choose a filename.';
                return null;
        }

        displayPath(path: string): string {
                return joinPath(this.folder, path);
        }

        async open(path: string, options?: OpenOptions): Promise<FileWriter> {
                const full = joinPath(this.folder, path);
                const parent = full.slice(0, full.lastIndexOf('/'));
                if (parent) await this.fs.promises.mkdir(parent, { recursive: true });
                return new ExternalWriter(this.fs, full, options?.append ?? false);
        }

        async exists(path: string): Promise<boolean> {
                try {
                        await this.fs.promises.access(joinPath(this.folder, path));
                        return true;
                } catch {
                        return false;
                }
        }

        async size(path: string): Promise<number | null> {
                try {
                        const stat = await this.fs.promises.stat(joinPath(this.folder, path));
                        return stat.size;
                } catch {
                        return null;
                }
        }

        async read(path: string): Promise<Uint8Array | null> {
                try {
                        return await this.fs.promises.readFile(joinPath(this.folder, path));
                } catch {
                        return null;
                }
        }

        async write(path: string, data: Uint8Array): Promise<void> {
                const full = joinPath(this.folder, path);
                const parent = full.slice(0, full.lastIndexOf('/'));
                if (parent) await this.fs.promises.mkdir(parent, { recursive: true });
                await this.fs.promises.writeFile(full, data);
        }

        async remove(path: string): Promise<void> {
                try {
                        await this.fs.promises.unlink(joinPath(this.folder, path));
                } catch {
                        /* A missing file is not an error. */
                }
        }

        async rename(from: string, to: string): Promise<void> {
                const target = joinPath(this.folder, to);
                const parent = target.slice(0, target.lastIndexOf('/'));
                if (parent) await this.fs.promises.mkdir(parent, { recursive: true });
                await this.fs.promises.rename(joinPath(this.folder, from), target);
        }
}

function joinPath(folder: string, path: string): string {
        const trimmed = folder.replace(/\/+$/, '');
        const relative = path.replace(/^\/+/, '');
        return trimmed ? `${trimmed}/${relative}` : relative;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export interface DestinationRequest {
        /** True to write outside the vault. Desktop only. */
        external: boolean;
        /** Vault-relative folder, or an absolute folder when `external`. */
        folder: string;
}

/**
 * Build the destination for the current platform. External storage is silently
 * downgraded to the vault when it is unavailable, so a synced setting cannot
 * break the plugin on mobile.
 */
export function createDestination(app: { vault: { adapter: unknown } }, request: DestinationRequest): Destination {
        const folder = request.folder.trim();
        if (request.external && Platform.isDesktopApp) {
                const fs = loadNodeFs();
                if (fs) return new ExternalDestination(fs, folder);
        }
        const adapter = app.vault.adapter as FileSystemAdapter & {
                writeBinary(path: string, data: ArrayBuffer): Promise<void>;
                appendBinary(path: string, data: ArrayBuffer): Promise<void>;
                readBinary(path: string): Promise<ArrayBuffer>;
                remove(path: string): Promise<void>;
                rename(from: string, to: string): Promise<void>;
                mkdir(path: string): Promise<void>;
                exists(path: string): Promise<boolean>;
                stat(path: string): Promise<{ size: number } | null>;
        };
        const vaultRelative = request.external ? '' : folder;
        return new VaultDestination(adapter, vaultRelative);
}

/** Whether an absolute, out-of-vault destination is possible on this platform. */
export function externalStorageAvailable(): boolean {
        return Platform.isDesktopApp && loadNodeFs() !== null;
}

// SPDX-License-Identifier: MIT

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Upper bound for a stored file; usage data for the maximum retention is far smaller. */
export const MAX_STORAGE_BYTES = 32 * 1024 * 1024;

const IO_TIMEOUT_SECONDS = 5;

export const DEFAULT_DIRECTORY = () => GLib.build_filenamev([
    GLib.get_user_data_dir(), 'gnome-resource-monitor']);

export function asyncCall(object, method, finish, args, cancellable) {
    return new Promise((resolve, reject) => {
        let timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            IO_TIMEOUT_SECONDS, () => {
                timeout = 0;
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
        const done = () => {
            if (timeout)
                GLib.Source.remove(timeout);
            timeout = 0;
        };
        try {
            object[method](...args, cancellable, (source, result) => {
                done();
                try {
                    resolve(source[finish](result));
                } catch (error) {
                    reject(error);
                }
            });
        } catch (error) {
            done();
            reject(error);
        }
    });
}

function missing(error) {
    return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

async function ensureDirectory(directory, cancellable) {
    try {
        await asyncCall(directory, 'make_directory_async', 'make_directory_finish',
            [GLib.PRIORITY_DEFAULT], cancellable);
    } catch (error) {
        if (missing(error)) {
            await ensureDirectory(directory.get_parent(), cancellable);
            await ensureDirectory(directory, cancellable);
            return;
        }
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw error;
    }
}

/** All filesystem operations are async; directory/file access is owner-only. */
export class FileBackend {
    constructor(directory = DEFAULT_DIRECTORY(), name = 'usage.json') {
        this.directory = Gio.File.new_for_path(directory);
        this.file = this.directory.get_child(name);
        this._read = null;
        this._operations = new Set();
    }

    async _operation(callback, isRead = false) {
        const cancellable = new Gio.Cancellable();
        this._operations.add(cancellable);
        if (isRead) {
            this.cancelRead();
            this._read = cancellable;
        }
        try {
            return await callback(cancellable);
        } finally {
            this._operations.delete(cancellable);
            if (this._read === cancellable)
                this._read = null;
        }
    }

    cancelRead() {
        this._read?.cancel();
        this._read = null;
    }

    async read() {
        const contents = await this.readBytes();
        return contents === null ? null : new TextDecoder('utf-8', {fatal: true}).decode(contents);
    }

    write(contents) {
        return this.writeBytes(new TextEncoder().encode(contents));
    }

    /** Bounded, cancellable read of the raw file; null when it does not exist. */
    readBytes() {
        return this._operation(async cancellable => {
            let stream;
            try {
                const info = await asyncCall(this.file, 'query_info_async',
                    'query_info_finish', ['standard::size,standard::type',
                        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT],
                    cancellable);
                if (info.get_file_type() !== Gio.FileType.REGULAR ||
                    info.get_size() > MAX_STORAGE_BYTES)
                    throw new Error('Invalid data file');
                stream = await asyncCall(this.file, 'read_async', 'read_finish',
                    [GLib.PRIORITY_DEFAULT], cancellable);
                // Bounded even if the file changes after stat. Read chunks since a
                // single read_bytes_async is allowed to return fewer bytes.
                const chunks = [];
                let size = 0;
                while (size <= MAX_STORAGE_BYTES) {
                    const bytes = await asyncCall(stream, 'read_bytes_async',
                        'read_bytes_finish', [Math.min(65536, MAX_STORAGE_BYTES + 1 - size),
                            GLib.PRIORITY_DEFAULT], cancellable);
                    const data = bytes.get_data();
                    if (!data.length)
                        break;
                    size += data.length;
                    chunks.push(data);
                }
                if (size > MAX_STORAGE_BYTES)
                    throw new Error('Data file too large');
                const contents = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) {
                    contents.set(chunk, offset);
                    offset += chunk.length;
                }
                return contents;
            } catch (error) {
                if (missing(error))
                    return null;
                throw error;
            } finally {
                if (stream) {
                    await asyncCall(stream, 'close_async', 'close_finish',
                        [GLib.PRIORITY_DEFAULT], new Gio.Cancellable());
                }
            }
        }, true);
    }

    writeBytes(bytes) {
        return this._operation(async cancellable => {
            if (bytes.length > MAX_STORAGE_BYTES)
                throw new Error('Data file too large');
            await ensureDirectory(this.directory, cancellable);
            const info = await asyncCall(this.directory, 'query_info_async',
                'query_info_finish', ['standard::type',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT],
                cancellable);
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                throw new Error('Data directory must not be a symlink');
            const attributes = new Gio.FileInfo();
            attributes.set_attribute_uint32('unix::mode', 0o700);
            await asyncCall(this.directory, 'set_attributes_async',
                'set_attributes_finish', [attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    GLib.PRIORITY_DEFAULT], cancellable);
            // This API has no I/O priority argument.
            await asyncCall(this.file, 'replace_contents_bytes_async',
                'replace_contents_finish', [new GLib.Bytes(bytes), null, false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION],
                cancellable);
        });
    }

    remove() {
        return this._operation(async cancellable => {
            try {
                await asyncCall(this.file, 'delete_async', 'delete_finish',
                    [GLib.PRIORITY_DEFAULT], cancellable);
            } catch (error) {
                if (!missing(error))
                    throw error;
            }
        });
    }

    destroy() {
        for (const operation of this._operations)
            operation.cancel();
        this.cancelRead();
    }
}

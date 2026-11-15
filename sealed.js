// SPDX-License-Identifier: MIT

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    chachaState, chachaXor, fromHex, HEADER_BYTES, KEY_BYTES, MAGIC, NONCE_BYTES,
    parseSealed, sameTag, TAG_BYTES, toHex,
} from './cipher.js';
import {asyncCall, DEFAULT_DIRECTORY, FileBackend} from './storage.js';

// About 2 ms of work per slice, so large histories never stall the Shell.
const SLICE_BLOCKS = 4096;
const HMAC_SLICE_BYTES = 1024 * 1024;
const KEY_SCHEMA = 'dev.dileepa.ResourceMonitor.UsageKey';
const KEY_LABEL = 'Resource Monitor data-usage encryption key';
const KEY_ATTRIBUTES = {purpose: 'usage-encryption'};

function nextIdle() {
    return new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/** Cryptographically secure random bytes from the kernel. */
export async function randomBytes(length) {
    const cancellable = new Gio.Cancellable();
    const file = Gio.File.new_for_path('/dev/urandom');
    const stream = await asyncCall(file, 'read_async', 'read_finish',
        [GLib.PRIORITY_DEFAULT], cancellable);
    try {
        const data = (await asyncCall(stream, 'read_bytes_async', 'read_bytes_finish',
            [length, GLib.PRIORITY_DEFAULT], cancellable)).get_data();
        if (data.length !== length)
            throw new Error('Short random read');
        return new Uint8Array(data);
    } finally {
        stream.close(null); // Character device: no blocking filesystem I/O.
    }
}

async function xorSliced(key, nonce, input, output, cancelled) {
    const state = chachaState(key, nonce);
    const blocks = Math.ceil(input.length / 64);
    for (let block = 0; block < blocks; block += SLICE_BLOCKS) {
        if (cancelled())
            throw new Error('Cancelled');
        chachaXor(state, input, output, block, block + SLICE_BLOCKS);
        if (block + SLICE_BLOCKS < blocks)
            await nextIdle();
    }
}

async function hmac(key, bytes, cancelled) {
    const mac = GLib.Hmac.new(GLib.ChecksumType.SHA256, key);
    for (let offset = 0; offset < bytes.length; offset += HMAC_SLICE_BYTES) {
        if (cancelled())
            throw new Error('Cancelled');
        mac.update(bytes.subarray(offset, offset + HMAC_SLICE_BYTES));
        if (offset + HMAC_SLICE_BYTES < bytes.length)
            await nextIdle();
    }
    return mac.get_string();
}

function finish(start, end) {
    return new Promise((resolve, reject) => {
        start((_source, result) => {
            try {
                resolve(end(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

/**
 * Stores the encryption key in the user's default keyring (normally the login
 * keyring, unlocked at login and encrypted with the user's password).
 * libsecret is loaded lazily so a missing library only disables persistence.
 */
export class KeyringKeyStore {
    /**
     * prompt: false never asks the user to unlock the keyring. Data-usage
     * tracking runs in the background and is on by default, so with a locked
     * keyring (for example after automatic login) it waits for the keyring to
     * be unlocked instead of showing an unlock dialog on its own.
     */
    constructor(schemaName = KEY_SCHEMA, label = KEY_LABEL, {prompt = false} = {}) {
        this._schemaName = schemaName;
        this._label = label;
        this._prompt = prompt;
    }

    async _assertUnlocked(Secret) {
        if (this._prompt)
            return;
        const service = await finish(callback => Secret.Service.get(Secret.ServiceFlags.NONE, null, callback),
            result => Secret.Service.get_finish(result));
        const collection = await finish(callback => Secret.Collection.for_alias(service, Secret.COLLECTION_DEFAULT,
            Secret.CollectionFlags.NONE, null, callback), result => Secret.Collection.for_alias_finish(result));
        if (collection?.get_locked())
            throw new Error('Keyring locked');
    }

    async _secret() {
        if (!this._schema) {
            const {default: Secret} = await import('gi://Secret?version=1');
            this._Secret = Secret;
            this._schema = new Secret.Schema(this._schemaName, Secret.SchemaFlags.NONE,
                {purpose: Secret.SchemaAttributeType.STRING});
        }
        return this._Secret;
    }

    async lookup() {
        const Secret = await this._secret();
        await this._assertUnlocked(Secret);
        return finish(callback => Secret.password_lookup(this._schema, KEY_ATTRIBUTES, null, callback),
            result => Secret.password_lookup_finish(result));
    }

    async store(value) {
        const Secret = await this._secret();
        await this._assertUnlocked(Secret);
        return finish(callback => Secret.password_store(this._schema, KEY_ATTRIBUTES,
            Secret.COLLECTION_DEFAULT, this._label, value, null, callback),
        result => Secret.password_store_finish(result));
    }

    async clear() {
        const Secret = await this._secret();
        return finish(callback => Secret.password_clear(this._schema, KEY_ATTRIBUTES, null, callback),
            result => Secret.password_clear_finish(result));
    }
}

/**
 * Encrypted file backend (ChaCha20 + HMAC-SHA256, encrypt-then-MAC, fresh
 * random nonce per save) with a key kept in the keyring. Nothing is ever
 * written unencrypted. read() returns null only when no file exists.
 */
export class SealedBackend {
    constructor({directory = DEFAULT_DIRECTORY(), name = 'usage.sealed',
        keyStore = new KeyringKeyStore(), legacyName = null} = {}) {
        this._sealed = new FileBackend(directory, name);
        this._legacy = legacyName ? new FileBackend(directory, legacyName) : null;
        this._keys = keyStore;
        this._key = null;
        this._readGeneration = 0;
        this._destroyed = false;
        this.directory = this._sealed.directory;
        this.file = this._sealed.file;
    }

    async _getKey(create) {
        if (this._key)
            return this._key;
        const stored = await this._keys.lookup();
        if (stored) {
            const key = fromHex(stored);
            if (key?.length !== KEY_BYTES)
                throw new Error('Invalid encryption key');
            this._key = key;
            return key;
        }
        if (!create)
            return null;
        const key = await randomBytes(KEY_BYTES);
        await this._keys.store(toHex(key));
        this._key = key;
        return key;
    }

    async read() {
        const generation = ++this._readGeneration;
        const cancelled = () => generation !== this._readGeneration || this._destroyed;
        const sealed = await this._sealed.readBytes();
        if (sealed === null)
            return this._legacy?.read() ?? null; // Migrated to the encrypted file on the next save.
        const parts = parseSealed(sealed);
        if (!parts)
            throw new Error('Invalid data file');
        const key = await this._getKey(false);
        if (!key)
            throw new Error('Encryption key unavailable');
        const expected = await hmac(key.subarray(32), parts.authenticated, cancelled);
        if (!sameTag(expected, toHex(parts.tag)))
            throw new Error('Data file failed authentication');
        const plain = new Uint8Array(parts.ciphertext.length);
        await xorSliced(key.subarray(0, 32), parts.nonce, parts.ciphertext, plain, cancelled);
        return new TextDecoder('utf-8', {fatal: true}).decode(plain);
    }

    async write(contents) {
        const key = await this._getKey(true);
        const plain = new TextEncoder().encode(contents);
        const length = HEADER_BYTES + plain.length;
        const file = new Uint8Array(length + TAG_BYTES);
        const nonce = await randomBytes(NONCE_BYTES);
        file.set(MAGIC);
        file.set(nonce, MAGIC.length);
        // Writes are drained even during teardown, so they are never cancelled.
        await xorSliced(key.subarray(0, 32), nonce, plain, file.subarray(HEADER_BYTES, length), () => false);
        file.set(fromHex(await hmac(key.subarray(32), file.subarray(0, length), () => false)), length);
        await this._sealed.writeBytes(file);
        await this._legacy?.remove();
    }

    async remove() {
        await this._sealed.remove();
        await this._legacy?.remove();
        // Also forget the key so stray copies of old files (for example in
        // backups) can no longer be decrypted. Best effort: the files are gone.
        this._key = null;
        try {
            await this._keys.clear();
        } catch {}
    }

    cancelRead() {
        this._readGeneration++;
        this._sealed.cancelRead();
        this._legacy?.cancelRead();
    }

    destroy() {
        this._destroyed = true;
        this._key = null;
        this._sealed.destroy();
        this._legacy?.destroy();
    }
}

// SPDX-License-Identifier: MIT

/*
 * ChaCha20 (RFC 8439) and the sealed data file layout. Pure JavaScript so it
 * is testable without GNOME libraries; authentication (HMAC-SHA256) and key
 * storage live in sealed.js.
 *
 * File layout: MAGIC (8) | nonce (12) | ciphertext | HMAC-SHA256 tag (32).
 * The tag covers MAGIC, nonce, and ciphertext (encrypt-then-MAC).
 */

export const MAGIC = new Uint8Array([0x47, 0x43, 0x4D, 0x53, 0x45, 0x41, 0x4C, 0x31]); // "GCMSEAL1"
export const KEY_BYTES = 64; // 32-byte ChaCha20 key followed by a 32-byte HMAC key.
export const NONCE_BYTES = 12;
export const TAG_BYTES = 32;
export const HEADER_BYTES = MAGIC.length + NONCE_BYTES;
export const BLOCK_BYTES = 64;

const SIGMA = [0x61707865, 0x3320646E, 0x79622D32, 0x6B206574];

function word(bytes, offset) {
    return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 |
        bytes[offset + 3] << 24) >>> 0;
}

/** Initial ChaCha20 state for a key/nonce; the counter word (12) is set per block. */
export function chachaState(key, nonce) {
    if (key.length !== 32 || nonce.length !== NONCE_BYTES)
        throw new Error('Invalid ChaCha20 key or nonce');
    const state = new Uint32Array(16);
    state.set(SIGMA);
    for (let index = 0; index < 8; index++)
        state[4 + index] = word(key, index * 4);
    for (let index = 0; index < 3; index++)
        state[13 + index] = word(nonce, index * 4);
    return state;
}

/**
 * XOR blocks [fromBlock, toBlock) of `input` with the keystream into `output`.
 * Block n uses counter `initialCounter + n`. Callers may process a large buffer
 * in slices so the Shell main loop is not blocked for long. The rounds are
 * written out with local variables because that is several times faster in
 * GJS than a generic quarter-round helper.
 */
export function chachaXor(state, input, output, fromBlock, toBlock, initialCounter = 1) {
    const s0 = state[0] | 0;
    const s1 = state[1] | 0;
    const s2 = state[2] | 0;
    const s3 = state[3] | 0;
    const s4 = state[4] | 0;
    const s5 = state[5] | 0;
    const s6 = state[6] | 0;
    const s7 = state[7] | 0;
    const s8 = state[8] | 0;
    const s9 = state[9] | 0;
    const s10 = state[10] | 0;
    const s11 = state[11] | 0;
    const s13 = state[13] | 0;
    const s14 = state[14] | 0;
    const s15 = state[15] | 0;
    const out = new Int32Array(16);
    const stream = new Uint8Array(out.buffer);
    const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    const last = Math.min(toBlock, Math.ceil(input.length / BLOCK_BYTES));
    for (let block = fromBlock; block < last; block++) {
        const s12 = initialCounter + block | 0;
        let x0 = s0;
        let x1 = s1;
        let x2 = s2;
        let x3 = s3;
        let x4 = s4;
        let x5 = s5;
        let x6 = s6;
        let x7 = s7;
        let x8 = s8;
        let x9 = s9;
        let x10 = s10;
        let x11 = s11;
        let x12 = s12;
        let x13 = s13;
        let x14 = s14;
        let x15 = s15;
        for (let round = 0; round < 10; round++) {
            x0 = x0 + x4 | 0; x12 ^= x0; x12 = x12 << 16 | x12 >>> 16;
            x8 = x8 + x12 | 0; x4 ^= x8; x4 = x4 << 12 | x4 >>> 20;
            x0 = x0 + x4 | 0; x12 ^= x0; x12 = x12 << 8 | x12 >>> 24;
            x8 = x8 + x12 | 0; x4 ^= x8; x4 = x4 << 7 | x4 >>> 25;
            x1 = x1 + x5 | 0; x13 ^= x1; x13 = x13 << 16 | x13 >>> 16;
            x9 = x9 + x13 | 0; x5 ^= x9; x5 = x5 << 12 | x5 >>> 20;
            x1 = x1 + x5 | 0; x13 ^= x1; x13 = x13 << 8 | x13 >>> 24;
            x9 = x9 + x13 | 0; x5 ^= x9; x5 = x5 << 7 | x5 >>> 25;
            x2 = x2 + x6 | 0; x14 ^= x2; x14 = x14 << 16 | x14 >>> 16;
            x10 = x10 + x14 | 0; x6 ^= x10; x6 = x6 << 12 | x6 >>> 20;
            x2 = x2 + x6 | 0; x14 ^= x2; x14 = x14 << 8 | x14 >>> 24;
            x10 = x10 + x14 | 0; x6 ^= x10; x6 = x6 << 7 | x6 >>> 25;
            x3 = x3 + x7 | 0; x15 ^= x3; x15 = x15 << 16 | x15 >>> 16;
            x11 = x11 + x15 | 0; x7 ^= x11; x7 = x7 << 12 | x7 >>> 20;
            x3 = x3 + x7 | 0; x15 ^= x3; x15 = x15 << 8 | x15 >>> 24;
            x11 = x11 + x15 | 0; x7 ^= x11; x7 = x7 << 7 | x7 >>> 25;
            x0 = x0 + x5 | 0; x15 ^= x0; x15 = x15 << 16 | x15 >>> 16;
            x10 = x10 + x15 | 0; x5 ^= x10; x5 = x5 << 12 | x5 >>> 20;
            x0 = x0 + x5 | 0; x15 ^= x0; x15 = x15 << 8 | x15 >>> 24;
            x10 = x10 + x15 | 0; x5 ^= x10; x5 = x5 << 7 | x5 >>> 25;
            x1 = x1 + x6 | 0; x12 ^= x1; x12 = x12 << 16 | x12 >>> 16;
            x11 = x11 + x12 | 0; x6 ^= x11; x6 = x6 << 12 | x6 >>> 20;
            x1 = x1 + x6 | 0; x12 ^= x1; x12 = x12 << 8 | x12 >>> 24;
            x11 = x11 + x12 | 0; x6 ^= x11; x6 = x6 << 7 | x6 >>> 25;
            x2 = x2 + x7 | 0; x13 ^= x2; x13 = x13 << 16 | x13 >>> 16;
            x8 = x8 + x13 | 0; x7 ^= x8; x7 = x7 << 12 | x7 >>> 20;
            x2 = x2 + x7 | 0; x13 ^= x2; x13 = x13 << 8 | x13 >>> 24;
            x8 = x8 + x13 | 0; x7 ^= x8; x7 = x7 << 7 | x7 >>> 25;
            x3 = x3 + x4 | 0; x14 ^= x3; x14 = x14 << 16 | x14 >>> 16;
            x9 = x9 + x14 | 0; x4 ^= x9; x4 = x4 << 12 | x4 >>> 20;
            x3 = x3 + x4 | 0; x14 ^= x3; x14 = x14 << 8 | x14 >>> 24;
            x9 = x9 + x14 | 0; x4 ^= x9; x4 = x4 << 7 | x4 >>> 25;
        }
        out[0] = x0 + s0 | 0;
        out[1] = x1 + s1 | 0;
        out[2] = x2 + s2 | 0;
        out[3] = x3 + s3 | 0;
        out[4] = x4 + s4 | 0;
        out[5] = x5 + s5 | 0;
        out[6] = x6 + s6 | 0;
        out[7] = x7 + s7 | 0;
        out[8] = x8 + s8 | 0;
        out[9] = x9 + s9 | 0;
        out[10] = x10 + s10 | 0;
        out[11] = x11 + s11 | 0;
        out[12] = x12 + s12 | 0;
        out[13] = x13 + s13 | 0;
        out[14] = x14 + s14 | 0;
        out[15] = x15 + s15 | 0;
        if (!littleEndian) {
            for (let index = 0; index < 16; index++) {
                const value = out[index];
                stream[index * 4] = value & 255;
                stream[index * 4 + 1] = value >>> 8 & 255;
                stream[index * 4 + 2] = value >>> 16 & 255;
                stream[index * 4 + 3] = value >>> 24;
            }
        }
        const offset = block * BLOCK_BYTES;
        const end = Math.min(BLOCK_BYTES, input.length - offset);
        for (let index = 0; index < end; index++)
            output[offset + index] = input[offset + index] ^ stream[index];
    }
}

export function hasMagic(bytes) {
    return bytes.length >= MAGIC.length && MAGIC.every((value, index) => bytes[index] === value);
}

/** Split a sealed file into its parts, or return null if it is not one. */
export function parseSealed(bytes) {
    if (!hasMagic(bytes) || bytes.length < HEADER_BYTES + TAG_BYTES)
        return null;
    return {
        nonce: bytes.subarray(MAGIC.length, HEADER_BYTES),
        authenticated: bytes.subarray(0, bytes.length - TAG_BYTES),
        ciphertext: bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES),
        tag: bytes.subarray(bytes.length - TAG_BYTES),
    };
}

/** Constant-time comparison for equal-length tag strings. */
export function sameTag(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length)
        return false;
    let difference = 0;
    for (let index = 0; index < a.length; index++)
        difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return difference === 0;
}

export function toHex(bytes) {
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export function fromHex(text) {
    if (typeof text !== 'string' || text.length % 2 || /[^0-9a-f]/i.test(text))
        return null;
    const bytes = new Uint8Array(text.length / 2);
    for (let index = 0; index < bytes.length; index++)
        bytes[index] = parseInt(text.slice(index * 2, index * 2 + 2), 16);
    return bytes;
}

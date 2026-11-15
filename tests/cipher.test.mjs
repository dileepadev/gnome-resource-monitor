// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {chachaState, chachaXor, fromHex, MAGIC, parseSealed, sameTag, TAG_BYTES, toHex} from '../cipher.js';

test('ChaCha20 matches the RFC 8439 section 2.4.2 encryption vector', () => {
    const key = Uint8Array.from({length: 32}, (_, index) => index);
    const nonce = fromHex('000000000000004a00000000');
    const plaintext = new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const output = new Uint8Array(plaintext.length);
    chachaXor(chachaState(key, nonce), plaintext, output, 0, Infinity, 1);
    assert.equal(toHex(output),
        '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b' +
        'f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8' +
        '07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736' +
        '5af90bbf74a35be6b40b8eedf2785e42874d');
    const back = new Uint8Array(output.length);
    chachaXor(chachaState(key, nonce), output, back, 0, Infinity, 1);
    assert.deepEqual(back, plaintext);
});

test('sliced ChaCha20 processing equals a single pass', () => {
    const key = Uint8Array.from({length: 32}, (_, index) => 255 - index);
    const nonce = new Uint8Array(12).fill(7);
    const input = Uint8Array.from({length: 1000}, (_, index) => index * 31 & 255);
    const whole = new Uint8Array(input.length);
    const sliced = new Uint8Array(input.length);
    chachaXor(chachaState(key, nonce), input, whole, 0, Infinity);
    const state = chachaState(key, nonce);
    for (let block = 0; block < 16; block += 3)
        chachaXor(state, input, sliced, block, block + 3);
    assert.deepEqual(sliced, whole);
    assert.throws(() => chachaState(new Uint8Array(16), nonce));
});

test('sealed layout parsing, hex helpers, and constant-time tag comparison', () => {
    const file = new Uint8Array(MAGIC.length + 12 + 5 + TAG_BYTES);
    file.set(MAGIC);
    const parts = parseSealed(file);
    assert.equal(parts.nonce.length, 12);
    assert.equal(parts.ciphertext.length, 5);
    assert.equal(parts.tag.length, TAG_BYTES);
    assert.equal(parts.authenticated.length, file.length - TAG_BYTES);
    assert.equal(parseSealed(file.subarray(0, 40)), null);
    assert.equal(parseSealed(new TextEncoder().encode('{"version":2,"entries":[]}'.padEnd(60))), null);
    assert.equal(sameTag('abcd', 'abcd'), true);
    assert.equal(sameTag('abcd', 'abce'), false);
    assert.equal(sameTag('abcd', 'abc'), false);
    assert.equal(fromHex('zz'), null);
    assert.equal(fromHex('abc'), null);
    assert.equal(toHex(fromHex('00ff10')), '00ff10');
});

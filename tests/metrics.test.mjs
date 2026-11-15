// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseCPU, cpuUsage, parseRAM, parseNetwork, networkUsage, formatSpeed, formatPercent, percentSamples, speedSamples, fillTemplate} from '../metrics.js';

test('CPU excludes guest fields, includes steal, and primes the first sample', () => {
    const sample = parseCPU('cpu  10 20 30 40 5 6 7 8 9 10\ncpu0 0');
    assert.deepEqual(sample, {total: 126, idle: 45});
    assert.equal(cpuUsage(null, sample), null);
    assert.equal(cpuUsage({total: 100, idle: 40}, {total: 200, idle: 65}), 75);
    assert.equal(cpuUsage(sample, sample), null);
    assert.equal(cpuUsage(sample, {total: 1, idle: 1}), null);
    assert.equal(parseCPU('cpu invalid'), null);
});

test('RAM requires usable totals and available memory', () => {
    assert.equal(parseRAM('MemTotal: 100 kB\nMemAvailable: 25 kB'), 75);
    for (const text of ['', 'MemTotal: 0 kB\nMemAvailable: 0 kB', 'MemTotal: 10 kB\nMemAvailable: 20 kB'])
        assert.equal(parseRAM(text), null);
});

const net = rows => parseNetwork(`header\nheader\n${rows.map(([name, recv, sent]) => `${name}: ${recv} 0 0 0 0 0 0 0 ${sent} 0 0 0 0 0 0 0`).join('\n')}`);

test('network excludes only loopback and ignores new, removed, and reset interfaces', () => {
    const before = net([['lo', 1000, 1000], ['wlan0', 100, 200], ['old', 1000, 1000], ['reset', 200, 200]]);
    const after = net([['lo', 9999, 9999], ['wlan0', 300, 600], ['new', 9999, 9999], ['reset', 10, 10], ['hello', 0, 0]]);
    assert.equal(after.has('lo'), false);
    assert.equal(after.has('hello'), true);
    assert.deepEqual(networkUsage(before, after, 2), {recvRate: 100, sentRate: 200});
    assert.equal(networkUsage(null, after, 1), null);
    assert.equal(networkUsage(before, after, 0), null);
    assert.equal(parseNetwork('header\nheader\nbroken'), null);
});

test('speed formatting uses at most three significant digits and binary units', () => {
    assert.equal(formatSpeed(undefined), '—');
    assert.equal(formatSpeed(-1), '—');
    assert.equal(formatSpeed(0), '0 B/s');
    assert.equal(formatSpeed(86.04), '86 B/s');
    assert.equal(formatSpeed(999.4), '999 B/s');
    assert.equal(formatSpeed(999.5), '0.98 KiB/s');
    assert.equal(formatSpeed(1023), '1.00 KiB/s');
    assert.equal(formatSpeed(1024), '1.00 KiB/s');
    assert.equal(formatSpeed(9.994 * 1024), '9.99 KiB/s');
    assert.equal(formatSpeed(9.995 * 1024), '10.0 KiB/s');
    assert.equal(formatSpeed(99.94 * 1024), '99.9 KiB/s');
    assert.equal(formatSpeed(99.95 * 1024), '100 KiB/s');
    assert.equal(formatSpeed(999.4 * 1024), '999 KiB/s');
    assert.equal(formatSpeed(999.5 * 1024), '0.98 MiB/s');
    assert.equal(formatSpeed(1024 ** 2), '1.00 MiB/s');
    assert.equal(formatSpeed(1024 ** 3), '1.00 GiB/s');
    assert.equal(formatSpeed(999 * 1024 ** 4), '999 TiB/s');
});

test('reserved-width samples cover every shape the formatters produce', () => {
    const shape = text => text.replace(/[0-9]/g, '0');
    const speedShapes = new Set(speedSamples().map(shape));
    const percentShapes = new Set(percentSamples().map(shape));
    // Sweep many magnitudes, including every rounding boundary region.
    for (let exponent = -2; exponent <= 42; exponent += 0.01) {
        const value = 2 ** exponent;
        assert.ok(speedShapes.has(shape(formatSpeed(value))), formatSpeed(value));
    }
    assert.ok(speedShapes.has(shape(formatSpeed(0))));
    assert.ok(speedShapes.has(shape(formatSpeed(NaN))));
    for (let percent = -5; percent <= 105; percent += 0.01)
        assert.ok(percentShapes.has(shape(formatPercent(percent))), formatPercent(percent));
    assert.equal(formatPercent(null), '—');
    assert.equal(formatPercent(100.04), '100.0%');
    assert.equal(formatPercent(17.25), '17.3%');
});

test('templates are filled in one pass, so inserted values are never substituted again', () => {
    assert.equal(fillTemplate('%s (%d)', 'a%db', 3), 'a%db (3)');
    assert.equal(fillTemplate('%d%% of %s', 42, '50 GiB'), '42% of 50 GiB');
    assert.equal(fillTemplate('↓ %s  ↑ %s', '%s', 'x'), '↓ %s  ↑ x');
    assert.equal(fillTemplate('%s and %s', 'one'), 'one and ');
});

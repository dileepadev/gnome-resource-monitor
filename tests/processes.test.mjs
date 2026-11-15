// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {pageSizeFrom, parseProcessStat, parseSockets, rankNetwork, rankProcesses} from '../processes.js';
import {downsample, niceMax, Series} from '../series.js';

const stat = (pid, name, utime, stime, rss) =>
    `${pid} (${name}) S 1 1 1 0 -1 4194560 100 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 100 1000 ${rss} 18446744073709551615`;

test('process stat parsing handles names with spaces and parentheses', () => {
    assert.deepEqual(parseProcessStat(stat(42, 'Web Content', 10, 5, 300)), {name: 'Web Content', ticks: 15, rssPages: 300});
    assert.deepEqual(parseProcessStat(stat(7, 'odd) (name', 1, 2, 3)), {name: 'odd) (name', ticks: 3, rssPages: 3});
    assert.equal(parseProcessStat('garbage'), null);
    assert.equal(parseProcessStat('1 (x) S 1'), null);
    assert.equal(parseProcessStat(undefined), null);
});

test('ranking uses CPU-time deltas against total CPU time and resident memory', () => {
    const previous = new Map([[1, {name: 'a', ticks: 100, rssPages: 10}], [2, {name: 'b', ticks: 50, rssPages: 0}],
        [3, {name: 'old', ticks: 500, rssPages: 5}]]);
    const current = new Map([[1, {name: 'a', ticks: 150, rssPages: 10}], [2, {name: 'b', ticks: 60, rssPages: 0}],
        [3, {name: 'reused', ticks: 10, rssPages: 5}], [4, {name: 'new', ticks: 999, rssPages: 100}]]);
    const ranked = rankProcesses(previous, current, 200, 4096, 5);
    assert.deepEqual(ranked.cpu.map(process => [process.name, process.percent]), [['a', 25], ['b', 5]]);
    assert.deepEqual(ranked.memory.map(process => [process.name, process.bytes]),
        [['new', 409600], ['a', 40960], ['reused', 20480]]);
    assert.equal(ranked.primed, true);
    const first = rankProcesses(null, current, 0, 4096);
    assert.equal(first.cpu.length, 0);
    assert.equal(first.primed, false);
    assert.equal(rankProcesses(previous, current, 200, 4096, 1).memory.length, 1);
});

test('processes with the same name are grouped with a count', () => {
    const previous = new Map([[10, {name: 'code', ticks: 0, rssPages: 1}], [11, {name: 'code', ticks: 0, rssPages: 1}],
        [12, {name: 'bash', ticks: 0, rssPages: 1}]]);
    const current = new Map([[10, {name: 'code', ticks: 10, rssPages: 100}], [11, {name: 'code', ticks: 30, rssPages: 50}],
        [12, {name: 'bash', ticks: 5, rssPages: 400}]]);
    const ranked = rankProcesses(previous, current, 100, 1024);
    assert.deepEqual(ranked.cpu[0], {pid: 11, name: 'code', count: 2, percent: 40});
    assert.deepEqual(ranked.memory.map(group => [group.name, group.count, group.bytes, group.pid]),
        [['bash', 1, 409600, 12], ['code', 2, 153600, 10]]);
});

test('page size is derived from VmRSS and resident pages', () => {
    assert.equal(pageSizeFrom('VmRSS:\t    8192 kB\n', '5000 2048 100'), 4096);
    assert.equal(pageSizeFrom('VmRSS:\t   32000 kB\n', '5000 2000 100'), 16384);
    assert.equal(pageSizeFrom('', ''), 4096);
});

test('series keeps the newest values and downsampling preserves gaps', () => {
    const series = new Series(5);
    for (const value of [1, 2, 3, 4, 5, 6, NaN])
        series.push(value);
    assert.deepEqual(series.last(5), [3, 4, 5, 6, null]);
    assert.deepEqual(series.last(2), [6, null]);
    assert.deepEqual(new Series(3).last(3), [null, null, null]);
    assert.deepEqual(downsample([1, 3, null, null, 5, 7], 3), [2, null, 6]);
    assert.deepEqual(downsample([1, 2], 4), [1, 1, 2, 2]);
    assert.deepEqual(downsample([], 0), []);
    assert.equal(niceMax([0, 1500]), 2048);
    assert.equal(niceMax([null, 3_000_000]), 5 * 1024 ** 2);
    assert.equal(niceMax([]), 1024);
    assert.equal(niceMax([900 * 1024]), 1024 ** 2);
    assert.equal(niceMax([1023.9 * 1024 ** 2]), 1024 ** 3);
});

test('ss socket output is parsed and ranked by network rate per app', () => {
    const sample = (codeIn, braveIn) => `ESTAB 0 0 10.0.0.2:1000 1.1.1.1:443 users:(("code",pid=10,fd=3))
\t cubic bytes_sent:500 bytes_acked:400 bytes_received:${codeIn} segs_out:1
ESTAB 0 0 10.0.0.2:1001 2.2.2.2:443 users:(("code",pid=11,fd=4))
\t cubic bytes_acked:100 bytes_received:${codeIn}
ESTAB 0 0 10.0.0.2:1002 3.3.3.3:443 users:(("brave",pid=20,fd=5),("brave",pid=21,fd=5))
\t cubic bytes_acked:50 bytes_received:${braveIn}
LISTEN 0 4096 127.0.0.1:631 0.0.0.0:*
`;
    const first = parseSockets(sample(1000, 500));
    assert.equal(first.size, 3);
    assert.deepEqual(first.get('10.0.0.2:1002 3.3.3.3:443 20'), {name: 'brave', pid: 20, sent: 50, received: 500});
    const second = parseSockets(sample(3000, 600) + `ESTAB 0 0 10.0.0.2:1003 4.4.4.4:443 users:(("new",pid=30,fd=6))
\t bytes_acked:999999 bytes_received:999999
`);
    const ranked = rankNetwork(first, second, 2);
    assert.equal(ranked.primed, true);
    assert.deepEqual(ranked.apps, [
        {name: 'code', pid: 10, rx: 2000, tx: 0, count: 2},
        {name: 'brave', pid: 20, rx: 50, tx: 0, count: 1},
    ]);
    assert.deepEqual(rankNetwork(null, second, 2), {apps: [], primed: false});
    // Reset counters (a reused address) are skipped rather than reported as spikes.
    assert.deepEqual(rankNetwork(second, first, 2).apps, []);
    assert.equal(parseSockets(undefined).size, 0);
});

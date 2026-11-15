// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {classifyInterface, formatBytes, networkDeltas} from '../metrics.js';
import {addDays, capLevel, cycleOf, isDay, UsageModel, weekStartOf} from '../usage.js';

const MiB = 1024 ** 2;

test('calendar helpers handle weeks, billing cycles, leap years, and year boundaries', () => {
    assert.equal(isDay('2026-02-29'), false);
    assert.equal(isDay('2028-02-29'), true);
    assert.equal(isDay('2026-13-01'), false);
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2028-03-01', -1), '2028-02-29');
    // 2026-11-13 is a Friday.
    assert.equal(weekStartOf('2026-11-13', 1), '2026-11-09');
    assert.equal(weekStartOf('2026-11-13', 0), '2026-11-08');
    assert.equal(weekStartOf('2026-11-09', 1), '2026-11-09');
    assert.equal(weekStartOf('2026-11-08', 1), '2026-11-02');
    assert.deepEqual(cycleOf('2026-11-13', 1), {from: '2026-11-01', to: '2026-11-30'});
    assert.deepEqual(cycleOf('2026-11-13', 15), {from: '2026-10-15', to: '2026-11-14'});
    assert.deepEqual(cycleOf('2026-01-03', 15), {from: '2025-12-15', to: '2026-01-14'});
    assert.deepEqual(cycleOf('2026-02-28', 28), {from: '2026-02-28', to: '2026-03-27'});
    assert.deepEqual(cycleOf('2026-03-01', 31), {from: '2026-02-28', to: '2026-03-27'}); // clamped to 28
});

test('interfaces are classified so totals count physical traffic once', () => {
    assert.equal(classifyInterface('wlp2s0', {wireless: true, physical: true}), 'wifi');
    assert.equal(classifyInterface('enp3s0', {physical: true}), 'ethernet');
    assert.equal(classifyInterface('enx00e04c680001', {physical: true}), 'ethernet');
    for (const name of ['wwan0', 'wwp0s20f0u3i12', 'usb0', 'rndis0', 'rmnet_data0'])
        assert.equal(classifyInterface(name, {physical: true}), 'mobile', name);
    for (const name of ['tun0', 'wg0', 'tailscale0', 'proton0', 'nordlynx', 'tap1'])
        assert.equal(classifyInterface(name), 'vpn', name);
    for (const name of ['lo', 'docker0', 'veth12ab', 'br-1234', 'virbr0', 'bond0', ''])
        assert.equal(classifyInterface(name), null, name);
    assert.equal(classifyInterface(undefined), null);
});

test('per-interface deltas skip new interfaces and counter resets', () => {
    const before = new Map([['wlan0', {recv: 100, sent: 50}], ['eth0', {recv: 500, sent: 500}]]);
    const after = new Map([['wlan0', {recv: 160, sent: 70}], ['eth0', {recv: 10, sent: 600}],
        ['usb0', {recv: 9999, sent: 9999}]]);
    assert.deepEqual([...networkDeltas(before, after)], [['wlan0', {recv: 60, sent: 20}]]);
    assert.equal(networkDeltas(null, after).size, 0);
});

test('byte formatting uses three significant digits and binary units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1000), '0.98 KiB');
    assert.equal(formatBytes(1.5 * MiB), '1.50 MiB');
    assert.equal(formatBytes(123.4 * 1024 ** 3), '123 GiB');
    assert.equal(formatBytes(-1), '—');
    assert.equal(formatBytes(NaN), '—');
});

function sampleModel() {
    const model = new UsageModel();
    model.record('2026-11-09', {transfers: [{kind: 'wifi', recv: 10 * MiB, sent: MiB, network: 'Home'}]});
    model.record('2026-11-12', {transfers: [{kind: 'ethernet', recv: 20 * MiB, sent: 2 * MiB, network: 'Office'}]});
    model.record('2026-11-13', {
        transfers: [
            {kind: 'mobile', recv: 3 * MiB, sent: MiB, network: 'Phone hotspot'},
            {kind: 'vpn', recv: 3 * MiB, sent: MiB},
            {kind: 'unknown', recv: 99 * MiB, sent: 99 * MiB},
        ],
        interval: 1, cpu: 20, ram: 40,
    });
    model.record('2026-11-13', {transfers: [{kind: 'wifi', recv: MiB, sent: 0, network: 'Home'}],
        interval: 0.5, cpu: 60, ram: 50});
    model.record('2025-12-31', {transfers: [{kind: 'wifi', recv: 7 * MiB, sent: 0}]});
    return model;
}

test('summaries cover today, week, billing cycle, year, total, kinds, networks, and system stats', () => {
    const summary = sampleModel().summary('2026-11-13', {weekStart: 1, billingDay: 10});
    assert.deepEqual([summary.today.rx, summary.today.tx], [4 * MiB, MiB]);
    assert.deepEqual([summary.today.vpnRx, summary.today.vpnTx], [3 * MiB, MiB]);
    assert.equal(summary.week.from, '2026-11-09');
    assert.equal(summary.week.rx, 34 * MiB);
    assert.equal(summary.cycle.from, '2026-11-10');
    assert.equal(summary.cycle.to, '2026-12-09');
    assert.equal(summary.cycle.rx, 24 * MiB);
    assert.equal(summary.year.rx, 34 * MiB); // 2025 traffic is excluded
    assert.equal(summary.total.rx, 41 * MiB);
    assert.equal(summary.total.vpnRx, 3 * MiB);
    assert.equal(summary.total.since, '2025-12-31');
    assert.deepEqual(summary.cycle.kinds.ethernet, {rx: 20 * MiB, tx: 2 * MiB});
    assert.deepEqual(summary.cycle.kinds.mobile, {rx: 3 * MiB, tx: MiB});
    assert.deepEqual(summary.networks.map(network => network.name), ['Office', 'Phone hotspot', 'Home']);
    assert.equal(summary.system.cpuAverage, 40);
    assert.equal(summary.system.cpuPeak, 60);
    assert.equal(summary.system.ramAverage, 45);
    assert.equal(summary.system.peakRx, 3 * MiB); // max of 3 MiB/1 s and 1 MiB/0.5 s
    assert.equal(summary.system.peakTx, MiB);
    const empty = new UsageModel().summary('2026-11-13');
    assert.equal(empty.system.cpuAverage, null);
    assert.equal(empty.today.rx, 0);
});

test('pruning removes old days but keeps monthly and all-time totals', () => {
    const model = sampleModel();
    model.prune('2026-11-13', 3);
    assert.deepEqual(Object.keys(model.days).sort(), ['2026-11-12', '2026-11-13']);
    const summary = model.summary('2026-11-13');
    assert.equal(summary.year.rx, 34 * MiB);
    assert.equal(summary.total.rx, 41 * MiB);
});

test('serialization round-trips and rejects malformed or oversized data', () => {
    const model = sampleModel();
    model.capNotice = {cycle: '2026-11-10', level: 1};
    const restored = UsageModel.deserialize(model.serialize());
    assert.deepEqual(restored.toJSON(), model.toJSON());
    assert.equal(restored.changed, false);
    const valid = JSON.parse(model.serialize());
    const broken = [
        {...valid, version: 2},
        {...valid, days: {'2026-02-30': valid.days['2026-11-13']}},
        {...valid, days: {'2026-11-13': {...valid.days['2026-11-13'], rx: -1}}},
        {...valid, days: {'2026-11-13': {...valid.days['2026-11-13'], cpu: [1, 1, 101]}}},
        {...valid, days: {'2026-11-13': {...valid.days['2026-11-13'], networks: {'bad\nname': [1, 1]}}}},
        {...valid, months: {'2026-13': valid.months['2026-11']}},
        {...valid, total: {...valid.total, since: 'yesterday'}},
        {...valid, capNotice: {cycle: null, level: 7}},
        [],
    ];
    for (const data of broken)
        assert.throws(() => UsageModel.deserialize(JSON.stringify(data)));
    assert.throws(() => UsageModel.deserialize('not json'));
});

test('merging adds counts, keeps maxima, the earliest start, and the latest cap notice', () => {
    const saved = sampleModel();
    saved.capNotice = {cycle: '2026-11-10', level: 1};
    const live = new UsageModel();
    live.record('2026-11-13', {transfers: [{kind: 'wifi', recv: MiB, sent: MiB, network: 'Home'}],
        interval: 1, cpu: 90, ram: 10});
    live.merge(saved);
    const summary = live.summary('2026-11-13', {billingDay: 10});
    assert.equal(summary.today.rx, 5 * MiB);
    assert.equal(summary.total.rx, 42 * MiB);
    assert.equal(summary.total.since, '2025-12-31');
    assert.equal(summary.system.cpuPeak, 90);
    assert.equal(summary.system.cpuAverage, (90 + 20 + 60) / 3);
    assert.deepEqual(live.capNotice, {cycle: '2026-11-10', level: 1});
});

test('per-day network names are bounded and sanitized', () => {
    const model = new UsageModel();
    for (let index = 0; index < 40; index++)
        model.record('2026-11-13', {transfers: [{kind: 'wifi', recv: 1, sent: 1, network: `Net ${index}`}]});
    model.record('2026-11-13', {transfers: [{kind: 'wifi', recv: 1, sent: 1, network: `x\u0007${'y'.repeat(100)}`}]});
    assert.equal(Object.keys(model.days['2026-11-13'].networks).length, 32);
    assert.equal(model.days['2026-11-13'].rx, 41);
    assert.ok(UsageModel.deserialize(model.serialize()));
});

test('cap levels warn once past the threshold and again at the cap', () => {
    assert.equal(capLevel(10, 0), 0);
    assert.equal(capLevel(79, 100, 80), 0);
    assert.equal(capLevel(80, 100, 80), 1);
    assert.equal(capLevel(100, 100, 80), 2);
    assert.equal(capLevel(NaN, 100), 0);
});

test('day details and month overviews feed the calendar', () => {
    const model = sampleModel();
    const detail = model.dayDetail('2026-11-13');
    assert.equal(detail.rx, 4 * MiB);
    assert.equal(detail.vpnRx, 3 * MiB);
    assert.deepEqual(detail.kinds.mobile, {rx: 3 * MiB, tx: MiB});
    assert.deepEqual(detail.networks.map(network => network.name), ['Phone hotspot', 'Home']);
    assert.equal(detail.system.cpuPeak, 60);
    assert.equal(model.dayDetail('2026-11-10'), null);
    const overview = model.monthOverview('2026-11');
    assert.deepEqual(overview.days, {'2026-11-09': 11 * MiB, '2026-11-12': 22 * MiB, '2026-11-13': 5 * MiB});
    assert.equal(overview.max, 22 * MiB);
    assert.ok(overview.recorded.has('2026-11-13') && !overview.recorded.has('2026-11-10'));
    assert.deepEqual(model.monthOverview('2026-10').days, {});
    assert.equal(model.firstRecordedDay(), '2025-12-31');
    assert.equal(new UsageModel().firstRecordedDay(), null);
});

test('forgetting networks removes every recorded name but keeps the totals', () => {
    const model = sampleModel();
    model.changed = false;
    model.forgetNetworks();
    assert.equal(model.changed, true);
    assert.ok(Object.values(model.days).every(record => Object.keys(record.networks).length === 0));
    assert.equal(model.summary('2026-11-13').networks.length, 0);
    assert.equal(model.summary('2026-11-13').total.rx, 41 * MiB);
});

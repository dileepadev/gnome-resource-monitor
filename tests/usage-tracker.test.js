// SPDX-License-Identifier: MIT
// Usage tracker tests: a temporary directory and an in-memory key store only,
// never the user's statistics or keyring.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SealedBackend} from '../sealed.js';
import {localDay, UsageTracker} from '../usageTracker.js';

const MiB = 1024 ** 2;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function settings(values = {}) {
    const all = {
        'usage-track-networks': false, 'usage-week-start': 1, 'usage-billing-day': 1,
        'usage-monthly-cap-gib': 0, 'usage-cap-warning-percent': 80, 'usage-retention-days': 730,
        ...values,
    };
    return {
        values: all,
        get_boolean: key => all[key], get_int: key => all[key], get_double: key => all[key],
        connect: () => 1, disconnect() {},
    };
}

function memoryKeys() {
    return {
        value: null, locked: false,
        async lookup() {
            if (this.locked)
                throw new Error('Synthetic locked keyring');
            return this.value;
        },
        async store(value) {
            if (this.locked)
                throw new Error('Synthetic locked keyring');
            this.value = value;
        },
        async clear() {
            this.value = null;
        },
    };
}

const classify = name => ({wl0: 'wifi', en0: 'ethernet', usb0: 'mobile', tun0: 'vpn'})[name] ?? null;

function sample(entries, extra = {}) {
    return {transferred: new Map(Object.entries(entries).map(([name, [recv, sent]]) => [name, {recv, sent}])),
        interval: 1, cpu: 30, ram: 50, ...extra};
}

function tracker(directory, keys, options = {}) {
    return new UsageTracker(options.settings ?? settings(), {
        backend: new SealedBackend({directory, keyStore: keys}), classify, networkManager: false, ...options,
    });
}

async function settle(object) {
    for (let index = 0; index < 50 && object.state === 'loading'; index++)
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => resolve() ?? GLib.SOURCE_REMOVE));
}

function removeTree(directory) {
    const info = directory.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const enumerator = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let child;
        while ((child = enumerator.next_file(null)))
            removeTree(directory.get_child(child.get_name()));
        enumerator.close(null);
    }
    directory.delete(null);
}

async function run() {
    const temporary = GLib.dir_make_tmp('resource-monitor-usage-XXXXXX');
    const directory = `${temporary}/data`;
    const file = Gio.File.new_for_path(`${directory}/usage.sealed`);
    const keys = memoryKeys();
    try {
        // Counting, classification, VPN separation, and encrypted saving.
        let first = tracker(directory, keys);
        await settle(first);
        assert(first.state === 'ready', 'Fresh tracker must be ready');
        first.record(sample({wl0: [10 * MiB, MiB], tun0: [5 * MiB, MiB], docker0: [99 * MiB, 99 * MiB]}));
        first.record(sample({en0: [2 * MiB, 0], usb0: [MiB, MiB]}, {interval: 0.5}));
        let summary = first.summary();
        assert(summary.today.rx === 13 * MiB && summary.today.tx === 2 * MiB, 'Physical totals');
        assert(summary.today.vpnRx === 5 * MiB, 'VPN tracked separately');
        assert(summary.cycle.kinds.mobile.rx === MiB, 'Mobile breakdown');
        assert(summary.system.peakRx === 10 * MiB, 'Peak download rate');
        await first.destroy(); // Final save drains.
        const saved = file.load_contents(null)[1];
        assert(new TextDecoder().decode(saved.slice(0, 8)) === 'GCMSEAL1', 'Saved usage is encrypted');
        assert(!new TextDecoder('utf-8', {fatal: false}).decode(saved).includes('"rx"'), 'No plaintext on disk');

        // Next enable loads before writing and merges live counting.
        const second = tracker(directory, keys);
        second.record(sample({wl0: [MiB, 0]})); // Counted while loading.
        await settle(second);
        summary = second.summary();
        assert(summary.today.rx === 14 * MiB, `Load merges with live counting (${summary.today.rx})`);
        assert(summary.total.since === localDay(), 'All-time start date');
        await second.destroy();

        // Locked keyring: keep counting, never overwrite, recover after unlock.
        keys.locked = true;
        const before = file.load_contents(null)[1];
        const locked = tracker(directory, keys);
        await settle(locked);
        assert(locked.state === 'retry', 'Locked keyring is retried');
        locked.record(sample({wl0: [MiB, 0]}));
        await locked._persist();
        assert(GLib.base64_encode(file.load_contents(null)[1]) === GLib.base64_encode(before),
            'Locked state must not overwrite saved usage');
        keys.locked = false;
        locked._persist(); // Retries the load.
        await settle(locked);
        for (let index = 0; index < 20 && locked.state !== 'ready'; index++)
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => resolve() ?? GLib.SOURCE_REMOVE));
        assert(locked.state === 'ready', 'Unlocked keyring loads saved usage');
        assert(locked.summary().today.rx === 15 * MiB, 'Counting during lock is kept');
        await locked.destroy();

        // Tampered file: unreadable, never overwritten until reset.
        const tampered = file.load_contents(null)[1];
        tampered[40] ^= 1;
        file.replace_contents(tampered, null, false, Gio.FileCreateFlags.NONE, null);
        const broken = tracker(directory, keys);
        await settle(broken);
        assert(broken.state === 'unreadable', 'Tampered file is unreadable');
        broken.record(sample({wl0: [MiB, 0]}));
        await broken._persist();
        assert(GLib.base64_encode(file.load_contents(null)[1]) === GLib.base64_encode(tampered),
            'Unreadable file must not be overwritten');
        await broken.reset();
        assert(!file.query_exists(null) && keys.value === null, 'Reset deletes file and key');
        assert(broken.state === 'ready' && broken.summary().today.rx === 0, 'Reset clears statistics');
        broken.record(sample({wl0: [3 * MiB, 0]}));
        await broken.destroy();
        assert(file.query_exists(null) && keys.value !== null, 'Usage after reset is saved with a new key');

        // Reset during a load must not merge old data back.
        const racing = tracker(directory, keys);
        racing.reset();
        await settle(racing);
        await racing._persist();
        assert(racing.summary().today.rx === 0, 'Reset wins over an in-flight load');
        await racing.destroy();

        // Turning per-network tracking off forgets recorded names, also when it
        // was turned off while the extension was not running.
        const networkKeys = memoryKeys();
        const tracking = tracker(`${temporary}/networks`, networkKeys, {settings: settings({'usage-track-networks': true})});
        await settle(tracking);
        tracking._networks.set('wl0', 'Synthetic Cafe');
        tracking.record(sample({wl0: [MiB, 0]}));
        assert(tracking.summary().networks.length === 1, 'Network recorded while tracking');
        tracking.setTrackNetworks(false);
        assert(tracking.summary().networks.length === 0, 'Turning tracking off forgets names');
        tracking.setTrackNetworks(true);
        tracking._networks.set('wl0', 'Synthetic Cafe');
        tracking.record(sample({wl0: [MiB, 0]}));
        await tracking.destroy(); // Saved with a network name.
        const offline = tracker(`${temporary}/networks`, networkKeys, {settings: settings({'usage-track-networks': false})});
        await settle(offline);
        assert(offline.state === 'ready' && offline.summary().today.rx === 2 * MiB, 'Totals kept');
        assert(offline.summary().networks.length === 0, 'Names saved earlier are forgotten when loaded with tracking off');
        await offline.destroy();

        // Data limit: one notification per level per cycle.
        const levels = [];
        const capSettings = settings({'usage-monthly-cap-gib': 10 / 1024}); // 10 MiB
        const capped = tracker(`${temporary}/cap`, memoryKeys(), {settings: capSettings,
            onCapLevel: level => levels.push(level)});
        await settle(capped);
        capped.record(sample({wl0: [8 * MiB, 0]}));
        capped.recheckCap();
        capped.record(sample({wl0: [0, 0]}));
        capped.recheckCap();
        capped.record(sample({wl0: [0, 0]}));
        capped.recheckCap();
        capped.record(sample({wl0: [3 * MiB, 0]}));
        assert(JSON.stringify(levels) === '[1,2]', `Cap notifications ${JSON.stringify(levels)}`);
        await capped.destroy();
        print('PASS: GJS usage tracker: classification, VPN separation, encrypted saves, load-before-write merge, locked-keyring retry without overwrite, tampered-file protection, reset (including during load), final save on disable, and data-limit notifications.');
    } finally {
        removeTree(Gio.File.new_for_path(temporary));
    }
}

const loop = GLib.MainLoop.new(null, false);
let failed = false;
run().catch(error => {
    logError(error);
    failed = true;
}).finally(() => loop.quit());
loop.run();
if (failed)
    System.exit(1);

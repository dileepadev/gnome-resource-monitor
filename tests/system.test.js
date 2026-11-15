// SPDX-License-Identifier: MIT
import GLib from 'gi://GLib';
import {SystemMonitor} from '../system.js';

function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

const loop = new GLib.MainLoop(null, false);
let failure = null;

async function run() {
    const monitor = new SystemMonitor();
    try {
        const firstPromise = monitor.sample();
        check(await monitor.sample() === null, 'Overlapping sampling must be skipped');
        const first = await firstPromise;
        check(first.cpu === null && first.network === null, 'First sample must prime counters');
        check(Number.isFinite(first.ram), 'Live RAM reading must be finite');
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        const second = await monitor.sample();
        check(Number.isFinite(second.cpu), 'Second CPU reading must be finite');
        check(Number.isFinite(second.network?.recvRate), 'Second network reading must be finite');
        const pending = monitor.sample();
        monitor.destroy();
        check(await pending === null, 'Destroyed monitor must discard pending results');
        check(await monitor.sample() === null, 'Destroyed monitor must not restart');
    } finally {
        monitor.destroy();
    }
}

run().catch(error => { failure = error; }).finally(() => loop.quit());
loop.run();
if (failure)
    throw failure;
print('Live sampling, overlap prevention, and cancellation passed');

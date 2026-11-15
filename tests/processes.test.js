// SPDX-License-Identifier: MIT
// Live process sampling against this machine's /proc (read-only).
import GLib from 'gi://GLib';
import System from 'system';

import {ProcessMonitor} from '../processMonitor.js';

const loop = GLib.MainLoop.new(null, false);
let failed = false;
(async () => {
    const monitor = new ProcessMonitor();
    const first = await monitor.sample();
    if (!first || first.primed || first.memory.length === 0)
        throw new Error('First sample must list memory but not CPU');
    // Burn some CPU in this process so it shows up.
    const until = Date.now() + 600;
    while (Date.now() < until) {}
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => resolve() ?? GLib.SOURCE_REMOVE));
    const started = Date.now();
    const second = await monitor.sample();
    const elapsed = Date.now() - started;
    if (!second.primed || !second.cpu.some(process => process.name === 'gjs' || process.name.startsWith('gjs')))
        throw new Error(`This busy gjs process must appear in the CPU list: ${JSON.stringify(second.cpu)}`);
    if (second.cpu.some(process => process.percent <= 0 || process.percent > 100))
        throw new Error('CPU percentages out of range');
    if (second.memory.some(process => process.bytes <= 0))
        throw new Error('Memory values must be positive');
    if (monitor.canSampleNetwork) {
        const first = await monitor.sampleNetwork();
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => resolve() ?? GLib.SOURCE_REMOVE));
        const network = await monitor.sampleNetwork();
        if (first?.primed !== false || network?.primed !== true || !Array.isArray(network.apps))
            throw new Error('Network sampling must prime, then rank');
        if (network.apps.some(app => !(app.rx >= 0 && app.tx >= 0)))
            throw new Error('Network rates must be non-negative');
    }
    monitor.destroy();
    // Report counts only: process names on the test machine do not belong in logs.
    print(`PASS: live process sampling (${elapsed} ms per sample, ${second.cpu.length} CPU and ${second.memory.length} memory entries)`);
})().catch(error => {
    logError(error);
    failed = true;
}).finally(() => loop.quit());
loop.run();
if (failed)
    System.exit(1);

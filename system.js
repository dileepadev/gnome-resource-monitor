// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseCPU, cpuUsage, parseRAM, parseNetwork, networkDeltas, networkUsage} from './metrics.js';

const MAX_SAMPLE_GAP_SECONDS = 5;

export class SystemMonitor {
    constructor() {
        this._decoder = new TextDecoder();
        this._files = ['/proc/stat', '/proc/meminfo', '/proc/net/dev']
            .map(path => Gio.File.new_for_path(path));
        this._cancellable = new Gio.Cancellable();
        this._previous = null;
        this._pending = false;
        this._destroyed = false;
        this._failed = false;
    }

    _read(file) {
        return new Promise((resolve, reject) => {
            file.load_contents_async(this._cancellable, (source, result) => {
                try {
                    const [success, contents] = source.load_contents_finish(result);
                    resolve(success ? this._decoder.decode(contents) : '');
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    async sample() {
        if (this._pending || this._destroyed)
            return null;
        this._pending = true;
        try {
            // Settle every read before allowing another cycle, even if one fails.
            const results = await Promise.allSettled(this._files.map(file => this._read(file)));
            if (this._destroyed)
                return null;
            const texts = results.map(result => result.status === 'fulfilled' ? result.value : '');
            const current = {
                cpu: parseCPU(texts[0]),
                network: parseNetwork(texts[2]),
                time: GLib.get_monotonic_time() / 1_000_000,
            };
            const ram = parseRAM(texts[1]);
            const elapsed = this._previous ? current.time - this._previous.time : 0;
            const previous = elapsed > 0 && elapsed <= MAX_SAMPLE_GAP_SECONDS ? this._previous : null;
            const sample = {
                cpu: cpuUsage(previous?.cpu, current.cpu),
                ram,
                network: networkUsage(previous?.network, current.network, elapsed),
                // Byte totals for data usage. Counters are cumulative and resets
                // are skipped, so the previous sample is used even after a gap
                // (for example a Shell stall or suspend) to avoid losing traffic.
                transferred: networkDeltas(this._previous?.network, current.network),
                interval: previous ? elapsed : 0,
            };
            this._previous = current;
            const failed = !current.cpu || ram === null || !current.network;
            if (failed && !this._failed)
                console.warn('Resource Monitor: one or more system metrics are unavailable');
            this._failed = failed;
            return sample;
        } finally {
            this._pending = false;
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._previous = null;
    }
}

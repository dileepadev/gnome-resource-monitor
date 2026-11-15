// SPDX-License-Identifier: MIT
// Samples per-process CPU time and resident memory from /proc, asynchronously.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseCPU} from './metrics.js';
import {pageSizeFrom, parseProcessStat, parseSockets, rankNetwork, rankProcesses} from './processes.js';

const BATCH = 128;
// Bound concurrent /proc reads so a busy system does not flood the I/O pool.
const READ_CONCURRENCY = 64;

export class ProcessMonitor {
    constructor() {
        this._decoder = new TextDecoder();
        this._cancellable = new Gio.Cancellable();
        this._previous = null;
        this._previousTotal = null;
        this._pageSize = null;
        this._pending = false;
    }

    _read(path) {
        return new Promise(resolve => {
            Gio.File.new_for_path(path).load_contents_async(this._cancellable, (file, result) => {
                try {
                    resolve(this._decoder.decode(file.load_contents_finish(result)[1]));
                } catch {
                    resolve(null); // Processes can exit between listing and reading.
                }
            });
        });
    }

    _pids() {
        return new Promise((resolve, reject) => {
            Gio.File.new_for_path('/proc').enumerate_children_async('standard::name',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable, (file, result) => {
                    let enumerator;
                    try {
                        enumerator = file.enumerate_children_finish(result);
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    const pids = [];
                    const next = () => enumerator.next_files_async(BATCH, GLib.PRIORITY_LOW, this._cancellable,
                        (source, batchResult) => {
                            try {
                                const infos = source.next_files_finish(batchResult);
                                for (const info of infos) {
                                    const name = info.get_name();
                                    if (/^\d+$/.test(name))
                                        pids.push(Number(name));
                                }
                                if (infos.length)
                                    next();
                                else
                                    enumerator.close_async(GLib.PRIORITY_LOW, null, () => resolve(pids));
                            } catch (error) {
                                reject(error);
                            }
                        });
                    next();
                });
        });
    }

    /** Returns {cpu, memory, primed} or null if a sample is already running. */
    async sample(count = 5) {
        if (this._pending)
            return null;
        this._pending = true;
        try {
            if (this._pageSize === null) {
                const [status, statm] = await Promise.all([this._read('/proc/self/status'), this._read('/proc/self/statm')]);
                this._pageSize = pageSizeFrom(status, statm);
            }
            const total = parseCPU(await this._read('/proc/stat') ?? '')?.total ?? null;
            const pids = await this._pids();
            const current = new Map();
            const texts = [];
            for (let start = 0; start < pids.length; start += READ_CONCURRENCY) {
                texts.push(...await Promise.all(pids.slice(start, start + READ_CONCURRENCY)
                    .map(pid => this._read(`/proc/${pid}/stat`))));
            }
            pids.forEach((pid, index) => {
                const process = parseProcessStat(texts[index]);
                if (process)
                    current.set(pid, process);
            });
            const totalTicks = total !== null && this._previousTotal !== null ? total - this._previousTotal : 0;
            const ranked = rankProcesses(this._previous, current, totalTicks, this._pageSize, count);
            this._previous = current;
            this._previousTotal = total;
            return ranked;
        } finally {
            this._pending = false;
        }
    }

    /** True when `ss` (iproute2) is available for per-app network rates. */
    get canSampleNetwork() {
        // Prefer the system copy so a program named `ss` earlier in PATH (for
        // example in ~/.local/bin) is never run by the Shell.
        this._ss ??= ['/usr/bin/ss', '/usr/sbin/ss', '/bin/ss', '/sbin/ss']
            .find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ??
            GLib.find_program_in_path('ss') ?? '';
        return Boolean(this._ss);
    }

    /**
     * Per-app TCP rates from `ss -tinpH`: byte counters of this user's sockets.
     * Only TCP is visible this way (not UDP/QUIC), and other users' processes
     * are not listed; true per-app accounting needs privileged tools.
     */
    async sampleNetwork(count = 5) {
        if (this._networkPending || !this.canSampleNetwork)
            return null;
        this._networkPending = true;
        try {
            const process = Gio.Subprocess.new([this._ss, '-tinpH'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const output = await new Promise((resolve, reject) => {
                process.communicate_utf8_async(null, this._cancellable, (source, result) => {
                    try {
                        resolve(source.communicate_utf8_finish(result)[1] ?? '');
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            const now = GLib.get_monotonic_time() / 1_000_000;
            const current = parseSockets(output);
            const elapsed = this._previousSocketsTime ? now - this._previousSocketsTime : 0;
            const ranked = rankNetwork(this._previousSockets, current, elapsed, count);
            this._previousSockets = current;
            this._previousSocketsTime = now;
            return ranked;
        } finally {
            this._networkPending = false;
        }
    }

    /** Forget the baselines (for example when the list is hidden for a while). */
    reset() {
        this._previous = null;
        this._previousTotal = null;
        this._previousSockets = null;
        this._previousSocketsTime = 0;
    }

    destroy() {
        this._cancellable.cancel();
        this._previous = null;
        this._previousSockets = null;
    }
}

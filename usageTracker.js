// SPDX-License-Identifier: MIT
// Records data usage and system statistics, and keeps them in an encrypted file.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {classifyInterface} from './metrics.js';
import {SealedBackend} from './sealed.js';
import {capLevel, UsageModel} from './usage.js';

const SAVE_INTERVAL_SECONDS = 300;
const CAP_CHECK_INTERVAL_SECONDS = 60;
const MAX_CACHED_INTERFACES = 256;
const GIB = 1024 ** 3;

// Serializes file access across enable/disable cycles (for example screen
// lock/unlock): a new tracker only reads after the previous one finished saving.
let drain = Promise.resolve();

export function localDay() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d');
}

/** Delete saved usage (file and key) while tracking is off. */
export function resetSavedUsage(backend = new SealedBackend()) {
    drain = drain.then(() => backend.remove()).catch(() => {}).finally(() => backend.destroy());
    return drain;
}

// Errors that mean the saved file itself cannot be used (as opposed to a locked
// or temporarily unavailable keyring, which is retried).
function isUnreadable(error) {
    return error instanceof SyntaxError || /^(Invalid data file|Data file failed authentication|Encryption key unavailable|Invalid encryption key|Invalid usage data|Data file too large)/
        .test(error?.message ?? '');
}

export class UsageTracker {
    /**
     * settings: the extension's GSettings. onCapLevel(level, used, cap, cycle) is
     * called once per billing cycle per level. onChanged() after load/reset.
     */
    constructor(settings, {backend = new SealedBackend(), onCapLevel = () => {}, onChanged = () => {},
        classify = null, networkManager = true} = {}) {
        // Tests pass networkManager: false to stay off the system bus.
        this._useNetworkManager = networkManager;
        this._settings = settings;
        this._backend = backend;
        this._onCapLevel = onCapLevel;
        this._onChanged = onChanged;
        this._model = new UsageModel();
        this._kinds = new Map();
        this._classify = classify;
        this._networks = new Map();
        this._state = 'loading'; // loading | ready | retry | unreadable
        this._destroyed = false;
        this._writes = Promise.resolve();
        this._loading = null;
        this._loadGeneration = 0;
        // -Infinity: the first check runs immediately, even shortly after boot
        // (the monotonic clock starts near zero then).
        this._lastCapCheck = -Infinity;
        this._saveSource = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, SAVE_INTERVAL_SECONDS, () => {
            this._persist();
            return GLib.SOURCE_CONTINUE;
        });
        this.setTrackNetworks(settings.get_boolean('usage-track-networks'));
        this._load();
    }

    get state() {
        return this._state;
    }

    _load() {
        if (this._loading || this._destroyed)
            return this._loading;
        const generation = ++this._loadGeneration;
        const current = () => !this._destroyed && generation === this._loadGeneration;
        this._loading = (async () => {
            try {
                await drain;
                await this._writes; // A reset's deletion finishes before reading.
                if (!current())
                    return;
                const text = await this._backend.read();
                if (!current())
                    return;
                if (text !== null)
                    this._model.merge(UsageModel.deserialize(text));
                // Per-network tracking may have been turned off while not running.
                if (!this._trackNetworks)
                    this._model.forgetNetworks();
                this._state = 'ready';
            } catch (error) {
                if (!current())
                    return;
                this._state = isUnreadable(error) ? 'unreadable' : 'retry';
            } finally {
                if (generation === this._loadGeneration)
                    this._loading = null;
                if (current())
                    this._onChanged();
            }
        })();
        return this._loading;
    }

    _kind(name) {
        if (!this._kinds.has(name)) {
            if (this._kinds.size >= MAX_CACHED_INTERFACES)
                this._kinds.clear(); // Container interfaces can churn.
            let kind = null;
            if (this._classify) {
                kind = this._classify(name);
            } else if (/^[^/\0]+$/.test(name) && name !== '.' && name !== '..') {
                const base = `/sys/class/net/${name}`;
                const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
                kind = classifyInterface(name, {
                    wireless: exists(`${base}/wireless`) || exists(`${base}/phy80211`),
                    physical: exists(`${base}/device`),
                });
            }
            this._kinds.set(name, kind);
        }
        return this._kinds.get(name);
    }

    /** Add one sample from SystemMonitor. */
    record(sample) {
        if (this._destroyed || !sample)
            return;
        const transfers = [];
        for (const [name, delta] of sample.transferred ?? []) {
            const kind = this._kind(name);
            if (kind)
                transfers.push({kind, recv: delta.recv, sent: delta.sent, network: this._networks.get(name)});
        }
        const day = localDay();
        this._model.record(day, {transfers, interval: sample.interval, cpu: sample.cpu, ram: sample.ram});
        const now = GLib.get_monotonic_time() / 1_000_000;
        if (now - this._lastCapCheck >= CAP_CHECK_INTERVAL_SECONDS) {
            this._lastCapCheck = now;
            this._checkCap(day);
        }
    }

    _options() {
        return {
            weekStart: this._settings.get_int('usage-week-start'),
            billingDay: this._settings.get_int('usage-billing-day'),
        };
    }

    capBytes() {
        return this._settings.get_double('usage-monthly-cap-gib') * GIB;
    }

    _checkCap(day = localDay()) {
        const summary = this._model.summary(day, this._options());
        const cap = this.capBytes();
        const used = summary.cycle.rx + summary.cycle.tx;
        const level = capLevel(used, cap, this._settings.get_int('usage-cap-warning-percent'));
        const notice = this._model.capNotice;
        const sameCycle = notice.cycle === summary.cycle.from;
        if (level > 0 && (!sameCycle || level > notice.level)) {
            this._model.capNotice = {cycle: summary.cycle.from, level};
            this._model.changed = true;
            this._onCapLevel(level, used, cap, summary.cycle);
        } else if (!sameCycle && notice.cycle) {
            this._model.capNotice = {cycle: summary.cycle.from, level: 0};
        }
    }

    /** Re-check the cap immediately (after a settings change). */
    recheckCap() {
        this._lastCapCheck = -Infinity;
    }

    summary() {
        return this._model.summary(localDay(), this._options());
    }

    dayDetail(day) {
        return this._model.dayDetail(day);
    }

    monthOverview(month) {
        return this._model.monthOverview(month);
    }

    firstRecordedDay() {
        return this._model.firstRecordedDay();
    }

    _persist() {
        if (this._destroyed)
            return this._writes;
        if (this._state === 'retry') {
            this._load();
            return this._writes;
        }
        if (this._state !== 'ready' || !this._model.changed)
            return this._writes;
        this._model.prune(localDay(), this._settings.get_int('usage-retention-days'));
        const contents = this._model.serialize();
        this._model.changed = false;
        this._writes = this._writes.then(() => this._backend.write(contents)).catch(() => {
            // Keep the data in memory and try again on the next cycle.
            this._model.changed = true;
        });
        return this._writes;
    }

    /** Delete all statistics: memory, the encrypted file, and its key. */
    reset() {
        // A load still in progress must not merge old data back in.
        this._loadGeneration++;
        this._loading = null;
        this._backend.cancelRead();
        this._model.clear();
        this._state = 'ready';
        this._writes = this._writes.then(() => this._backend.remove()).catch(() => {});
        this._onChanged();
        return this._writes;
    }

    setTrackNetworks(enabled) {
        const wasEnabled = this._trackNetworks;
        this._trackNetworks = enabled;
        if (!enabled) {
            this._stopNetworks();
            // Network names can reveal places; turning tracking off forgets them.
            if (wasEnabled)
                this._model.forgetNetworks();
            return;
        }
        if (this._nmCancellable || !this._useNetworkManager)
            return;
        this._startNetworks();
    }

    async _startNetworks() {
        this._nmCancellable = new Gio.Cancellable();
        const cancellable = this._nmCancellable;
        let NM;
        try {
            ({default: NM} = await import('gi://NM'));
        } catch {
            return; // NetworkManager is not available; networks stay unnamed.
        }
        NM.Client.new_async(cancellable, (_source, result) => {
            try {
                const client = NM.Client.new_finish(result);
                if (cancellable.is_cancelled() || this._destroyed)
                    return;
                this._nm = client;
                this._nmSignals = ['active-connection-added', 'active-connection-removed']
                    .map(signal => client.connect(signal, () => this._refreshNetworks()));
                this._refreshNetworks();
            } catch {}
        });
    }

    _refreshNetworks() {
        this._networks.clear();
        for (const connection of this._nm?.get_active_connections() ?? []) {
            const id = connection.get_id();
            if (!id || connection.get_vpn?.())
                continue;
            for (const device of connection.get_devices() ?? []) {
                for (const name of [device.get_iface(), device.get_ip_iface?.()]) {
                    if (name)
                        this._networks.set(name, id);
                }
            }
        }
    }

    _stopNetworks() {
        this._nmCancellable?.cancel();
        this._nmCancellable = null;
        for (const id of this._nmSignals ?? [])
            this._nm?.disconnect(id);
        this._nmSignals = null;
        this._nm = null;
        this._networks.clear();
    }

    /** Stop synchronously; the final save drains in the background. */
    destroy() {
        if (this._destroyed)
            return drain;
        if (this._saveSource)
            GLib.Source.remove(this._saveSource);
        this._saveSource = 0;
        this._stopNetworks();
        const writes = this._state === 'ready' ? this._persist() : this._writes;
        this._destroyed = true;
        this._backend.cancelRead();
        const backend = this._backend;
        drain = Promise.all([drain, writes]).catch(() => {}).finally(() => backend.destroy());
        this._settings = null;
        this._onCapLevel = null;
        this._onChanged = null;
        return drain;
    }
}

// SPDX-License-Identifier: MIT
// Pure data-usage model: no Shell, GLib, or filesystem dependencies.
//
// Days are local calendar dates ("YYYY-MM-DD") supplied by the caller. Daily
// records are kept for the retention period; calendar-month and all-time
// totals are kept indefinitely so yearly and lifetime figures survive pruning.

export const VERSION = 1;
export const KINDS = ['wifi', 'ethernet', 'mobile'];
export const MAX_DAYS = 3660;
export const MAX_MONTHS = 1200;
export const MAX_NETWORKS_PER_DAY = 32;
export const MAX_NETWORK_NAME = 64;

const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---- Calendar helpers (UTC arithmetic on local date keys) ----

function toDate(day) {
    return new Date(`${day}T00:00:00Z`);
}

function toKey(date) {
    return date.toISOString().slice(0, 10);
}

export function isDay(day) {
    return typeof day === 'string' && DAY_PATTERN.test(day) && toKey(toDate(day)) === day;
}

export function addDays(day, count) {
    const date = toDate(day);
    date.setUTCDate(date.getUTCDate() + count);
    return toKey(date);
}

/** Start of the week containing `day`; weekStart 0 = Sunday, 1 = Monday. */
export function weekStartOf(day, weekStart = 1) {
    const weekday = toDate(day).getUTCDay();
    return addDays(day, -((weekday - weekStart + 7) % 7));
}

/** Billing cycle containing `day`, starting on `billingDay` (1–28) of a month. */
export function cycleOf(day, billingDay = 1) {
    const start = Math.min(28, Math.max(1, Math.trunc(billingDay) || 1));
    const date = toDate(day);
    let year = date.getUTCFullYear();
    let month = date.getUTCMonth();
    if (date.getUTCDate() < start) {
        month--;
        if (month < 0) {
            month = 11;
            year--;
        }
    }
    const from = new Date(Date.UTC(year, month, start));
    const next = new Date(Date.UTC(year, month + 1, start));
    return {from: toKey(from), to: addDays(toKey(next), -1)};
}

// ---- Records ----

const pair = () => [0, 0];

function emptyDay() {
    return {
        rx: 0, tx: 0, vpnRx: 0, vpnTx: 0,
        kinds: Object.fromEntries(KINDS.map(kind => [kind, pair()])),
        networks: {},
        peakRx: 0, peakTx: 0,
        cpu: [0, 0, 0], // sum, count, max
        ram: [0, 0, 0],
    };
}

const emptyTotals = () => ({rx: 0, tx: 0, vpnRx: 0, vpnTx: 0});

function cleanName(name) {
    if (typeof name !== 'string')
        return null;
    // Drop control characters; keep the name short and inert.
    const text = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NETWORK_NAME);
    return text || null;
}

const finiteBytes = value => Number.isFinite(value) && value >= 0 ? value : 0;

export class UsageModel {
    constructor() {
        this.clear();
    }

    clear() {
        this.days = {};
        this.months = {};
        this.total = {...emptyTotals(), since: null};
        this.capNotice = {cycle: null, level: 0};
        this.changed = false;
    }

    _day(day) {
        if (!this.days[day])
            this.days[day] = emptyDay();
        return this.days[day];
    }

    _month(day) {
        const month = day.slice(0, 7);
        if (!this.months[month])
            this.months[month] = emptyTotals();
        return this.months[month];
    }

    /**
     * Add one sample.
     * transfers: [{kind: 'wifi'|'ethernet'|'mobile'|'vpn', recv, sent, network?}]
     * interval: seconds covered by the sample (for peak rates), cpu/ram: percent or null.
     */
    record(day, {transfers = [], interval = 0, cpu = null, ram = null} = {}) {
        if (!isDay(day))
            return;
        const record = this._day(day);
        const month = this._month(day);
        let rx = 0;
        let tx = 0;
        for (const transfer of transfers) {
            const recv = finiteBytes(transfer.recv);
            const sent = finiteBytes(transfer.sent);
            if (!recv && !sent)
                continue;
            if (transfer.kind === 'vpn') {
                record.vpnRx += recv;
                record.vpnTx += sent;
                month.vpnRx += recv;
                month.vpnTx += sent;
                this.total.vpnRx += recv;
                this.total.vpnTx += sent;
                continue;
            }
            if (!KINDS.includes(transfer.kind))
                continue;
            rx += recv;
            tx += sent;
            record.kinds[transfer.kind][0] += recv;
            record.kinds[transfer.kind][1] += sent;
            const name = cleanName(transfer.network);
            if (name && (record.networks[name] ||
                Object.keys(record.networks).length < MAX_NETWORKS_PER_DAY)) {
                record.networks[name] ??= pair();
                record.networks[name][0] += recv;
                record.networks[name][1] += sent;
            }
        }
        if (rx || tx) {
            record.rx += rx;
            record.tx += tx;
            month.rx += rx;
            month.tx += tx;
            this.total.rx += rx;
            this.total.tx += tx;
            this.changed = true;
        }
        if (interval > 0 && interval <= 5) {
            record.peakRx = Math.max(record.peakRx, rx / interval);
            record.peakTx = Math.max(record.peakTx, tx / interval);
        }
        for (const [key, value] of [['cpu', cpu], ['ram', ram]]) {
            if (!Number.isFinite(value))
                continue;
            const stats = record[key];
            stats[0] += value;
            stats[1]++;
            stats[2] = Math.max(stats[2], value);
            this.changed = true;
        }
        if (!this.total.since || day < this.total.since)
            this.total.since = day;
    }

    _sumDays(from, to) {
        const result = {rx: 0, tx: 0, vpnRx: 0, vpnTx: 0,
            kinds: Object.fromEntries(KINDS.map(kind => [kind, {rx: 0, tx: 0}])), networks: {}};
        for (const [day, record] of Object.entries(this.days)) {
            if (day < from || day > to)
                continue;
            result.rx += record.rx;
            result.tx += record.tx;
            result.vpnRx += record.vpnRx;
            result.vpnTx += record.vpnTx;
            for (const kind of KINDS) {
                result.kinds[kind].rx += record.kinds[kind][0];
                result.kinds[kind].tx += record.kinds[kind][1];
            }
            for (const [name, [recv, sent]] of Object.entries(record.networks)) {
                result.networks[name] ??= {rx: 0, tx: 0};
                result.networks[name].rx += recv;
                result.networks[name].tx += sent;
            }
        }
        return result;
    }

    /** Totals for display. `today` is the current local date key. */
    summary(today, {weekStart = 1, billingDay = 1, topNetworks = 8} = {}) {
        const week = weekStartOf(today, weekStart);
        const cycle = cycleOf(today, billingDay);
        const year = today.slice(0, 4);
        const yearTotals = emptyTotals();
        for (const [month, totals] of Object.entries(this.months)) {
            if (!month.startsWith(year))
                continue;
            for (const key of Object.keys(yearTotals))
                yearTotals[key] += totals[key];
        }
        const cycleTotals = this._sumDays(cycle.from, today);
        const record = this.days[today] ?? emptyDay();
        const average = ([sum, count]) => count ? sum / count : null;
        return {
            today: this._sumDays(today, today),
            week: {...this._sumDays(week, today), from: week},
            cycle: {...cycleTotals, ...cycle},
            year: yearTotals,
            total: {...this.total},
            networks: Object.entries(cycleTotals.networks)
                .map(([name, totals]) => ({name, ...totals}))
                .sort((a, b) => b.rx + b.tx - (a.rx + a.tx) || a.name.localeCompare(b.name))
                .slice(0, topNetworks),
            system: {
                cpuAverage: average(record.cpu), cpuPeak: record.cpu[1] ? record.cpu[2] : null,
                ramAverage: average(record.ram), ramPeak: record.ram[1] ? record.ram[2] : null,
                peakRx: record.peakRx, peakTx: record.peakTx,
            },
        };
    }

    /** Full statistics for one day, or null when nothing was recorded that day. */
    dayDetail(day, {topNetworks = 8} = {}) {
        const record = this.days[day];
        if (!record)
            return null;
        const average = ([sum, count]) => count ? sum / count : null;
        return {
            day,
            rx: record.rx, tx: record.tx, vpnRx: record.vpnRx, vpnTx: record.vpnTx,
            kinds: Object.fromEntries(KINDS.map(kind =>
                [kind, {rx: record.kinds[kind][0], tx: record.kinds[kind][1]}])),
            networks: Object.entries(record.networks)
                .map(([name, [rx, tx]]) => ({name, rx, tx}))
                .sort((a, b) => b.rx + b.tx - (a.rx + a.tx) || a.name.localeCompare(b.name))
                .slice(0, topNetworks),
            system: {
                cpuAverage: average(record.cpu), cpuPeak: record.cpu[1] ? record.cpu[2] : null,
                ramAverage: average(record.ram), ramPeak: record.ram[1] ? record.ram[2] : null,
                peakRx: record.peakRx, peakTx: record.peakTx,
            },
        };
    }

    /**
     * Per-day totals for a calendar month ("YYYY-MM"): {days: {day: rx + tx},
     * max, recorded: Set of days with a record}.
     */
    monthOverview(month) {
        const days = {};
        const recorded = new Set();
        let max = 0;
        for (const [day, record] of Object.entries(this.days)) {
            if (!day.startsWith(`${month}-`))
                continue;
            recorded.add(day);
            days[day] = record.rx + record.tx;
            max = Math.max(max, days[day]);
        }
        return {days, max, recorded};
    }

    /** Drop every recorded network name (per-network tracking was turned off). */
    forgetNetworks() {
        for (const record of Object.values(this.days)) {
            if (Object.keys(record.networks).length) {
                record.networks = {};
                this.changed = true;
            }
        }
    }

    /** Earliest day with a daily record, or null. */
    firstRecordedDay() {
        return Object.keys(this.days).sort()[0] ?? null;
    }

    /** Remove daily records older than the retention window (month/all-time totals stay). */
    prune(today, retentionDays) {
        const oldest = addDays(today, -(Math.max(1, retentionDays) - 1));
        for (const day of Object.keys(this.days)) {
            if (day < oldest) {
                delete this.days[day];
                this.changed = true;
            }
        }
    }

    /** Add another model's counts (used when saved data loads after counting began). */
    merge(other) {
        for (const [day, source] of Object.entries(other.days)) {
            const target = this._day(day);
            for (const key of ['rx', 'tx', 'vpnRx', 'vpnTx'])
                target[key] += source[key];
            for (const kind of KINDS) {
                target.kinds[kind][0] += source.kinds[kind][0];
                target.kinds[kind][1] += source.kinds[kind][1];
            }
            for (const [name, [recv, sent]] of Object.entries(source.networks)) {
                if (!target.networks[name] && Object.keys(target.networks).length >= MAX_NETWORKS_PER_DAY)
                    continue;
                target.networks[name] ??= pair();
                target.networks[name][0] += recv;
                target.networks[name][1] += sent;
            }
            target.peakRx = Math.max(target.peakRx, source.peakRx);
            target.peakTx = Math.max(target.peakTx, source.peakTx);
            for (const key of ['cpu', 'ram']) {
                target[key][0] += source[key][0];
                target[key][1] += source[key][1];
                target[key][2] = Math.max(target[key][2], source[key][2]);
            }
        }
        for (const [month, source] of Object.entries(other.months)) {
            const target = this.months[month] ??= emptyTotals();
            for (const key of Object.keys(target))
                target[key] += source[key];
        }
        for (const key of ['rx', 'tx', 'vpnRx', 'vpnTx'])
            this.total[key] += other.total[key];
        const sinces = [this.total.since, other.total.since].filter(Boolean).sort();
        this.total.since = sinces[0] ?? null;
        if (other.capNotice.cycle && (other.capNotice.cycle > (this.capNotice.cycle ?? '') ||
            (other.capNotice.cycle === this.capNotice.cycle && other.capNotice.level > this.capNotice.level)))
            this.capNotice = {...other.capNotice};
        this.changed = true;
    }

    toJSON() {
        return {version: VERSION, days: this.days, months: this.months, total: this.total,
            capNotice: this.capNotice};
    }

    serialize() {
        return JSON.stringify(this.toJSON());
    }

    /** Strictly validate saved data; throws on anything unexpected. */
    static deserialize(text) {
        const data = JSON.parse(text);
        const fail = what => {
            throw new Error(`Invalid usage data: ${what}`);
        };
        const bytes = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
        const percent = value => Number.isFinite(value) && value >= 0 && value <= 100;
        const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
        const isPair = value => Array.isArray(value) && value.length === 2 && value.every(bytes);
        const isStats = value => Array.isArray(value) && value.length === 3 && bytes(value[0]) &&
            Number.isInteger(value[1]) && value[1] >= 0 && percent(value[2]);
        if (!isObject(data) || data.version !== VERSION)
            fail('version');
        if (!isObject(data.days) || Object.keys(data.days).length > MAX_DAYS)
            fail('days');
        if (!isObject(data.months) || Object.keys(data.months).length > MAX_MONTHS)
            fail('months');
        const model = new UsageModel();
        for (const [day, record] of Object.entries(data.days)) {
            if (!isDay(day) || !isObject(record) ||
                !['rx', 'tx', 'vpnRx', 'vpnTx', 'peakRx', 'peakTx'].every(key => bytes(record[key])) ||
                !isObject(record.kinds) || !KINDS.every(kind => isPair(record.kinds[kind])) ||
                Object.keys(record.kinds).length !== KINDS.length ||
                !isObject(record.networks) || Object.keys(record.networks).length > MAX_NETWORKS_PER_DAY ||
                !Object.entries(record.networks).every(([name, value]) =>
                    cleanName(name) === name && isPair(value)) ||
                !isStats(record.cpu) || !isStats(record.ram))
                fail(`day ${day}`);
            model.days[day] = {
                rx: record.rx, tx: record.tx, vpnRx: record.vpnRx, vpnTx: record.vpnTx,
                kinds: Object.fromEntries(KINDS.map(kind => [kind, [...record.kinds[kind]]])),
                networks: Object.fromEntries(Object.entries(record.networks).map(([name, value]) => [name, [...value]])),
                peakRx: record.peakRx, peakTx: record.peakTx,
                cpu: [...record.cpu], ram: [...record.ram],
            };
        }
        for (const [month, totals] of Object.entries(data.months)) {
            if (!MONTH_PATTERN.test(month) || !isObject(totals) ||
                !['rx', 'tx', 'vpnRx', 'vpnTx'].every(key => bytes(totals[key])))
                fail(`month ${month}`);
            model.months[month] = {rx: totals.rx, tx: totals.tx, vpnRx: totals.vpnRx, vpnTx: totals.vpnTx};
        }
        const total = data.total;
        if (!isObject(total) || !['rx', 'tx', 'vpnRx', 'vpnTx'].every(key => bytes(total[key])) ||
            !(total.since === null || isDay(total.since)))
            fail('total');
        model.total = {rx: total.rx, tx: total.tx, vpnRx: total.vpnRx, vpnTx: total.vpnTx, since: total.since};
        const notice = data.capNotice;
        if (!isObject(notice) || !(notice.cycle === null || isDay(notice.cycle)) ||
            ![0, 1, 2].includes(notice.level))
            fail('capNotice');
        model.capNotice = {cycle: notice.cycle, level: notice.level};
        model.changed = false;
        return model;
    }
}

/**
 * Cap level for the current cycle: 0 below the warning threshold, 1 at or
 * above `warnPercent`, 2 at or above the cap. A cap of 0 disables warnings.
 */
export function capLevel(bytesUsed, capBytes, warnPercent = 80) {
    if (!(capBytes > 0) || !Number.isFinite(bytesUsed))
        return 0;
    if (bytesUsed >= capBytes)
        return 2;
    return bytesUsed >= capBytes * Math.min(100, Math.max(1, warnPercent)) / 100 ? 1 : 0;
}

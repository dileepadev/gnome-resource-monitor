// SPDX-License-Identifier: MIT
// Pure parsing and sampling helpers; no Shell or filesystem dependencies.

/**
 * Fill %s/%d placeholders in order, in a single pass, so inserted values that
 * themselves contain "%s" or "%d" are never substituted again. "%%" is "%".
 */
export function fillTemplate(template, ...values) {
    let index = 0;
    return template.replace(/%%|%[sd]/g, match => match === '%%' ? '%' : String(values[index++] ?? ''));
}
function counters(text) {
    const values = text.trim().split(/\s+/).map(Number);
    return values.every(value => Number.isFinite(value) && value >= 0) ? values : null;
}

export function parseCPU(text) {
    const match = text.match(/^cpu\s+(.+)$/m);
    const values = match && counters(match[1]);
    if (!values || values.length < 4)
        return null;
    // guest and guest_nice are already included in user and nice.
    return {
        total: values.slice(0, 8).reduce((sum, value) => sum + value, 0),
        idle: values[3] + (values[4] ?? 0),
    };
}

export function cpuUsage(previous, current) {
    if (!previous || !current)
        return null;
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    if (total <= 0 || idle < 0 || idle > total)
        return null;
    return 100 * (1 - idle / total);
}

export function parseRAM(text) {
    const total = Number(text.match(/^MemTotal:\s+(\d+)\s+kB$/m)?.[1]);
    const available = Number(text.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1]);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available) || available > total)
        return null;
    return 100 * (1 - available / total);
}

export function parseNetwork(text) {
    const interfaces = new Map();
    for (const line of text.split('\n').slice(2)) {
        if (!line.trim())
            continue;
        const separator = line.indexOf(':');
        if (separator < 1)
            return null;
        const name = line.slice(0, separator).trim();
        const values = counters(line.slice(separator + 1));
        if (!values || values.length < 16)
            return null;
        if (name !== 'lo')
            interfaces.set(name, {recv: values[0], sent: values[8]});
    }
    return text.split('\n').length >= 3 ? interfaces : null;
}

/**
 * Bytes transferred per interface since the previous sample. Interfaces that
 * are new or whose counters went backwards (reset) are skipped rather than
 * reported as a spike.
 */
export function networkDeltas(previous, current) {
    const deltas = new Map();
    if (!previous || !current)
        return deltas;
    for (const [name, sample] of current) {
        const before = previous.get(name);
        if (!before || sample.recv < before.recv || sample.sent < before.sent)
            continue;
        deltas.set(name, {recv: sample.recv - before.recv, sent: sample.sent - before.sent});
    }
    return deltas;
}

export function networkUsage(previous, current, elapsed) {
    if (!previous || !current || !Number.isFinite(elapsed) || elapsed <= 0)
        return null;
    let recvRate = 0;
    let sentRate = 0;
    for (const delta of networkDeltas(previous, current).values()) {
        recvRate += delta.recv / elapsed;
        sentRate += delta.sent / elapsed;
    }
    return {recvRate, sentRate};
}

const VPN_PREFIXES = ['tun', 'tap', 'wg', 'tailscale', 'zt', 'nordlynx', 'proton', 'ipsec', 'vti',
    'gpd', 'utun', 'mullvad', 'cscotun', 'ovpn'];
const MOBILE_PREFIXES = ['wwan', 'ww', 'rmnet', 'usb', 'rndis', 'ppp'];

/**
 * Classify an interface for data-usage totals: 'wifi', 'ethernet', 'mobile'
 * (mobile broadband and USB tethering), 'vpn' (tracked separately because its
 * traffic also crosses a physical interface), or null for interfaces that are
 * ignored (loopback, containers, bridges, and other virtual interfaces whose
 * traffic is already counted on a physical interface).
 * `wireless` and `physical` come from /sys/class/net/<name>/{wireless,device}.
 */
export function classifyInterface(name, {wireless = false, physical = false} = {}) {
    if (typeof name !== 'string' || !name || name === 'lo')
        return null;
    if (VPN_PREFIXES.some(prefix => name.startsWith(prefix)))
        return 'vpn';
    if (MOBILE_PREFIXES.some(prefix => name.startsWith(prefix)))
        return 'mobile';
    if (wireless)
        return 'wifi';
    return physical ? 'ethernet' : null;
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Format a byte count with at most three significant digits, like formatSpeed. */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '—';
    let value = bytes;
    let unit = 0;
    while (value >= 999.5 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    let digits;
    if (unit === 0 || value >= 99.95)
        digits = value.toFixed(0);
    else if (value >= 9.995)
        digits = value.toFixed(1);
    else
        digits = value.toFixed(2);
    return `${digits} ${BYTE_UNITS[unit]}`;
}

const SPEED_UNITS = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];

/**
 * Format a rate with at most three significant digits so its width is bounded:
 * whole bytes ("86 B/s"), then "1.23", "12.3", or "123" KiB/s and up. A value
 * that would round to 1000 or more moves to the next unit ("0.98 KiB/s").
 */
export function formatSpeed(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0)
        return '—';
    let value = bytesPerSecond;
    let unit = 0;
    while (value >= 999.5 && unit < SPEED_UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    let digits;
    if (unit === 0 || value >= 99.95)
        digits = value.toFixed(0);
    else if (value >= 9.995)
        digits = value.toFixed(1);
    else
        digits = value.toFixed(2);
    return `${digits} ${SPEED_UNITS[unit]}`;
}

export function formatPercent(percent) {
    if (!Number.isFinite(percent))
        return '—';
    return `${Math.min(100, Math.max(0, percent)).toFixed(1)}%`;
}

const DIGITS = [...'0123456789'];

/**
 * Every widest-case string the formatters can produce, with each digit, so the
 * panel can reserve exactly enough width for any font (tabular or not).
 */
export function percentSamples() {
    return ['—', '100.0%', ...DIGITS.flatMap(d => [`${d}.${d}%`, `${d}${d}.${d}%`])];
}

export function speedSamples() {
    const samples = ['—'];
    for (const d of DIGITS) {
        samples.push(`${d} ${SPEED_UNITS[0]}`, `${d}${d} ${SPEED_UNITS[0]}`, `${d}${d}${d} ${SPEED_UNITS[0]}`);
        for (const unit of SPEED_UNITS.slice(1))
            samples.push(`${d}.${d}${d} ${unit}`, `${d}${d}.${d} ${unit}`, `${d}${d}${d} ${unit}`);
    }
    return samples;
}

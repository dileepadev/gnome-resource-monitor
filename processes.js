// SPDX-License-Identifier: MIT
// Pure helpers for the top-processes list; no Shell or filesystem dependencies.

/**
 * Parse /proc/<pid>/stat. The command name is in parentheses and may contain
 * spaces or parentheses, so fields are read after the last ')'.
 */
export function parseProcessStat(text) {
    if (typeof text !== 'string')
        return null;
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 1 || close < open)
        return null;
    const fields = text.slice(close + 2).trim().split(/\s+/);
    // After the name: state(3) ... utime(14) stime(15) ... rss(24).
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const rss = Number(fields[21]);
    if (![utime, stime, rss].every(value => Number.isFinite(value) && value >= 0))
        return null;
    return {name: text.slice(open + 1, close), ticks: utime + stime, rssPages: rss};
}

/**
 * Rank processes. `previous`/`current` map pid -> {name, ticks, rssPages};
 * `totalTicks` is the change in total CPU time across all CPUs (from /proc/stat),
 * so percentages are a share of the whole machine, like the panel reading.
 */
export function rankProcesses(previous, current, totalTicks, pageSize, count = 5) {
    // Group by name so multi-process apps (browsers, editors) appear once.
    // `pid` is the group's largest member, used to look up the app.
    const groups = new Map();
    for (const [pid, process] of current) {
        const group = groups.get(process.name) ??
            {name: process.name, count: 0, percent: 0, bytes: 0, cpuPid: pid, cpuTop: -1, memoryPid: pid, memoryTop: -1};
        groups.set(process.name, group);
        group.count++;
        const before = previous?.get(pid);
        if (before && totalTicks > 0 && process.ticks >= before.ticks && before.name === process.name) {
            const percent = 100 * (process.ticks - before.ticks) / totalTicks;
            group.percent += percent;
            if (percent > group.cpuTop) {
                group.cpuTop = percent;
                group.cpuPid = pid;
            }
        }
        const bytes = process.rssPages * pageSize;
        group.bytes += bytes;
        if (bytes > group.memoryTop) {
            group.memoryTop = bytes;
            group.memoryPid = pid;
        }
    }
    const cpu = [];
    const memory = [];
    for (const group of groups.values()) {
        if (group.percent > 0)
            cpu.push({pid: group.cpuPid, name: group.name, count: group.count, percent: Math.min(100, group.percent)});
        if (group.bytes > 0)
            memory.push({pid: group.memoryPid, name: group.name, count: group.count, bytes: group.bytes});
    }
    cpu.sort((a, b) => b.percent - a.percent || a.pid - b.pid);
    memory.sort((a, b) => b.bytes - a.bytes || a.pid - b.pid);
    return {cpu: cpu.slice(0, count), memory: memory.slice(0, count), primed: Boolean(previous)};
}

/** Page size from /proc/self/status VmRSS (kB) and /proc/self/statm resident pages. */
export function pageSizeFrom(statusText, statmText) {
    const rssKiB = Number(statusText?.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
    const pages = Number(statmText?.trim().split(/\s+/)[1]);
    if (!(rssKiB > 0) || !(pages > 0))
        return 4096;
    // Round to the nearest power of two (4 KiB, 16 KiB, 64 KiB, ...).
    return 2 ** Math.round(Math.log2(rssKiB * 1024 / pages));
}

/**
 * Parse `ss -tinpH` output (TCP sockets of this user's processes): a header line
 * with addresses and `users:(("name",pid=1,fd=2))`, followed by an indented line
 * with `bytes_acked:` (sent) and `bytes_received:`. Returns Map key -> socket.
 */
export function parseSockets(text) {
    const sockets = new Map();
    if (typeof text !== 'string')
        return sockets;
    let current = null;
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        if (!/^\s/.test(line)) {
            const fields = line.trim().split(/\s+/);
            const user = line.match(/users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/);
            current = fields.length >= 5 && user
                ? {key: `${fields[3]} ${fields[4]} ${user[2]}`, name: user[1], pid: Number(user[2])} : null;
            continue;
        }
        if (!current)
            continue;
        const sent = Number(line.match(/\bbytes_acked:(\d+)/)?.[1] ?? 0);
        const received = Number(line.match(/\bbytes_received:(\d+)/)?.[1] ?? 0);
        sockets.set(current.key, {name: current.name, pid: current.pid, sent, received});
        current = null;
    }
    return sockets;
}

/**
 * Rank apps by network rate between two socket samples. Sockets seen for the
 * first time only establish a baseline (their earlier traffic is unknown), and
 * counters that went backwards are skipped. Grouped by process name.
 */
export function rankNetwork(previous, current, elapsed, count = 5) {
    if (!previous || !(elapsed > 0))
        return {apps: [], primed: false};
    const groups = new Map();
    for (const [key, socket] of current) {
        const before = previous.get(key);
        if (!before || socket.sent < before.sent || socket.received < before.received)
            continue;
        const rx = (socket.received - before.received) / elapsed;
        const tx = (socket.sent - before.sent) / elapsed;
        if (!rx && !tx)
            continue;
        const group = groups.get(socket.name) ?? {name: socket.name, pid: socket.pid, rx: 0, tx: 0, pids: new Set()};
        groups.set(socket.name, group);
        group.rx += rx;
        group.tx += tx;
        group.pids.add(socket.pid);
    }
    const apps = [...groups.values()]
        .map(({pids, ...group}) => ({...group, count: pids.size}))
        .sort((a, b) => b.rx + b.tx - (a.rx + a.tx) || a.name.localeCompare(b.name))
        .slice(0, count);
    return {apps, primed: true};
}

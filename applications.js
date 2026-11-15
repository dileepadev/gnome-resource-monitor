// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';

// Newer GJS moves this class to GioUnix; older GLib installations only have Gio.
let DesktopAppInfo;
try {
    DesktopAppInfo = (await import('gi://GioUnix')).default.DesktopAppInfo;
} catch {
    DesktopAppInfo = Gio.DesktopAppInfo;
}

// Treat renamed desktop IDs as one app, preferring the current ID.
const MONITOR_DESKTOP_IDS = [
    ['org.gnome.Resources.desktop', 'net.nokyan.Resources.desktop'],
    ['org.gnome.SystemMonitor.desktop'],
];

export function getMonitorApps() {
    const apps = [];
    for (const desktopIds of MONITOR_DESKTOP_IDS) {
        for (const desktopId of desktopIds) {
            const app = DesktopAppInfo.new(desktopId);
            if (app?.should_show()) {
                apps.push(app);
                break;
            }
        }
    }
    return apps;
}

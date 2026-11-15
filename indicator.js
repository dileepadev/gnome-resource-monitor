// SPDX-License-Identifier: MIT
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { SystemMonitor } from './system.js';
import {HistoryGraphs} from './historyGraphs.js';
import {ProcessMonitor} from './processMonitor.js';
import {Series} from './series.js';
import {UsageCalendar} from './usageCalendar.js';
import {localDay} from './usageTracker.js';
import {getMonitorApps} from './applications.js';
import {fillTemplate, formatBytes, formatPercent, formatSpeed, percentSamples, speedSamples} from './metrics.js';

const REFRESH_SECONDS = 1;

/**
 * Holds one value and reserves a width for it. Both the minimum and natural
 * widths are raised to the reservation (Clutter requires natural >= minimum),
 * and wider content still grows the slot, so values are never truncated.
 */
const ValueSlot = GObject.registerClass(
class ValueSlot extends St.Widget {
    _init(params) {
        super._init({...params, layout_manager: new Clutter.BinLayout()});
        this._reserved = 0;
    }

    setReservedWidth(width) {
        if (width === this._reserved)
            return;
        this._reserved = width;
        this.queue_relayout();
    }

    vfunc_get_preferred_width(forHeight) {
        const [minimum, natural] = super.vfunc_get_preferred_width(forHeight);
        return [Math.max(minimum, this._reserved), Math.max(natural, this._reserved)];
    }
});

export const ResourceMonitorIndicator = GObject.registerClass(
class ResourceMonitorIndicator extends PanelMenu.Button {
    _init(extensionDir, settings, openPreferences) {
        super._init(0.5, _('Resource Monitor'));
        this.add_style_class_name('resource-monitor-indicator');
        this._destroyed = false;
        this._extensionDir = extensionDir;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._usage = null;
        this._systemMonitor = new SystemMonitor();

        this._layout = new St.BoxLayout({
            style_class: 'panel-status-menu-box resource-monitor-box',
        });

        // Each value gets a slot wide enough for its widest possible text, so the
        // indicator keeps a constant width and neighbouring icons never shift.
        this._cpuItem = this._createItem('computer-chip-symbolic', percentSamples());
        this._ramItem = this._createItem('ssd-symbolic', percentSamples());
        this._downItem = this._createItem('arrow4-down-symbolic', speedSamples());
        this._upItem = this._createItem('arrow4-up-symbolic', speedSamples());
        for (const item of [this._cpuItem, this._ramItem, this._downItem, this._upItem])
            this._layout.add_child(item.box);

        this.add_child(this._layout);

        this._series = {cpu: new Series(), ram: new Series(), down: new Series(), up: new Series()};
        this._processMonitor = new ProcessMonitor();
        this._tick = 0;
        this._systemSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._systemSection);
        this._buildSystemMenu();
        this._systemSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._systemSeparator);

        this._usageSection = new PopupMenu.PopupMenuSection();
        this._appSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._usageSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._appSection);
        this._buildUsageMenu();
        this._refreshAppMenu();
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._refreshAppMenu();
                this.refreshUsage();
                return;
            }
            // Reopen to the overview: collapse submenus and leave focus mode.
            for (const item of [this._processesMenu, this._historyMenu, this._kindsMenu,
                this._networksMenu, this._systemMenu, this._calendarMenu])
                item.menu.close(false);
            this._syncFocus();
        });

        this.menu.actor.add_style_class_name('resource-monitor-menu');

        this._update();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });

        this.connect('destroy', () => {
            this._destroyed = true;
            this._systemMonitor.destroy();
            this._processMonitor.destroy();
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = null;
            }
        });
    }

    _processRow(menu) {
        const item = new St.BoxLayout({style_class: 'popup-menu-item resource-monitor-usage-row', reactive: true});
        const icon = new St.Icon({style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER});
        const name = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        name.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        const value = new St.Label({style_class: 'resource-monitor-usage-value', y_align: Clutter.ActorAlign.CENTER});
        item.add_child(icon);
        item.add_child(name);
        item.add_child(value);
        menu.box.add_child(item);
        return {item, icon, name, value};
    }

    _subheading(menu, text) {
        const box = new St.BoxLayout({style_class: 'popup-menu-item', reactive: true});
        box.add_child(new St.Label({text, style_class: 'resource-monitor-usage-heading'}));
        menu.box.add_child(box);
    }

    _buildSystemMenu() {
        this._processesMenu = new PopupMenu.PopupSubMenuMenuItem(_('Top Processes'));
        this._subheading(this._processesMenu.menu, _('CPU'));
        this._cpuRows = Array.from({length: 5}, () => this._processRow(this._processesMenu.menu));
        this._subheading(this._processesMenu.menu, _('Memory'));
        this._memoryRows = Array.from({length: 5}, () => this._processRow(this._processesMenu.menu));
        // Live per-app network rates from TCP socket counters (`ss`), when available.
        if (this._processMonitor.canSampleNetwork) {
            this._subheading(this._processesMenu.menu, _('Network (TCP)'));
            this._networkProcessRows = Array.from({length: 5}, () => this._processRow(this._processesMenu.menu));
        }
        this._processesMenu.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._processMonitor.reset();
                this._appsByExecutable = null; // Rebuilt from the installed apps on demand.
                this._refreshProcesses();
            }
            this._syncFocus();
        });
        this._systemSection.addMenuItem(this._processesMenu);

        this._historyMenu = new PopupMenu.PopupSubMenuMenuItem(_('History'));
        this._graphs = new HistoryGraphs(this._series);
        this._historyMenu.menu.box.add_child(this._graphs.actor);
        this._historyMenu.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._graphs.refresh();
            this._syncFocus();
        });
        this._systemSection.addMenuItem(this._historyMenu);
    }

    /**
     * Focus mode: an open Top Processes, History, or Calendar submenu hides the
     * other sections so its content fits on screen without scrolling.
     */
    _syncFocus() {
        const systemOpen = this._processesMenu.menu.isOpen || this._historyMenu.menu.isOpen;
        const calendarOpen = this._calendarMenu?.menu.isOpen ?? false;
        this._usageSection.actor.visible = !systemOpen;
        this._systemSection.actor.visible = !calendarOpen;
        this._systemSeparator.visible = !systemOpen && !calendarOpen;
    }

    /**
     * The app a process belongs to: the app owning a window for that process,
     * else an installed app whose program or window class matches the process
     * name (multi-process apps run helpers without windows).
     */
    _appForProcess(pid, name) {
        const app = Shell.WindowTracker.get_default().get_app_from_pid(pid);
        if (app)
            return app;
        const appSystem = Shell.AppSystem.get_default();
        if (!this._appsByExecutable) {
            this._appsByExecutable = new Map();
            for (const info of appSystem.get_installed()) {
                // Hidden helpers (for example the Shell's calendar server) are not apps.
                if (!info.should_show())
                    continue;
                const executable = GLib.path_get_basename(info.get_executable?.() ?? '');
                const id = info.get_id?.();
                if (executable && id && !this._appsByExecutable.has(executable))
                    this._appsByExecutable.set(executable, id);
            }
        }
        let id = this._appsByExecutable.get(name);
        // For example "brave" runs from "brave-browser-stable".
        if (!id && name.length >= 3) {
            for (const [executable, candidate] of this._appsByExecutable) {
                if (executable.startsWith(`${name}-`)) {
                    id = candidate;
                    break;
                }
            }
        }
        const found = (id && appSystem.lookup_app(id)) ?? appSystem.lookup_desktop_wmclass(name) ??
            appSystem.lookup_startup_wmclass(name) ?? null;
        return found?.get_app_info()?.should_show() === false ? null : found;
    }

    async _refreshProcesses() {
        let ranked;
        try {
            ranked = await this._processMonitor.sample();
        } catch {
            ranked = {cpu: [], memory: [], primed: true};
        }
        if (!ranked || this._destroyed)
            return;
        const show = (rows, list, format, waiting) => rows.forEach((row, index) => {
            const process = list[index];
            row.item.visible = Boolean(process) || index === 0;
            if (!process) {
                row.icon.gicon = null;
                row.icon.visible = false;
                row.name.set_text(index === 0 ? waiting : '');
                row.value.set_text('');
                return;
            }
            const app = this._appForProcess(process.pid, process.name);
            row.icon.visible = true;
            // Non-app processes (daemons, kernel threads) get a neutral gear icon.
            row.icon.gicon = app?.get_icon() ?? new Gio.ThemedIcon({name: 'emblem-system-symbolic'});
            const name = app?.get_name() ?? process.name;
            // Translators: a process name and how many processes share it, for example "code (12)".
            row.name.set_text(process.count > 1 ? fillTemplate(_('%s (%d)'), name, process.count) : name);
            row.value.set_text(format(process));
        });
        show(this._cpuRows, ranked.cpu, process => formatPercent(process.percent),
            ranked.primed ? _('No busy processes') : _('Measuring…'));
        show(this._memoryRows, ranked.memory, process => formatBytes(process.bytes), _('Measuring…'));
        if (!this._networkProcessRows)
            return;
        let network;
        try {
            network = await this._processMonitor.sampleNetwork();
        } catch {
            network = {apps: [], primed: true};
        }
        if (!network || this._destroyed)
            return;
        show(this._networkProcessRows, network.apps, app => fillTemplate(_('↓ %s  ↑ %s'),
            formatSpeed(app.rx), formatSpeed(app.tx)), network.primed ? _('No network activity') : _('Measuring…'));
    }

    setUsageTracker(tracker) {
        this._usage = tracker;
        this._calendar?.setTracker(tracker);
        this.refreshUsage();
    }

    // Information rows are plain boxes with menu-item padding. They are reactive
    // only because St marks non-reactive widgets :insensitive, which themes draw
    // dimmed; clicking them does nothing.
    _usageRow(title, menu = this._usageSection) {
        const item = new St.BoxLayout({style_class: 'popup-menu-item resource-monitor-usage-row', reactive: true});
        const name = new St.Label({text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const value = new St.Label({
            style_class: 'resource-monitor-usage-value',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(name);
        item.add_child(value);
        menu.box.add_child(item);
        return {item, name, value};
    }

    _buildUsageMenu() {
        const heading = new St.BoxLayout({style_class: 'popup-menu-item', reactive: true});
        heading.add_child(new St.Label({text: _('Data Usage'), style_class: 'resource-monitor-usage-heading'}));
        this._usageSection.box.add_child(heading);

        const statusItem = new St.BoxLayout({style_class: 'popup-menu-item', reactive: true});
        this._usageStatus = new St.Label({style_class: 'resource-monitor-usage-status', x_expand: true});
        this._usageStatus.clutter_text.set_line_wrap(true);
        this._usageStatus.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        statusItem.add_child(this._usageStatus);
        this._usageSection.box.add_child(statusItem);
        this._usageStatusItem = statusItem;

        this._periodRows = {
            today: this._usageRow(_('Today')),
            week: this._usageRow(_('This Week')),
            cycle: this._usageRow(_('This Month')),
            year: this._usageRow(_('This Year')),
            total: this._usageRow(_('All Time')),
        };
        this._capRow = this._usageRow(_('Monthly Limit'));
        this._vpnRow = this._usageRow(_('VPN (this month)'));

        this._kindsMenu = new PopupMenu.PopupSubMenuMenuItem(_('Connection Types'));
        this._kindRows = {
            wifi: this._usageRow(_('Wi-Fi'), this._kindsMenu.menu),
            ethernet: this._usageRow(_('Ethernet'), this._kindsMenu.menu),
            mobile: this._usageRow(_('Mobile and Tethering'), this._kindsMenu.menu),
        };
        this._usageSection.addMenuItem(this._kindsMenu);

        this._networksMenu = new PopupMenu.PopupSubMenuMenuItem(_('Networks'));
        this._networkRows = [];
        this._networkNames = '';
        this._usageSection.addMenuItem(this._networksMenu);

        this._systemMenu = new PopupMenu.PopupSubMenuMenuItem(_('Today\'s System Use'));
        this._systemRows = {
            cpu: this._usageRow(_('CPU'), this._systemMenu.menu),
            ram: this._usageRow(_('RAM'), this._systemMenu.menu),
            speed: this._usageRow(_('Peak Speed'), this._systemMenu.menu),
        };
        this._usageSection.addMenuItem(this._systemMenu);

        this._calendarMenu = new PopupMenu.PopupSubMenuMenuItem(_('Calendar'));
        this._calendar = new UsageCalendar({
            today: localDay,
            weekStart: () => this._settings.get_int('usage-week-start'),
        });
        this._calendarMenu.menu.box.add_child(this._calendar.actor);
        this._calendarMenu.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._calendar.reset();
            // Calendar mode hides the period rows so the grid and day details fit.
            this.refreshUsage();
            this._syncFocus();
        });
        this._usageSection.addMenuItem(this._calendarMenu);

        const settingsItem = new PopupMenu.PopupMenuItem(_('Data Usage Settings…'));
        settingsItem.connect('activate', () => this._openPreferences?.());
        this._usageSection.addMenuItem(settingsItem);
    }

    _transfer(totals) {
        // Translators: download and upload amounts, for example "↓ 1.2 GiB  ↑ 300 MiB".
        return fillTemplate(_('↓ %s  ↑ %s'), formatBytes(totals.rx), formatBytes(totals.tx));
    }

    _setStatus(text) {
        this._usageStatusItem.visible = Boolean(text);
        this._usageStatus.set_text(text ?? '');
    }

    /** Update the usage section; cheap enough to run every second while open. */
    refreshUsage() {
        if (this._destroyed || !this._usageSection)
            return;
        const tracker = this._usage;
        const rows = [...Object.values(this._periodRows), this._capRow, this._vpnRow];
        if (!tracker) {
            this._setStatus(_('Data usage tracking is off.'));
            for (const row of rows)
                row.item.visible = false;
            for (const menu of [this._kindsMenu, this._networksMenu, this._systemMenu, this._calendarMenu])
                menu.visible = false;
            return;
        }
        this._setStatus({
            loading: _('Loading saved statistics…'),
            retry: _('Saved statistics are locked. They will be included once the login keyring is unlocked; counting continues.'),
            unreadable: _('Saved statistics could not be read. New usage is not saved until you reset statistics in Data Usage Settings.'),
        }[tracker.state] ?? null);
        const summary = tracker.summary();
        const calendarMode = this._calendarMenu.menu.isOpen;
        for (const [key, row] of Object.entries(this._periodRows)) {
            row.item.visible = !calendarMode;
            row.value.set_text(this._transfer(summary[key]));
        }
        const billingDay = this._settings.get_int('usage-billing-day');
        const since = () => {
            const [year, month, day] = summary.cycle.from.split('-').map(Number);
            return GLib.DateTime.new_local(year, month, day, 0, 0, 0).format('%b %-d');
        };
        // Translators: %s is a date such as "Nov 10".
        this._periodRows.cycle.name.set_text(billingDay === 1 ? _('This Month') : fillTemplate(_('Since %s'), since()));

        const cap = tracker.capBytes();
        this._capRow.item.visible = cap > 0 && !calendarMode;
        if (cap > 0) {
            const used = summary.cycle.rx + summary.cycle.tx;
            // Translators: percentage of the monthly limit used, for example "42% of 50.0 GiB".
            this._capRow.value.set_text(fillTemplate(_('%d%% of %s'), Math.floor(100 * used / cap), formatBytes(cap)));
        }
        const vpn = {rx: summary.cycle.vpnRx, tx: summary.cycle.vpnTx};
        this._vpnRow.item.visible = vpn.rx + vpn.tx > 0 && !calendarMode;
        this._vpnRow.name.set_text(billingDay === 1 ? _('VPN (this month)') : _('VPN (this period)'));
        this._vpnRow.value.set_text(this._transfer(vpn));

        this._kindsMenu.visible = !calendarMode;
        for (const [kind, row] of Object.entries(this._kindRows))
            row.value.set_text(this._transfer(summary.cycle.kinds[kind]));

        const trackNetworks = this._settings.get_boolean('usage-track-networks');
        this._networksMenu.visible = (trackNetworks || summary.networks.length > 0) && !calendarMode;
        const names = JSON.stringify(summary.networks.map(network => network.name));
        if (names !== this._networkNames) {
            this._networkNames = names;
            this._networksMenu.menu.box.destroy_all_children();
            this._networkRows = summary.networks.map(network => this._usageRow(network.name, this._networksMenu.menu));
            if (!this._networkRows.length)
                this._usageRow(_('No network usage recorded yet'), this._networksMenu.menu);
        }
        summary.networks.forEach((network, index) => this._networkRows[index].value.set_text(this._transfer(network)));

        this._calendarMenu.visible = true;
        if (this._calendarMenu.menu.isOpen)
            this._calendar.refresh();

        const system = summary.system;
        this._systemMenu.visible = !calendarMode;
        const stats = (average, peak) => average === null ? '—'
            // Translators: average and peak percentages, for example "avg 23.4%  peak 98.1%".
            : fillTemplate(_('avg %s  peak %s'), formatPercent(average), formatPercent(peak));
        this._systemRows.cpu.value.set_text(stats(system.cpuAverage, system.cpuPeak));
        this._systemRows.ram.value.set_text(stats(system.ramAverage, system.ramPeak));
        this._systemRows.speed.value.set_text(fillTemplate(_('↓ %s  ↑ %s'),
            formatSpeed(system.peakRx), formatSpeed(system.peakTx)));
    }

    _refreshAppMenu() {
        this._appSection.removeAll();
        const apps = getMonitorApps();
        if (apps.length === 0) {
            const item = new PopupMenu.PopupMenuItem(_('No system monitor app installed'));
            item.setSensitive(false);
            this._appSection.addMenuItem(item);
            return;
        }

        for (const app of apps) {
            // Translators: %s is the installed application's localized name.
            const label = fillTemplate(_('Open %s'), app.get_display_name());
            const item = new PopupMenu.PopupMenuItem(label);
            const icon = new St.Icon({
                gicon: app.get_icon() ?? new Gio.ThemedIcon({name: 'utilities-system-monitor-symbolic'}),
                style_class: 'popup-menu-icon',
            });
            item.insert_child_at_index(icon, 0);
            item.connect('activate', () => {
                try {
                    if (!app.launch([], global.create_app_launch_context(0, -1)))
                        throw new Error(`Failed to launch ${app.get_id()}`);
                } catch (error) {
                    console.error('Resource Monitor: could not launch monitor application', error);
                    Main.notify(_('Resource Monitor'),
                        fillTemplate(_('Could not open %s.'), app.get_display_name()));
                }
            });
            this._appSection.addMenuItem(item);
        }
    }

    _createItem(iconName, samples) {
        const box = new St.BoxLayout({style_class: 'resource-monitor-item'});

        // Use gicon for custom/file icon support
        const icon = new St.Icon({
            gicon: this._getGIcon(iconName),
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
            icon_size: 14,
        });
        const label = new St.Label({
            text: '—',
            style_class: 'resource-monitor-value',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        label.clutter_text.set_single_line_mode(true);
        label.clutter_text.set_line_wrap(false);
        // Never truncate: the slot only sets a minimum width, so an unexpectedly
        // wide value widens the indicator instead of showing an ellipsis.
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);

        // The slot reserves the width; the value is right-aligned inside it so
        // units line up and spare space sits between the icon and the value.
        const slot = new ValueSlot({y_align: Clutter.ActorAlign.CENTER});
        slot.add_child(label);

        box.add_child(icon);
        box.add_child(slot);

        const item = {box, label, slot, samples};
        // Re-measure whenever font, text scaling, display scaling, or theme change.
        label.connect('style-changed', () => this._reserveWidth(item));
        return item;
    }

    /** Set the slot's minimum width to the widest sample in the current style. */
    _reserveWidth(item) {
        const {label, slot, samples} = item;
        if (this._destroyed || this._measuring || !label.get_stage())
            return;
        this._measuring = true;
        const text = label.get_text();
        let width = 0;
        try {
            for (const sample of samples) {
                label.set_text(sample);
                width = Math.max(width, label.get_preferred_width(-1)[1]);
            }
        } finally {
            label.set_text(text);
            this._measuring = false;
        }
        if (width > 0)
            slot.setReservedWidth(Math.ceil(width));
    }

    _getGIcon(name) {
        // Bundled icons always ship with the extension; no filesystem check needed.
        if (this._extensionDir)
            return new Gio.FileIcon({file: this._extensionDir.get_child('icons').get_child(`${name}.svg`)});
        return new Gio.ThemedIcon({name});
    }

    async _update() {
        try {
            const sample = await this._systemMonitor.sample();
            if (this._destroyed || !sample)
                return;
            this._usage?.record(sample);
            this._series.cpu.push(sample.cpu);
            this._series.ram.push(sample.ram);
            this._series.down.push(sample.network?.recvRate);
            this._series.up.push(sample.network?.sentRate);
            this._tick++;
            if (this.menu.isOpen) {
                // The usage section is hidden while Top Processes or History is open.
                if (this._usageSection.actor.visible)
                    this.refreshUsage();
                if (this._historyMenu.menu.isOpen)
                    this._graphs.refresh();
                if (this._processesMenu.menu.isOpen && this._tick % 2 === 0)
                    this._refreshProcesses();
            }
            this._setText(this._cpuItem.label, formatPercent(sample.cpu));
            this._setText(this._ramItem.label, formatPercent(sample.ram));
            this._setText(this._downItem.label, formatSpeed(sample.network?.recvRate));
            this._setText(this._upItem.label, formatSpeed(sample.network?.sentRate));
            // Screen readers read the button's name; keep it in step with the readings.
            const accessible = fillTemplate(_('Resource Monitor: CPU %s, RAM %s, download %s, upload %s'),
                this._cpuItem.label.text, this._ramItem.label.text, this._downItem.label.text, this._upItem.label.text);
            if (this.accessible_name !== accessible)
                this.accessible_name = accessible;
        } catch (error) {
            if (!this._destroyed)
                console.error('Resource Monitor: sampling failed', error);
        }
    }

    _setText(label, text) {
        if (label.get_text() !== text)
            label.set_text(text);
    }
});

// SPDX-License-Identifier: MIT
// Month calendar of daily data usage, shown inside the panel menu.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fillTemplate, formatBytes, formatPercent, formatSpeed} from './metrics.js';
import {addDays, weekStartOf} from './usage.js';

const CELLS = 42; // Six rows keep the calendar height constant.

// GNOME 48+ uses `orientation`; GNOME 51 removed `vertical`.
function verticalBox(params) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}
const LEVELS = 4;

function dateTime(day) {
    const [year, month, date] = day.split('-').map(Number);
    return GLib.DateTime.new_local(year, month, date, 0, 0, 0);
}

function monthKey(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
}

function transfer(totals) {
    // Translators: download and upload amounts, for example "↓ 1.2 GiB  ↑ 300 MiB".
    return fillTemplate(_('↓ %s  ↑ %s'), formatBytes(totals.rx), formatBytes(totals.tx));
}

export class UsageCalendar {
    /** today(): local date key; weekStart(): 0–6. */
    constructor({today, weekStart}) {
        this._today = today;
        this._weekStart = weekStart;
        this._tracker = null;
        this._selected = null;
        this._renderedWeekStart = null;

        this.actor = verticalBox({style_class: 'resource-monitor-calendar', x_expand: true});

        const header = new St.BoxLayout({style_class: 'resource-monitor-calendar-header'});
        this._previous = this._navButton('go-previous-symbolic', _('Previous month'), -1);
        this._title = new St.Label({
            style_class: 'resource-monitor-calendar-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._next = this._navButton('go-next-symbolic', _('Next month'), 1);
        header.add_child(this._previous);
        header.add_child(this._title);
        header.add_child(this._next);
        this.actor.add_child(header);

        const layout = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true});
        this._grid = new St.Widget({style_class: 'resource-monitor-calendar-grid', layout_manager: layout});
        this._weekdays = [];
        for (let column = 0; column < 7; column++) {
            const label = new St.Label({style_class: 'resource-monitor-calendar-weekday',
                x_align: Clutter.ActorAlign.CENTER});
            layout.attach(label, column, 0, 1, 1);
            this._weekdays.push(label);
        }
        this._cells = [];
        for (let index = 0; index < CELLS; index++) {
            const button = new St.Button({
                style_class: 'resource-monitor-calendar-day',
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => {
                if (button._day)
                    this.select(button._day);
            });
            layout.attach(button, index % 7, 1 + Math.floor(index / 7), 1, 1);
            this._cells.push(button);
        }
        this.actor.add_child(this._grid);

        this._detailTitle = new St.Label({style_class: 'resource-monitor-calendar-detail-title'});
        this.actor.add_child(this._detailTitle);
        this._details = verticalBox({style_class: 'resource-monitor-calendar-details', x_expand: true});
        this._detailKey = null;
        this.actor.add_child(this._details);
    }

    _navButton(iconName, accessibleName, step) {
        const button = new St.Button({
            style_class: 'resource-monitor-calendar-nav',
            can_focus: true,
            accessible_name: accessibleName,
            child: new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}),
        });
        button.connect('clicked', () => this._moveMonth(step));
        return button;
    }

    setTracker(tracker) {
        this._tracker = tracker;
        this.reset();
    }

    /** Show the current month with today selected. */
    reset() {
        const today = this._today();
        this._year = Number(today.slice(0, 4));
        this._month = Number(today.slice(5, 7));
        this._selected = today;
        this.refresh();
    }

    select(day) {
        this._selected = day;
        this.refresh();
    }

    _moveMonth(step) {
        let month = this._month + step;
        let year = this._year;
        if (month < 1) {
            month = 12;
            year--;
        } else if (month > 12) {
            month = 1;
            year++;
        }
        this._year = year;
        this._month = month;
        // Keep a selection inside the shown month when one has data.
        const overview = this._tracker?.monthOverview(monthKey(year, month));
        const days = [...overview?.recorded ?? []].sort();
        const today = this._today();
        this._selected = today.startsWith(monthKey(year, month)) ? today : days.at(-1) ?? null;
        this.refresh();
    }

    _row(name, value) {
        this._rows.push([name, value]);
    }

    _addRow(name, value) {
        const row = new St.BoxLayout({style_class: 'resource-monitor-calendar-detail-row'});
        row.add_child(new St.Label({text: name, x_expand: true}));
        row.add_child(new St.Label({text: value, style_class: 'resource-monitor-usage-value'}));
        this._details.add_child(row);
    }

    /** Update the grid and details in place; cheap enough to run every second. */
    refresh() {
        const tracker = this._tracker;
        const today = this._today();
        const month = monthKey(this._year, this._month);
        const first = `${month}-01`;
        const weekStart = this._weekStart();

        this._title.set_text(dateTime(first).format('%B %Y'));
        if (this._renderedWeekStart !== weekStart) {
            // Weekday names come from a known week: 2026-11-08 is a Sunday.
            this._weekdays.forEach((label, column) =>
                label.set_text(dateTime(addDays('2026-11-08', (weekStart + column) % 7)).format('%a')));
            this._renderedWeekStart = weekStart;
        }

        const overview = tracker?.monthOverview(month) ?? {days: {}, max: 0, recorded: new Set()};
        const earliest = tracker?.firstRecordedDay() ?? today;
        this._previous.reactive = first > earliest.slice(0, 8) + '01';
        this._next.reactive = month < today.slice(0, 7);
        for (const button of [this._previous, this._next])
            button.opacity = button.reactive ? 255 : 90;

        const start = weekStartOf(first, weekStart);
        this._cells.forEach((button, index) => {
            const day = addDays(start, index);
            const inMonth = day.startsWith(month);
            const recorded = inMonth && overview.recorded.has(day);
            const total = overview.days[day] ?? 0;
            const level = recorded && overview.max > 0 && total > 0
                ? Math.max(1, Math.ceil(LEVELS * total / overview.max)) : 0;
            button._day = recorded || day === today ? day : null;
            button.label = inMonth ? String(Number(day.slice(8))) : '';
            button.opacity = inMonth ? 255 : 0;
            button.reactive = Boolean(inMonth && button._day);
            button.can_focus = button.reactive;
            for (let value = 1; value <= LEVELS; value++)
                button[value === level ? 'add_style_class_name' : 'remove_style_class_name'](`level-${value}`);
            button[day === today ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('today');
            button[day === this._selected && inMonth ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('selected');
            const date = dateTime(day).format('%A, %B %-d');
            // Translators: accessible name of a calendar day, for example "Friday, November 13: ↓ 1.2 GiB  ↑ 300 MiB".
            button.accessible_name = recorded
                ? fillTemplate(_('%s: %s'), date, transfer(tracker.dayDetail(day)))
                : date;
        });
        this._showDetails(today);
    }

    _showDetails(today) {
        this._rows = [];
        this._collectDetails(today);
        // Rebuild only when the content changes.
        const key = JSON.stringify(this._rows);
        if (key === this._detailKey)
            return;
        this._detailKey = key;
        this._details.destroy_all_children();
        for (const [name, value] of this._rows)
            this._addRow(name, value);
    }

    _collectDetails(today) {
        const day = this._selected;
        if (!day || !day.startsWith(monthKey(this._year, this._month))) {
            this._detailTitle.set_text(_('Select a day to see its statistics'));
            return;
        }
        this._detailTitle.set_text(day === today ? _('Today') : dateTime(day).format('%A, %B %-d'));
        const detail = this._tracker?.dayDetail(day);
        if (!detail) {
            this._row(_('No data recorded'), '');
            return;
        }
        this._row(_('Data'), transfer(detail));
        if (detail.vpnRx + detail.vpnTx > 0)
            this._row(_('VPN'), transfer({rx: detail.vpnRx, tx: detail.vpnTx}));
        const kinds = {wifi: _('Wi-Fi'), ethernet: _('Ethernet'), mobile: _('Mobile and Tethering')};
        for (const [kind, name] of Object.entries(kinds)) {
            if (detail.kinds[kind].rx + detail.kinds[kind].tx > 0)
                this._row(name, transfer(detail.kinds[kind]));
        }
        for (const network of detail.networks.slice(0, 5))
            this._row(network.name, transfer(network));
        const stats = (average, peak) => average === null ? '—'
            // Translators: average and peak percentages, for example "avg 23.4%  peak 98.1%".
            : fillTemplate(_('avg %s  peak %s'), formatPercent(average), formatPercent(peak));
        this._row(_('CPU'), stats(detail.system.cpuAverage, detail.system.cpuPeak));
        this._row(_('RAM'), stats(detail.system.ramAverage, detail.system.ramPeak));
        this._row(_('Peak Speed'), fillTemplate(_('↓ %s  ↑ %s'),
            formatSpeed(detail.system.peakRx), formatSpeed(detail.system.peakTx)));
    }
}

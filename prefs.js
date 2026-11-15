// SPDX-License-Identifier: MIT
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {createAboutPage} from './about.js';

const WEEK_STARTS = [1, 0, 6]; // Monday, Sunday, Saturday

function spinRow(settings, key, {title, subtitle, lower, upper, step = 1, digits = 0}) {
    const row = new Adw.SpinRow({
        title, digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, {title, subtitle}) {
    const row = new Adw.SwitchRow({title});
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class ResourceMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('Data Usage'),
            icon_name: 'network-transmit-receive-symbolic',
        });
        window.add(page);

        const tracking = new Adw.PreferencesGroup({
            title: _('Tracking'),
            description: _('Counts data sent and received over Wi-Fi, Ethernet, and mobile connections while you are logged in. VPN traffic is shown separately because it also crosses one of those connections.'),
        });
        tracking.add(switchRow(settings, 'usage-tracking', {
            title: _('Track Data Usage'),
            subtitle: _('Turning this off stops counting and keeps saved statistics'),
        }));
        tracking.add(switchRow(settings, 'usage-track-networks', {
            title: _('Track Usage per Network'),
            subtitle: _('Records connection names such as Wi-Fi network names, which can reveal places you have been. Turning this off forgets the recorded names.'),
        }));
        page.add(tracking);

        const periods = new Adw.PreferencesGroup({title: _('Periods')});
        periods.add(spinRow(settings, 'usage-billing-day', {
            title: _('Monthly Period Starts On'),
            subtitle: _('Day of the month, for example your mobile plan\'s billing date'),
            lower: 1, upper: 28,
        }));
        const weekStart = new Adw.ComboRow({
            title: _('First Day of the Week'),
            model: Gtk.StringList.new([_('Monday'), _('Sunday'), _('Saturday')]),
        });
        const syncWeekStart = () => {
            const index = WEEK_STARTS.indexOf(settings.get_int('usage-week-start'));
            weekStart.selected = index < 0 ? 0 : index;
        };
        syncWeekStart();
        weekStart.connect('notify::selected', () => {
            const value = WEEK_STARTS[weekStart.selected] ?? 1;
            if (settings.get_int('usage-week-start') !== value)
                settings.set_int('usage-week-start', value);
        });
        const weekSignal = settings.connect('changed::usage-week-start', syncWeekStart);
        window.connect('close-request', () => {
            settings.disconnect(weekSignal);
            return false;
        });
        periods.add(weekStart);
        page.add(periods);

        const limit = new Adw.PreferencesGroup({
            title: _('Monthly Data Limit'),
            description: _('Shows progress in the menu and notifies you near and at the limit. Download plus upload counts toward the limit.'),
        });
        limit.add(spinRow(settings, 'usage-monthly-cap-gib', {
            title: _('Limit (GiB)'),
            subtitle: _('0 turns the limit off'),
            lower: 0, upper: 1000000, step: 1, digits: 1,
        }));
        limit.add(spinRow(settings, 'usage-cap-warning-percent', {
            title: _('Warn At (%)'),
            lower: 50, upper: 99,
        }));
        page.add(limit);

        const storage = new Adw.PreferencesGroup({
            title: _('Storage and Privacy'),
            description: _('Statistics are saved encrypted in the gnome-resource-monitor folder of your local data directory. The encryption key is kept in your login keyring. If the keyring is locked, counting continues and is saved once it unlocks. Encryption protects the saved file; it does not hide statistics from programs running in your session.'),
        });
        storage.add(spinRow(settings, 'usage-retention-days', {
            title: _('Keep Daily History (Days)'),
            subtitle: _('Monthly and all-time totals are kept'),
            lower: 62, upper: 3650, step: 1,
        }));
        const reset = new Adw.ActionRow({
            title: _('Reset Statistics'),
            subtitle: _('Deletes all saved usage statistics and their encryption key'),
        });
        const resetButton = new Gtk.Button({
            label: _('Reset…'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Reset Data Usage Statistics?'),
                body: _('All saved data usage and daily system statistics will be permanently deleted.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Reset'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.connect('response', (_dialog, response) => {
                if (response === 'reset')
                    settings.set_int64('usage-reset-request', GLib.get_real_time());
            });
            dialog.present(window);
        });
        reset.add_suffix(resetButton);
        storage.add(reset);
        page.add(storage);

        window.add(createAboutPage({
            metadata: this.metadata,
            iconName: 'utilities-system-monitor-symbolic',
            iconFile: this.dir.get_child('icons').get_child('computer-chip-symbolic.svg'),
            description: _('Real-time CPU, RAM, and network usage in the GNOME top bar, with top processes, history graphs, and encrypted data-usage statistics including a daily calendar.'),
            privacy: _('Statistics stay on this computer, encrypted with a key in your login keyring. Nothing is sent over the network.'),
            developer: 'Dileepa Bandara',
            credits: [[_('Icons'), _('GNOME icon library (gitlab.gnome.org/World/design/icon-library)')]],
            _,
        }));
    }
}

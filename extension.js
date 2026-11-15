// SPDX-License-Identifier: MIT

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ResourceMonitorIndicator} from './indicator.js';
import {fillTemplate, formatBytes} from './metrics.js';
import {resetSavedUsage, UsageTracker} from './usageTracker.js';

export default class ResourceMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new ResourceMonitorIndicator(this.dir, this._settings,
            () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._settingsSignals = [
            this._settings.connect('changed::usage-tracking', () => this._syncTracker()),
            this._settings.connect('changed::usage-track-networks', () =>
                this._tracker?.setTrackNetworks(this._settings.get_boolean('usage-track-networks'))),
            this._settings.connect('changed::usage-reset-request', () => this._reset()),
            ...['usage-monthly-cap-gib', 'usage-cap-warning-percent', 'usage-billing-day'].map(key =>
                this._settings.connect(`changed::${key}`, () => this._tracker?.recheckCap())),
        ];
        this._syncTracker();
    }

    _syncTracker() {
        const enabled = this._settings.get_boolean('usage-tracking');
        if (enabled && !this._tracker) {
            this._tracker = new UsageTracker(this._settings, {
                onCapLevel: (level, used, cap) => this._notifyCap(level, used, cap),
                onChanged: () => this._indicator?.refreshUsage(),
            });
        } else if (!enabled && this._tracker) {
            this._tracker.destroy();
            this._tracker = null;
        }
        this._indicator.setUsageTracker(this._tracker ?? null);
    }

    _reset() {
        if (this._tracker)
            this._tracker.reset();
        else
            resetSavedUsage();
        this._indicator?.refreshUsage();
    }

    _notifyCap(level, used, cap) {
        const title = level >= 2 ? _('Monthly data limit reached')
            : _('Approaching monthly data limit');
        // Translators: the first %s is data used, the second the monthly limit.
        const body = fillTemplate(_('%s of %s used this period.'), formatBytes(used), formatBytes(cap));
        Main.notify(title, body);
    }

    disable() {
        for (const id of this._settingsSignals ?? [])
            this._settings.disconnect(id);
        this._settingsSignals = null;
        // Stop counting synchronously; the final encrypted save drains in the
        // background and the next enable waits for it.
        this._tracker?.destroy();
        this._tracker = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}

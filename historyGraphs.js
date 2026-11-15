// SPDX-License-Identifier: MIT
// Small CPU, RAM, and network history graphs for the panel menu.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fillTemplate, formatPercent, formatSpeed} from './metrics.js';
import {downsample, niceMax} from './series.js';

const RANGES = [[60, () => _('1 min')], [600, () => _('10 min')], [3600, () => _('1 h')]];
const COLORS = {
    cpu: [0.21, 0.52, 0.89],
    ram: [0.18, 0.76, 0.49],
    down: [0.21, 0.52, 0.89],
    up: [0.90, 0.38, 0.0],
};

function verticalBox(params) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function foreground(actor) {
    try {
        const color = actor.get_theme_node().get_foreground_color();
        return [color.red / 255, color.green / 255, color.blue / 255];
    } catch {
        return [0.5, 0.5, 0.5];
    }
}

export class HistoryGraphs {
    /** series: {cpu, ram, down, up} Series objects. */
    constructor(series) {
        this._series = series;
        this._range = 600;
        this.actor = verticalBox({style_class: 'resource-monitor-graphs', x_expand: true});

        const ranges = new St.BoxLayout({style_class: 'resource-monitor-graph-ranges', x_align: Clutter.ActorAlign.CENTER});
        this._rangeButtons = RANGES.map(([seconds, label]) => {
            const button = new St.Button({
                label: label(),
                style_class: 'resource-monitor-graph-range',
                toggle_mode: true,
                can_focus: true,
                checked: seconds === this._range,
            });
            button.connect('clicked', () => {
                this._range = seconds;
                this._rangeButtons.forEach(([value, other]) => (other.checked = value === seconds));
                this.refresh();
            });
            ranges.add_child(button);
            return [seconds, button];
        });
        this.actor.add_child(ranges);

        this._graphs = {
            cpu: this._graph(_('CPU'), ['cpu']),
            ram: this._graph(_('RAM'), ['ram']),
            network: this._graph(_('Network'), ['down', 'up']),
        };
    }

    _graph(title, keys) {
        const box = verticalBox({style_class: 'resource-monitor-graph-box'});
        const header = new St.BoxLayout();
        header.add_child(new St.Label({text: title, x_expand: true, style_class: 'resource-monitor-graph-title'}));
        const value = new St.Label({style_class: 'resource-monitor-usage-value'});
        header.add_child(value);
        box.add_child(header);
        const area = new St.DrawingArea({style_class: 'resource-monitor-graph', x_expand: true});
        const graph = {keys, value, area, max: 100, data: {}};
        area.connect('repaint', () => this._draw(graph));
        box.add_child(area);
        const scale = new St.Label({style_class: 'resource-monitor-graph-scale', x_align: Clutter.ActorAlign.END});
        graph.scale = scale;
        box.add_child(scale);
        this.actor.add_child(box);
        return graph;
    }

    _draw(graph) {
        const area = graph.area;
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        try {
            const [r, g, b] = foreground(area);
            cr.setLineWidth(1);
            cr.setSourceRGBA(r, g, b, 0.15);
            for (const fraction of [0, 0.5, 1]) {
                const y = Math.round(fraction * (height - 1)) + 0.5;
                cr.moveTo(0, y);
                cr.lineTo(width, y);
            }
            cr.stroke();
            for (const key of graph.keys) {
                const points = graph.data[key] ?? [];
                const [red, green, blue] = COLORS[key];
                const step = points.length > 1 ? width / (points.length - 1) : width;
                const y = value => height - 1 - Math.min(1, value / graph.max) * (height - 2);
                // Draw each run of recorded values; gaps stay empty.
                let run = [];
                const flush = () => {
                    if (run.length) {
                        cr.moveTo(run[0][0], height);
                        for (const [x, top] of run)
                            cr.lineTo(x, top);
                        cr.lineTo(run.at(-1)[0], height);
                        cr.closePath();
                        cr.setSourceRGBA(red, green, blue, graph.keys.length > 1 ? 0.15 : 0.25);
                        cr.fill();
                        cr.moveTo(...run[0]);
                        for (const point of run.slice(1))
                            cr.lineTo(...point);
                        cr.setSourceRGBA(red, green, blue, 1);
                        cr.setLineWidth(1.5);
                        cr.stroke();
                    }
                    run = [];
                };
                points.forEach((value, index) => {
                    if (value === null)
                        flush();
                    else
                        run.push([index * step, y(value)]);
                });
                flush();
            }
        } finally {
            cr.$dispose();
        }
    }

    /** Update data and labels, then repaint. Cheap enough to run every second. */
    refresh() {
        const buckets = Math.max(2, Math.floor((this._graphs.cpu.area.width || 240) / 2));
        const take = key => downsample(this._series[key].last(this._range), Math.min(buckets, this._range));
        const latest = key => this._series[key].last(1)[0];

        const cpu = this._graphs.cpu;
        cpu.data = {cpu: take('cpu')};
        cpu.value.set_text(formatPercent(latest('cpu')));
        cpu.scale.set_text('');
        const ram = this._graphs.ram;
        ram.data = {ram: take('ram')};
        ram.value.set_text(formatPercent(latest('ram')));
        ram.scale.set_text('');

        const network = this._graphs.network;
        network.data = {down: take('down'), up: take('up')};
        network.max = niceMax([...network.data.down, ...network.data.up]);
        // Translators: current download and upload rates.
        network.value.set_text(fillTemplate(_('↓ %s  ↑ %s'), formatSpeed(latest('down')), formatSpeed(latest('up'))));
        // Translators: the network graph's top value, for example "max 2.00 MiB/s".
        network.scale.set_text(fillTemplate(_('scale %s'), formatSpeed(network.max)));

        // Screen readers cannot see the drawing; describe it instead.
        const range = RANGES.find(([seconds]) => seconds === this._range)[1]();
        const peak = values => Math.max(...values.filter(value => value !== null), 0);
        const describe = (graph, title, text) => {
            graph.area.accessible_name = fillTemplate(_('%s history, last %s: %s'), title, range, text);
        };
        describe(cpu, _('CPU'), fillTemplate(_('now %s, peak %s'), formatPercent(latest('cpu')), formatPercent(peak(cpu.data.cpu))));
        describe(ram, _('RAM'), fillTemplate(_('now %s, peak %s'), formatPercent(latest('ram')), formatPercent(peak(ram.data.ram))));
        describe(network, _('Network'), fillTemplate(_('download peak %s, upload peak %s'),
            formatSpeed(peak(network.data.down)), formatSpeed(peak(network.data.up))));

        for (const graph of Object.values(this._graphs))
            graph.area.queue_repaint();
    }
}

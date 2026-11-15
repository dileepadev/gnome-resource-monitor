// SPDX-License-Identifier: MIT
// Shared "About" preferences page (preferences process only; GTK 4/libadwaita).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

function openUri(widget, uri) {
    try {
        new Gtk.UriLauncher({uri}).launch(widget.get_root(), null, null);
    } catch {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    }
}

function linkRow(title, uri) {
    // Plain text: rows interpret titles as Pango markup by default.
    const row = new Adw.ActionRow({title, subtitle: uri, activatable: true, use_markup: false});
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic', valign: Gtk.Align.CENTER}));
    row.connect('activated', () => openUri(row, uri));
    return row;
}

function infoRow(title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle, use_markup: false});
    row.subtitle_selectable = true;
    return row;
}

/**
 * metadata: the extension's metadata; iconName/iconFile: themed icon name or a
 * Gio.File; description: one paragraph; privacy: short privacy summary;
 * credits: [[title, text]]; _: the extension's gettext function.
 */
export function createAboutPage({metadata, iconName, iconFile = null, description, privacy, developer,
    credits = [], _}) {
    const page = new Adw.PreferencesPage({title: _('About'), icon_name: 'help-about-symbolic'});

    const header = new Adw.PreferencesGroup();
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        halign: Gtk.Align.CENTER, margin_top: 12, margin_bottom: 12,
    });
    const icon = iconFile?.query_exists(null)
        ? Gtk.Image.new_from_gicon(new Gio.FileIcon({file: iconFile}))
        : new Gtk.Image({icon_name: iconName});
    icon.pixel_size = 64;
    box.append(icon);
    box.append(new Gtk.Label({label: metadata.name, css_classes: ['title-1']}));
    const version = metadata['version-name'] ?? (metadata.version ? String(metadata.version) : null);
    if (version) {
        // Translators: %s is the extension version.
        box.append(new Gtk.Label({label: _('Version %s').replace('%s', () => version), css_classes: ['dim-label']}));
    }
    box.append(new Gtk.Label({
        label: description, wrap: true, justify: Gtk.Justification.CENTER, max_width_chars: 52,
    }));
    header.add(box);
    page.add(header);

    const links = new Adw.PreferencesGroup({title: _('Links')});
    if (metadata.url) {
        links.add(linkRow(_('Website'), metadata.url));
        links.add(linkRow(_('Report an Issue'), `${metadata.url}/issues`));
        links.add(linkRow(_('License'), `${metadata.url}/blob/main/LICENSE`));
    }
    page.add(links);

    const details = new Adw.PreferencesGroup({title: _('Details')});
    if (developer)
        details.add(infoRow(_('Developer'), developer));
    details.add(infoRow(_('Extension ID'), metadata.uuid));
    details.add(infoRow(_('License'), _('MIT License')));
    if (privacy)
        details.add(infoRow(_('Privacy'), privacy));
    for (const [title, text] of credits)
        details.add(infoRow(title, text));
    page.add(details);
    return page;
}

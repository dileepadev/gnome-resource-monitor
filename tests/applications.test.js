// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {getMonitorApps} from '../applications.js';

// Each probe gets fresh XDG directories, independent of the host's installed apps.
if (ARGV[0] === '--probe') {
    print(JSON.stringify(getMonitorApps().map(app => app.get_id())));
} else {
    const resources = 'org.gnome.Resources.desktop';
    const legacyResources = 'net.nokyan.Resources.desktop';
    const systemMonitor = 'org.gnome.SystemMonitor.desktop';
    const cases = [
        {name: 'neither app', entries: [], expected: []},
        {name: 'Resources only', entries: [[resources]], expected: [resources]},
        {name: 'System Monitor only', entries: [[systemMonitor]], expected: [systemMonitor]},
        {name: 'both apps', entries: [[resources], [systemMonitor]], expected: [resources, systemMonitor]},
        {name: 'legacy Resources ID', entries: [[legacyResources]], expected: [legacyResources]},
        {
            name: 'duplicate Resources IDs',
            entries: [[resources], [legacyResources], [systemMonitor]],
            expected: [resources, systemMonitor],
        },
        {
            name: 'hidden entries are omitted',
            entries: [[resources, 'Hidden=true'], [systemMonitor, 'NoDisplay=true']],
            expected: [],
        },
        {
            name: 'missing executable is omitted',
            entries: [[resources, 'TryExec=/nonexistent/resource-monitor-test-app']],
            expected: [],
        },
        {
            name: 'exported app in XDG_DATA_DIRS',
            entries: [[legacyResources, '', true]],
            expected: [legacyResources],
        },
    ];
    const root = Gio.File.new_for_path(GLib.dir_make_tmp('resource-monitor-apps-XXXXXX'));
    const script = Gio.File.new_for_uri(import.meta.url).get_path();
    const decoder = new TextDecoder();

    function removeTree(file) {
        if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
            const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            try {
                let child;
                while ((child = children.next_file(null)))
                    removeTree(file.get_child(child.get_name()));
            } finally {
                children.close(null);
            }
        }
        file.delete(null);
    }

    try {
        for (const [index, scenario] of cases.entries()) {
            const local = root.get_child(`${index}/local`).get_path();
            const exported = root.get_child(`${index}/exported`).get_path();
            for (const path of [local, exported])
                GLib.mkdir_with_parents(`${path}/applications`, 0o700);
            for (const [id, extra = '', isExported = false] of scenario.entries) {
                GLib.file_set_contents(`${isExported ? exported : local}/applications/${id}`,
                    `[Desktop Entry]\nType=Application\nName=Test Monitor\nExec=/bin/true\nIcon=utilities-system-monitor\n${extra}\n`);
            }
            let env = GLib.environ_setenv(GLib.get_environ(), 'XDG_DATA_HOME', local, true);
            env = GLib.environ_setenv(env, 'XDG_DATA_DIRS', exported, true);
            const [success, stdout, stderr, status] = GLib.spawn_sync(null,
                [GLib.find_program_in_path('gjs'), '-m', script, '--probe'], env,
                GLib.SpawnFlags.DEFAULT, null);
            if (!success || status !== 0)
                throw new Error(`${scenario.name}: ${decoder.decode(stderr)}`);
            const actual = JSON.parse(decoder.decode(stdout));
            if (JSON.stringify(actual) !== JSON.stringify(scenario.expected))
                throw new Error(`${scenario.name}: expected ${scenario.expected}, got ${actual}`);
            print(`Passed: ${scenario.name}`);
        }
    } finally {
        removeTree(root);
    }
}

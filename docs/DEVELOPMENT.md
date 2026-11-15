# GNOME Extension Testing & Development Guide

## Extension ID

```text
resource-monitor@dileepa.dev
```

## 0. Installation for Development

Run this from the repository root to install the extension for development (symlink):

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/resource-monitor@dileepa.dev
```

## 1. Confirm the Extension Is Installed

List all installed extensions:

```bash
gnome-extensions list
```

Ensure your extension appears in the list.

## 2. Enable / Disable / Uninstall the Extension

Enable:

```bash
gnome-extensions enable resource-monitor@dileepa.dev
```

Disable:

```bash
gnome-extensions disable resource-monitor@dileepa.dev
```

Uninstall:

```bash
gnome-extensions uninstall resource-monitor@dileepa.dev
```

## 3. Confirm Extension State

Check detailed status:

```bash
gnome-extensions info resource-monitor@dileepa.dev
```

Expected output:

```text
State: ENABLED
```

If it says `DISABLED` or `ERROR`, check logs.

## 4. Reload GNOME Shell

### X11 (Xorg)

The easiest way to reload the shell:

1. Press `Alt` + `F2`
2. Type `r`
3. Press `Enter`

### Wayland

> ⚠️ `Alt + F2 → r` does NOT work on Wayland

#### Recommended (safe)

Log out and log back in.

#### Alternative (advanced)

```bash
Ctrl + Alt + F3
login
gnome-shell --replace
```

Return to desktop:

```bash
Ctrl + Alt + F2
```

## 5. Verify the Extension Is Running

### Top Bar

If your extension adds an indicator:

* Check the **right side of the top bar**
* Switch themes if the icon is invisible

### Looking Glass (GNOME Debugger)

Open:

```text
Alt + F2 → lg
```

Check:

* **Extensions tab** → your extension status
* **Errors tab** → runtime errors
* **Console tab** → test JavaScript

## 6. Development Logging (Most Important)

### Live GNOME Shell Logs

Run this **before enabling the extension**:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Then reload the extension:

```bash
gnome-extensions disable resource-monitor@dileepa.dev
gnome-extensions enable resource-monitor@dileepa.dev
```

## 7. Logging From Extension Code

Use logging in `extension.js`:

```js
log('Top Bar Resource Monitor loaded');
```

Logs will appear in `journalctl`.

## 8. Common Problems

### Extension immediately disables

* Check `metadata.json`:

```json
"shell-version": ["46", "50", "50.1"]
```

### No UI appears

* Ensure indicator is added to the panel:

```js
Main.panel.addToStatusArea(
  'resource-monitor',
  indicator,
  0,
  'right'
);
```

### JavaScript errors

* Check **Looking Glass → Errors**
* Check `journalctl`

## 9. Fast Development Loop

```bash
# Edit code
nano ~/.local/share/gnome-shell/extensions/resource-monitor@dileepa.dev/extension.js

# Reload extension
gnome-extensions disable resource-monitor@dileepa.dev
gnome-extensions enable resource-monitor@dileepa.dev
```

Keep `journalctl` running while developing.

## 10. Extension Location

User-installed extensions live here:

```bash
~/.local/share/gnome-shell/extensions/
```


## Automated checks for v1.1.0

From the repository root (Node.js 22+ and GJS required):

```bash
node tests/metrics.test.mjs
gjs -m tests/system.test.js
gjs -m tests/applications.test.js
git diff --check
```

The helper tests cover measurement parsing and rate/format boundaries. The GJS
integration test reads local `/proc` data and checks overlapping requests and
cancellation. App detection tests use temporary desktop entries and isolated XDG
directories to cover either app, both apps, neither app, old/new Resources IDs,
hidden entries, missing executables, and exported app locations. No real apps are
installed or launched. These tests do not replace testing inside GNOME Shell.

## v1.1.0 runtime validation still required

Track the remaining release work in [issue #3](https://github.com/dileepadev/gnome-resource-monitor/issues/3).
Keep version validation enabled. Record distribution, Shell version, session type,
and results for GNOME 51 and retained GNOME 46/50 versions before updating support claims.
Check repeated enable/disable, menu launch with Resources only, System Monitor
only, both apps, and neither app. Reopen the menu after installing/removing an app
to verify the list refreshes. Also check
lock/unlock, suspend/resume, network changes, scaling, and light/dark themes.
Measure Shell CPU, memory trend, and sampling overhead against v1.0.1 at the same
one-second interval before claiming a performance improvement.

Network rates sum all non-loopback interfaces. VPNs, bridges, and container
interfaces can therefore count the same traffic more than once. Newly observed
or reset interfaces establish a new baseline rather than contributing a spike.
An em dash means a reading is unavailable or its baseline is being established.
After gaps over five seconds, CPU and network baselines are re-established.

## Panel spacing verification (2026-11-13)

The compact layout was rendered in an isolated, headless GNOME Shell 51.0 /
Wayland session with extension version validation enabled. Eight cases covered
Yaru light and dark themes, 100% and 200% monitor scaling, and typical/high
throughput readings. The extension's own stylesheet and panel actors were used.

For identical typical readings (`2.9%`, `18.3%`, `171.7 B/s`, `318.4 B/s`), the
natural button width at 100% scaling fell from 390 to 288 logical pixels. Checks
confirmed zero theme-added icon padding/margins and no clipped labels in all
eight cases. Panel screenshots
were also inspected, including `100.0%` and `1023.9 GiB/s` / `1023.9 TiB/s`.

The spacing was later revised: the button uses 10px horizontal padding, the same
edge spacing as AppIndicator icons in Ubuntu's default compact mode, metrics are
12px apart, and each icon sits 4px from its value.

## Constant indicator width (2026-11-13)

The panel's right box is right-aligned, so a change in this indicator's width
used to shift every icon to its left. Each value now sits in a `ValueSlot` whose
minimum and natural widths are raised to the widest string the formatter can
produce (`percentSamples()` / `speedSamples()` in `metrics.js`, every digit in
every shape, so fonts without tabular digits are covered too). The widths are
measured with the label's own style on `style-changed`, so font, text scaling,
display scaling, and theme changes re-measure. Values are right-aligned and use
`font-feature-settings: "tnum"`. The slot is only a minimum and ellipsizing is
off, so an unexpected wider value grows the indicator rather than being cut.

A pure test checks that every formatter output shape appears in the sample
lists. In a headless GNOME 51 / Wayland Yaru session (100% scaling), 120 sets of
values across all formats and magnitudes kept the indicator at exactly 360 px
with no clipped or ellipsized label; reserved slots were 48 px (CPU/RAM) and
68 px (each network rate).

This verifies the panel spacing. The extension is also confirmed working in daily
use on a GNOME 51 desktop with Dash-to-Panel.

## Data usage tracking

| Module | Responsibility |
| --- | --- |
| `metrics.js` | `networkDeltas()` per-interface byte deltas (new/reset interfaces skipped), `classifyInterface()`, `formatBytes()` |
| `usage.js` | Pure model: daily records, monthly and all-time totals, week/billing-cycle/year summaries, pruning, strict deserialization, merging, cap levels |
| `usageTracker.js` | Shell side: classification from `/sys/class/net`, optional NetworkManager connection names, 5-minute encrypted saves, load/reset/teardown ordering, cap notifications |
| `cipher.js`, `sealed.js`, `storage.js` | ChaCha20 + HMAC-SHA256 sealed files with a libsecret-held key (shared design with Clipboard Manager) |
| `usageCalendar.js` | Month calendar in the menu: 42 fixed day cells updated in place, usage shading levels 1–4 relative to the month's busiest day, month navigation bounded by the first recorded day and the current month, per-day details |
| `processes.js`, `processMonitor.js` | Pure `/proc/<pid>/stat` parsing, ranking grouped by name, page-size detection; async sampling of `/proc` (only while Top Processes is open) |
| `series.js`, `historyGraphs.js` | In-memory one-hour ring buffers, downsampling, binary axis scaling; Cairo graphs in `St.DrawingArea` |
| `about.js` | Shared About preferences page (same file in all three extensions) |
| `prefs.js`, `schemas/` | Preferences window and GSettings keys (`usage-*`) |

Sampling passes `transferred` (per-interface byte deltas) and `interval` to the
tracker. Byte deltas use the previous sample even after a gap, because kernel
counters are cumulative and resets are detected; rates still re-prime after
gaps over five seconds.

Classification: names starting `tun`, `tap`, `wg`, `tailscale`, `zt`, `nordlynx`,
`proton`, `ipsec`, `vti`, `gpd`, `utun`, `mullvad`, `cscotun`, `ovpn` are VPN;
`wwan`, `ww`, `rmnet`, `usb`, `rndis`, `ppp` are mobile/tethering; interfaces
with `/sys/class/net/<name>/wireless` (or `phy80211`) are Wi-Fi; other
interfaces with a backing `device` are Ethernet; everything else (loopback,
Docker, veth, bridges, bonds, libvirt) is ignored.

Data safety rules:

- The tracker reads saved data before writing; samples recorded while loading
  are merged into the loaded model.
- A locked or unavailable keyring (`retry`) keeps counting in memory and retries
  the load on each save tick; it never writes in that state.
- An unreadable file (bad authentication, invalid data, or a missing key) puts
  the tracker in `unreadable`: nothing is written until **Reset Statistics**.
- Saves are serialized. `destroy()` is synchronous and lets the final save
  drain; the next tracker (for example after unlock) waits for it.
- Reset invalidates any in-flight load so old data cannot be merged back.
- Preferences request a reset through the `usage-reset-request` key, because
  the preferences window runs in a separate process.

The calendar uses `UsageModel.dayDetail()`, `monthOverview()`, and
`firstRecordedDay()`. While its submenu is open, `refreshUsage()` hides the
period rows and other submenus ("calendar mode") so the grid and details fit
without scrolling; it refreshes in place every second, and detail rows are
rebuilt only when their content changes. A headless GNOME 51 run with 40 days of
synthetic history rendered both months, selection, details, and accessible names
without extension errors.

Menu rows are plain reactive `St.BoxLayout`s with the `popup-menu-item` class:
St marks non-reactive widgets `:insensitive`, which themes draw dimmed.

Tests: `make check` runs the pure tests (`tests/usage.test.mjs`,
`tests/cipher.test.mjs`, `tests/metrics.test.mjs`) and the GJS tracker test
(`tests/usage-tracker.test.js`), which uses a temporary directory and an
in-memory key store, never the user's statistics or keyring.

## Per-app network rates (Top Processes)

`ProcessMonitor.sampleNetwork()` runs `ss -tinpH` asynchronously (only while Top
Processes is open) and `processes.js` parses each TCP socket's `bytes_acked`
(sent) and `bytes_received`, keyed by local/remote address and owning PID.
`rankNetwork()` reports per-app rates from the change between two samples: new
sockets only set a baseline and counters that go backwards are skipped. `ss`
only sees this user's processes and TCP (not UDP/QUIC). The binary is taken from
`/usr/bin`, `/usr/sbin`, `/bin`, or `/sbin` before falling back to `PATH`, so a
program named `ss` earlier in `PATH` is never run by the Shell.

App icons for processes: the window tracker first, then installed apps that are
shown in the app grid, matched by executable name (or `name-*`, for example
`brave` → `brave-browser-stable`) or window class. Other processes use
`emblem-system-symbolic`.

## Packaging

`make pack` writes `dist/resource-monitor@dileepa.dev.zip` with `scripts/package.py`:
every top-level module, `metadata.json`, `stylesheet.css`, `LICENSE`, the icons,
the schema source, a freshly compiled `gschemas.compiled`, and compiled
translations if present. Entries have fixed timestamps and permissions, so the
ZIP is reproducible. `scripts/check-package.py` (run by `make check`) builds it
twice, compares the bytes, follows the imports from `extension.js` and
`prefs.js` to confirm every module is packaged, and rejects development files.
Install it with `gnome-extensions install --force dist/resource-monitor@dileepa.dev.zip`.

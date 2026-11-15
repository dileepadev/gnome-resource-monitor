# Changelog

All notable changes to this project are documented in this file.

Changes are organized into the following categories:

- **Added:** New features or functionality introduced to the project.
- **Changed:** Modifications to existing functionality that do not add new features.
- **Fixed:** Bug fixes that resolve issues or correct unintended behavior.
- **Removed:** Features or components that have been removed from the project.
- **Security:** Protections and fixes for vulnerabilities or privacy.
- **Development:** Tests, tooling, documentation, and licensing.

## [Unreleased]

## [v1.1.0] - 2026-11-15

Version 1.1.0 (`version-name` in metadata; the integer `version` is managed by extensions.gnome.org). Tracked in [issue #3](https://github.com/dileepadev/gnome-resource-monitor/issues/3).

### Added

- **Data usage tracking**
  - Download and upload for today, this week, this month (or billing period from a chosen day), this year, and all time, counted from per-interface kernel byte counters.
  - Physical connections only (Wi-Fi, Ethernet, mobile broadband, USB tethering); VPN traffic shown separately; container, bridge, bond, and other virtual interfaces ignored to avoid double counting.
  - Connection-type breakdown (Wi-Fi, Ethernet, mobile), optional per-network usage by connection name (off by default; turning it off forgets recorded names), daily peak download/upload speed, and daily average/peak CPU and RAM.
  - Optional monthly data limit with a warning threshold; one notification at the threshold and one at the limit per period.
  - Data usage calendar: a month grid shaded by daily usage, month navigation, and per-day details (download/upload, VPN, connection types, networks, CPU/RAM, peak speeds).
  - Encrypted storage (see Security), saved every 5 minutes and when the extension is disabled; monthly and all-time totals are kept while daily history follows the retention setting (default 730 days).
- **Top Processes**: the five processes using the most CPU and memory, grouped by name with a count, with app names and icons; and **Network (TCP)**, live per-app download/upload rates from this user's TCP socket counters (`ss`). Sampled asynchronously only while the list is open. UDP/QUIC and other users' processes are not covered.
- **History graphs**: CPU, RAM, and network (download and upload) for the last 1 minute, 10 minutes, or 1 hour, kept in memory only.
- **Preferences window** (GTK 4/libadwaita) with a GSettings schema: tracking, per-network tracking, billing day, first day of the week, monthly limit and warning threshold, daily-history retention, and Reset Statistics.
- **About page**: version 1.1.0, description, project, issue, and license links, privacy summary, and credits.
- Detect installed Resources and GNOME System Monitor apps (current and older Resources IDs), show both when available, refresh the list when the menu opens, and show a disabled message when neither is installed.
- Focus mode: an open Top Processes, History, or Calendar submenu hides the other sections so it fits without scrolling; the menu always reopens to the overview.

### Changed

- Read system metrics asynchronously, cancel pending reads on teardown, and skip overlapping sampling cycles.
- Constant indicator width: each reading has a slot sized to its widest possible text, measured with the current font and scaling (re-measured on change), right-aligned with equal-width digits, never ellipsized, so neighbouring top-bar icons no longer shift.
- Network rates use binary units through TiB/s with at most three significant digits (`86 B/s`, `1.23 KiB/s`, `12.3 MiB/s`); panel labels update only when their text changes.
- Panel spacing matches AppIndicator icons in Ubuntu's default compact mode: 10px button edge spacing, 12px between metrics, 4px between icon and value.
- Launch monitor apps through their desktop entries, with feedback if launching fails.
- Top Processes finds the app for helper processes without windows (by program name or window class, ignoring hidden helper entries); other processes show a neutral gear icon.
- A locked keyring never triggers an unlock dialog from Resource Monitor: counting continues in memory and is saved once the keyring is unlocked.
- Translatable text is filled with a single-pass template helper, so names containing `%s` or `%d` are shown verbatim.
- Performance: the Data Usage section is not recalculated while hidden, `/proc` reads are bounded to 64 at a time, and bundled panel icons load without a filesystem check.

### Fixed

- Remove fixed-width panel labels that reserved unused space; override theme-added icon padding and margins that made the indicator look cramped or uneven.
- Exclude duplicate guest CPU counters and prime CPU/network baselines before displaying rates.
- Calculate network deltas per interface to avoid spikes when interfaces appear, disappear, or reset.
- Display unavailable readings explicitly and re-prime rates after sampling gaps longer than five seconds.
- Run the first data-limit check right after enable; within a minute of boot it was skipped (found by CI).

### Security

- Data usage statistics are encrypted with ChaCha20 and authenticated with HMAC-SHA256 (encrypt-then-MAC, fresh random nonce per save) using a random key in the login keyring; the file is private (0600) in a 0700 directory, nothing is written unencrypted, saved data is always read before it is written, and an unreadable or tampered file is never overwritten until the user resets. Reset deletes the file and the key.
- `ss` is run from its system location (not an earlier `PATH` entry such as `~/.local/bin`).
- About page rows render plain text (no Pango markup).
- GitHub Actions are pinned to commit SHAs with `persist-credentials: false`.

### Development

- Licensing: the project is MIT. The GPL-2.0-or-later scaffold header in `extension.js` is replaced, and all source, test, and script files carry `SPDX-License-Identifier: MIT`.
- Accessibility: the panel button's accessible name includes the current readings; calendar days and history graphs have screen-reader descriptions.
- Tests (`make check`, also in CI): measurement helpers and formatter shapes, usage model (calendar ranges, billing cycles, pruning, strict validation, merging, cap levels), RFC 8439 ChaCha20 vectors, process and `ss` parsing and ranking, live process sampling, and GJS tracker tests with a temporary directory and in-memory key store (load-before-write, locked-keyring retry, tampered-file protection, reset during load, final save on disable, cap notifications, forgetting network names).
- Headless GNOME 51 / Wayland checks: constant 360 px indicator width across 120 value sets; encrypted save, disable/enable, and reset with a private keyring; no unlock dialog with a locked keyring; menus, calendar, graphs, Top Processes, and preferences render without extension errors.
- Translation template support (`po/POTFILES.in`, `scripts/update-translations.sh`); `make check` fails if a file with translatable text is not listed.
- Makefile (`make schemas`, `make check`, `make pack`) and `scripts/check.sh`. `make pack` builds a deterministic extension ZIP (26 runtime files with the compiled schema and license, no development files); `make check` verifies it is reproducible and contains every imported module, and a clean install from the ZIP was verified in a private GNOME 51 profile.
- `VERSIONING.md` describes this GNOME extension: `version-name` for the release name, the extensions.gnome.org integer `version`, and the release steps (it previously referred to a nonexistent `package.json`).
- README: local symlink installation with `make schemas`, panel layout, data usage, storage and privacy, Top Processes, and new dark-mode screenshots (Dash-to-Panel top bar, synthetic data).
- Confirmed working in daily use on a GNOME 51 desktop (Wayland, Dash-to-Panel). GNOME 46 and 50 stay listed in metadata but were not separately re-tested for this release.

## [v1.0.1] - 2026-07-30

### Changed

- Updated repository references to `gnome-resource-monitor`.
- Added explicit support metadata for GNOME Shell 50.1 on Ubuntu 26.04 LTS / Wayland.

### Fixed

- Aligned extension metadata and documentation with the renamed repository and GNOME Shell 50 support requirements.
- Made the panel indicator layout more compact and stable for changing values while preserving readability.

## [v1.0.0] - 2026-01-20

### Added

- Created GitHub repository (`gnome-resource-monitor`).
- Initialized GNOME Shell extension scaffold for Resource Monitor.  
- Created extension scaffold and boilerplate.  
- Implemented basic indicator UI in the GNOME top bar.  
- Set up functionality to show dynamic CPU utilization.  
- Display real‑time RAM usage.  
- Display network download and upload speeds.  
- Tested functionality on GNOME Shell version(s) (e.g., 46).  
- Prepared for v1.0.0 tagging and metadata (name, description, UUID).

<!-- e.g., -->
<!-- Unreleased -->
<!-- v2.0.0 -->
<!-- v1.1.0 -->
<!-- v1.0.0 -->
<!-- v0.0.1 -->

[Unreleased]: https://github.com/dileepadev/gnome-resource-monitor/compare/v1.1.0...HEAD
[v1.1.0]: https://github.com/dileepadev/gnome-resource-monitor/releases/tag/v1.1.0
[v1.0.1]: https://github.com/dileepadev/gnome-resource-monitor/releases/tag/v1.0.1
[v1.0.0]: https://github.com/dileepadev/gnome-resource-monitor/releases/tag/v1.0.0

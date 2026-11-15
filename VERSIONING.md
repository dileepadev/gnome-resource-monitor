# Versioning

Resource Monitor uses `MAJOR.MINOR.PATCH` release names and Git tags such as `v1.1.0`.

- **MAJOR**: incompatible behavior, settings, or saved-statistics format changes.
- **MINOR**: backward-compatible features.
- **PATCH**: fixes and small improvements.

The latest published release is **v1.0.1**. The next release, **v1.1.0**, is in development and tracked in [issue #3](https://github.com/dileepadev/gnome-resource-monitor/issues/3).

## GNOME extension metadata

Git release tags and GNOME submission versions serve different purposes. Follow the [GNOME metadata guidance](https://gjs.guide/extensions/overview/anatomy.html#metadata-json-required):

- `version-name` is the user-visible release (for example `1.1.0`), shown on the About page.
- `version` is the integer that extensions.gnome.org manages for submissions. Never put a semantic-version string in it, and check the last published integer before a release.

Use major Shell version strings such as `"51"` in `shell-version`; record tested point releases such as 50.1 in the compatibility matrix. Metadata enables validation, while live session results establish the support claim.

This project is a GJS extension. There is no `package.json` release version to update.

## Release process

1. Complete the tracking issue's implementation and acceptance criteria.
2. Run `make check` and the documented live GNOME compatibility matrix, including GNOME 51 / Wayland with normal version validation enabled.
3. Update `metadata.json` (`version-name`), README, development documentation, and the changelog with the final behavior, tested environments, and known limitations.
4. Build the extension ZIP with `make pack` (runtime files, compiled schema, translations if present, and the license; development files are excluded) and verify installation from it in a clean test profile.
5. After review, commit the release changes, tag `v1.1.0`, and publish GitHub release notes with the verified ZIP. Submit to extensions.gnome.org if distribution there is planned.
6. Start a new `Unreleased` changelog section and update the release issue with results.

Pre-release Git tags may use names such as `v1.1.0-beta.1`; metadata `version-name` must follow GNOME's allowed format. See the [GitHub issues](https://github.com/dileepadev/gnome-resource-monitor/issues) for release planning.

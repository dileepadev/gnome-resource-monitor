#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Build a deterministic extension ZIP from the runtime files only."""

from pathlib import Path
import argparse
import json
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def runtime_files():
    """Every module the extension and preferences load, plus metadata, style, icons, and notices."""
    names = sorted(path.name for path in ROOT.glob("*.js"))
    names += ["metadata.json", "stylesheet.css", "LICENSE",
              "schemas/org.gnome.shell.extensions.resource-monitor.gschema.xml"]
    names += sorted(f"icons/{path.name}" for path in (ROOT / "icons").glob("*.svg"))
    return names


def build(destination):
    metadata = json.loads((ROOT / "metadata.json").read_text())
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / f'{metadata["uuid"]}.zip'
    with tempfile.TemporaryDirectory(prefix="resource-monitor-package-") as temporary:
        subprocess.run(["glib-compile-schemas", "--strict", f"--targetdir={temporary}", str(ROOT / "schemas")], check=True)
        files = {name: (ROOT / name).read_bytes() for name in runtime_files()}
        files["schemas/gschemas.compiled"] = (Path(temporary) / "gschemas.compiled").read_bytes()
        for translation in (ROOT / "locale").glob("*/LC_MESSAGES/*.mo"):
            files[translation.relative_to(ROOT).as_posix()] = translation.read_bytes()
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
            for name, contents in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                output.writestr(info, contents, compresslevel=9)
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    print(build(parser.parse_args().output))

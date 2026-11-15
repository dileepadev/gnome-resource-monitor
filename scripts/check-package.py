#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Check that the ZIP is reproducible and contains every imported module."""

from pathlib import Path
import re
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from package import ROOT, build  # noqa: E402

with tempfile.TemporaryDirectory() as temporary:
    first = build(Path(temporary) / "a")
    second = build(Path(temporary) / "b")
    assert first.read_bytes() == second.read_bytes(), "Package is not reproducible"
    names = set(zipfile.ZipFile(first).namelist())
for module in ["extension.js", "prefs.js"]:
    pending, seen = [module], set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        assert name in names, f"{name} is imported but not packaged"
        pending += re.findall(r"from '\./([\w.-]+\.js)'", (ROOT / name).read_text())
assert not any(name.startswith(("tests/", "scripts/", "docs/", "assets/")) for name in names), "Development files packaged"
assert "schemas/gschemas.compiled" in names and "LICENSE" in names
print(f"PASS: reproducible ZIP with {len(names)} runtime files, including every imported module")

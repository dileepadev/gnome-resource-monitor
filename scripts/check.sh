#!/bin/sh
# Run all local checks. Uses only temporary files and in-memory key stores.
set -eu
cd "$(dirname "$0")/.."
for file in *.js tests/*.js; do
    node --input-type=module --check < "$file"
done
echo "PASS: JavaScript syntax"
for test in tests/*.test.mjs; do
    node "$test" > /dev/null
    echo "PASS: $test"
done
for test in tests/system.test.js tests/applications.test.js tests/processes.test.js tests/usage-tracker.test.js; do
    gjs -m "$test"
done
python3 -m json.tool metadata.json > /dev/null
glib-compile-schemas --strict --dry-run schemas
echo "PASS: metadata and strict schema compilation"
# Every file with translatable text must be listed for the translation template.
for file in *.js; do
    if grep -q "_('" "$file" && ! grep -qx "$file" po/POTFILES.in; then
        echo "FAIL: $file has translatable text but is not in po/POTFILES.in" >&2
        exit 1
    fi
done
echo "PASS: translation file list covers every file with translatable text"
python3 scripts/check-package.py

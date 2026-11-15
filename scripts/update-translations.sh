#!/bin/sh
# SPDX-License-Identifier: MIT
# Regenerate po/resource-monitor.pot from po/POTFILES.in (requires GNU gettext).
# Translations use the extension UUID as their gettext domain: compile a
# language's catalog to locale/<lang>/LC_MESSAGES/resource-monitor@dileepa.dev.mo.
set -eu
cd "$(dirname "$0")/.."
xgettext --from-code=UTF-8 --add-comments=Translators --keyword=_ \
    --copyright-holder='Dileepa Bandara' --package-name=resource-monitor \
    --files-from=po/POTFILES.in --output=po/resource-monitor.pot

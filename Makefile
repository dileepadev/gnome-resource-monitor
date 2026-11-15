.PHONY: check pack schemas

schemas:
	glib-compile-schemas --strict schemas

check: schemas
	sh scripts/check.sh

pack: schemas
	python3 scripts/package.py

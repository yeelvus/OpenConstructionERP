#!/usr/bin/env python3
"""Module-name guard: every module name a user reads must be reachable by a translator.

`ModuleManifest` carries `display_name` and an optional `display_name_i18n`
dict. The module registry page used to render `display_name` straight, so all
185 module names showed in English in every one of the 40 languages, and had
since the page was written.

What made it survive is worth stating, because it decides what this guard has
to check. The field existed in the model and the type declared it on the page,
so from either end it looked implemented. No existing gate could see it:

  * the orphan guard asks whether a `t()` key has a locale file behind it, and
    there was no `t()` call to find
  * the leak and mixed-script guards ask about the value of a key that exists,
    and no key existed
  * `tsc` and the build are satisfied by a string rendered as a string

There is no missing key to detect when nobody ever asked for one. So this guard
does not look for a gap in the locale files. It starts from the modules, which
are the thing that actually exists, and asks of each one whether the name it
shows can be translated at all.

Three ways that fails, all blocking:

  1. A module whose name has no `modules.catalog.<name>` key. Nothing can
     translate it, and it will render English forever without any gate
     noticing. This is the original defect.
  2. A `modules.catalog.*` key with no module behind it. Left alone these
     accumulate as work for 39 translators on names nobody will ever see.
  3. A key whose English value disagrees with the manifest `display_name`.
     Two spellings of one module's name is what #134 found: a module the app
     calls Project Files whose manifest said Document Management. Translators
     work from the locale value and backend logs print the manifest one, so a
     drift here means the product is quietly using two names for one thing.

Run from the repo root:

    python scripts/check_module_display_names.py
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODULES = ROOT / "backend" / "app" / "modules"
EN_LOCALE = ROOT / "frontend" / "src" / "app" / "locales" / "en.ts"

KEY_PREFIX = "modules.catalog."

DISPLAY_RE = re.compile(r'^\s*display_name\s*=\s*"([^"]*)"', re.M)
NAME_RE = re.compile(r'^\s*name\s*=\s*"([^"]*)"', re.M)
# "key": "value", where either may contain escaped quotes
PAIR_RE = re.compile(r'"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"')


def locale_key(module_name: str) -> str:
    """Mirror of `moduleDisplayNameKey` in frontend/src/features/modules/moduleDisplayName.ts.

    Kept deliberately trivial and duplicated rather than generated, because the
    two sides must agree and a one-line rule is easier to check by eye than a
    build step. If you change one, change the other and its test.
    """
    return KEY_PREFIX + module_name.removeprefix("oe_")


def read_manifests() -> list[tuple[str, str, pathlib.Path]]:
    out: list[tuple[str, str, pathlib.Path]] = []
    for manifest in sorted(MODULES.glob("*/manifest.py")):
        text = manifest.read_text(encoding="utf-8")
        name = NAME_RE.search(text)
        display = DISPLAY_RE.search(text)
        if not name or not display:
            # A manifest without either is a different problem and the loader
            # will refuse it; not this guard's business to duplicate that.
            continue
        out.append((name.group(1), display.group(1), manifest))
    return out


def read_english() -> dict[str, str]:
    text = EN_LOCALE.read_text(encoding="utf-8")
    return {k: v for k, v in PAIR_RE.findall(text)}


def main() -> int:
    modules = read_manifests()
    if not modules:
        print(f"no manifests found under {MODULES}", file=sys.stderr)
        return 1

    english = read_english()
    catalog = {k: v for k, v in english.items() if k.startswith(KEY_PREFIX)}

    unreachable: list[tuple[str, str]] = []
    drifted: list[tuple[str, str, str]] = []
    expected: set[str] = set()

    for name, display, _path in modules:
        key = locale_key(name)
        expected.add(key)
        if key not in catalog:
            unreachable.append((name, display))
        elif catalog[key] != display:
            drifted.append((key, display, catalog[key]))

    orphans = sorted(set(catalog) - expected)

    failed = False

    if unreachable:
        failed = True
        print(
            f"\n{len(unreachable)} module names no translator can reach:",
            file=sys.stderr,
        )
        for name, display in unreachable[:20]:
            print(f'  {name:<28} "{display}"  needs {locale_key(name)}', file=sys.stderr)
        if len(unreachable) > 20:
            print(f"  and {len(unreachable) - 20} more", file=sys.stderr)
        print(
            "\nAdd the key to frontend/src/app/locales/en.ts with the manifest wording as its\n"
            "English value. Until then this module renders English in all 40 languages and\n"
            "no other i18n gate can see it, because there is no key for them to miss.",
            file=sys.stderr,
        )

    if drifted:
        failed = True
        print(
            f"\n{len(drifted)} module names are spelled two different ways:",
            file=sys.stderr,
        )
        for key, manifest_value, locale_value in drifted:
            print(f"  {key}", file=sys.stderr)
            print(f'    manifest: "{manifest_value}"', file=sys.stderr)
            print(f'    en.ts:    "{locale_value}"', file=sys.stderr)
        print(
            "\nTranslators work from the locale value and backend logs print the manifest one,\n"
            "so a disagreement here ships the module under two names. Pick one and set both.",
            file=sys.stderr,
        )

    if orphans:
        failed = True
        print(f"\n{len(orphans)} catalog keys have no module behind them:", file=sys.stderr)
        for key in orphans[:20]:
            print(f'  {key}  = "{catalog[key]}"', file=sys.stderr)
        if len(orphans) > 20:
            print(f"  and {len(orphans) - 20} more", file=sys.stderr)
        print(
            "\nA module was renamed or removed and its name key stayed. Delete the key from\n"
            "every locale file, or these become translation work on a name nobody can see.",
            file=sys.stderr,
        )

    if failed:
        return 1

    print(
        f"module display names: {len(modules)} modules, every name reachable as "
        f"{KEY_PREFIX}<name>, no drift, no orphans"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

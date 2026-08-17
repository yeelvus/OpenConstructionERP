#!/usr/bin/env python3
"""Case honeycomb guard: every hex title must have a step chip behind it.

A case detail page carries two lists of the same modules. The honeycomb hexes
come from marketing-site/scripts/case-modules.json, which holds free-text
display names. The step chips come from the playbook, which holds a label and
an i18n key. Only the chip is translated, so the honeycomb is localised by
copying: add_case_rail.py maps a hex to a chip by comparing the hex title to
the chip label with `title in names`, an EXACT match, and paints the chip's
translated text into the hex.

A hex whose title matches no chip on its page therefore has nothing to copy
from, and renders in English in all 28 trees forever. Nothing reported this.
It is invisible to every locale gate we own, because nothing is untranslated:
the string is English on purpose in the catalogue, and the catalogue is not a
locale file. It is invisible to a build, because both files are individually
valid. It only shows up by reading a page in a language you do not speak.

The failure is also silent in the other direction, which is what makes a guard
worth having rather than a one-off cleanup. The match being exact and
case-sensitive means renaming either side alone breaks the pair. "Project
files" and "Project Files" are two different strings here. So is the obvious
improvement of giving a hex the product's real name while the chip keeps the
old one: that reads as a fix, ships as a regression, and no test sees it.

Baseline, not allowlist. Known-uncovered pairs live in
case_module_chip_baseline.json as a map of case slug to the titles that have
no chip on that page. The direction matters and is deliberate: this guard
fails on any uncovered pair NOT in the baseline, so emptying the baseline
makes it maximally strict rather than blind. A baseline that has gone stale in
the safe direction (a pair recorded that is now covered) is reported so it can
be dropped, but does not fail.

The count is printed on every run, pass or fail. The recorded pairs are real
cells reading English in 27 languages, and a guard that prints only "OK" would
turn them back into silence, which is the condition this was written to end.

Parser desync is a failure, not a pass. If the catalogue yields no cases, the
data directory yields no playbooks, or the playbooks yield no chip labels at
all, that is reported as an error rather than as full coverage of nothing.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

CATALOGUE_PATH = "marketing-site/scripts/case-modules.json"
PLAYBOOK_GLOB = "frontend/src/features/cases/data/*.playbook.ts"
BASELINE_PATH = "scripts/case_module_chip_baseline.json"

# `moduleLabel: "..."` as the playbooks are written. Double-quote only, the
# shape every playbook uses; desync is caught by the zero-label check below
# rather than tolerated, because a regex that silently stops matching would
# report every hex as uncovered and every uncovered hex as fine, depending on
# which side went quiet.
_LABEL = re.compile(r'moduleLabel:\s*"([^"]*)"')


def load_catalogue() -> dict[str, list[str]]:
    with open(CATALOGUE_PATH, encoding="utf-8") as fh:
        raw = json.load(fh)
    out: dict[str, list[str]] = {}
    for case, mods in raw.items():
        if isinstance(mods, list):
            out[case] = [str(m).strip() for m in mods if str(m).strip()]
    return out


def load_chip_labels() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for path in sorted(glob.glob(PLAYBOOK_GLOB)):
        case = os.path.basename(path)[: -len(".playbook.ts")]
        with open(path, encoding="utf-8") as fh:
            out[case] = [m.strip() for m in _LABEL.findall(fh.read())]
    return out


def load_baseline() -> dict[str, set[str]]:
    if not os.path.exists(BASELINE_PATH):
        return {}
    with open(BASELINE_PATH, encoding="utf-8") as fh:
        raw = json.load(fh)
    return {case: set(titles) for case, titles in raw.items()}


def main() -> int:
    catalogue = load_catalogue()
    labels = load_chip_labels()
    baseline = load_baseline()

    if not catalogue:
        print(f"ERROR: {CATALOGUE_PATH} yielded no cases", file=sys.stderr)
        return 1
    if not labels:
        print(f"ERROR: {PLAYBOOK_GLOB} yielded no playbooks", file=sys.stderr)
        return 1
    if not any(labels.values()):
        print("ERROR: no moduleLabel found in any playbook, the parser is desynced", file=sys.stderr)
        return 1

    pairs = 0
    uncovered: list[tuple[str, str]] = []
    no_playbook: list[str] = []
    for case, mods in sorted(catalogue.items()):
        if case not in labels:
            no_playbook.append(case)
            continue
        have = labels[case]
        for title in mods:
            pairs += 1
            if title not in have:
                uncovered.append((case, title))

    new = [(c, t) for c, t in uncovered if t not in baseline.get(c, set())]
    seen = {(c, t) for c, t in uncovered}
    healed = [(c, t) for c, titles in sorted(baseline.items()) for t in sorted(titles) if (c, t) not in seen]

    print(
        f"case module chips: {pairs} hex/chip pairs across {len(catalogue)} cases, "
        f"{len(uncovered)} uncovered, {sum(len(v) for v in baseline.values())} in the baseline"
    )

    if no_playbook:
        print(f"ERROR: {len(no_playbook)} case(s) in the catalogue have no playbook: {', '.join(no_playbook)}", file=sys.stderr)
        return 1

    if healed:
        print(f"  {len(healed)} baseline pair(s) now covered, drop them: " + ", ".join(f"{c} -> {t!r}" for c, t in healed))

    if new:
        print(file=sys.stderr)
        for case, title in new:
            print(f"ERROR: {case} lists module {title!r} but no step chip on that page carries that label", file=sys.stderr)
        print(file=sys.stderr)
        print(
            "A hex with no chip behind it renders in English in every language, because the\n"
            "honeycomb is localised by copying the chip. Either give the step chip that exact\n"
            "label, or record the pair in " + BASELINE_PATH + " if the case genuinely has no\n"
            "step for that module. The match is exact and case-sensitive.",
            file=sys.stderr,
        )
        return 1

    print("case module chips OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

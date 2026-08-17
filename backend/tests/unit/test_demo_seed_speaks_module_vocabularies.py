# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""No seeded record may hold a value its own module would refuse.

Four modules have now been caught doing exactly that: contacts on
``contact_type``, variations on its status vocabulary, safety on four fields at
once, and contracts on ``counterparty_type``, where the seed wrote "contractor"
against a module that offers client and subcontractor and a picker that offers
the same two. Four instances is a class, so this checks every module rather than
waiting for the fifth to be reported.

The mechanism behind the class is that the seeder builds ORM rows directly. It
never passes the Pydantic layer that owns the vocabulary, and the columns behind
these fields are plain ``String`` with no enum, so the database accepts anything.
What reaches the screen is then a value the create endpoint would 422, the edit
form cannot re-select, and any filter built from the real vocabulary cannot find.

Three notes on the method, each of which cost a wrong answer to learn.

A regex over the seed source does not work. Auditing safety that way reported
"workmanship" and "supervision" as severities; both are NCR fields sitting a few
lines from the incident block. Values are read out of ``ast`` dict literals here,
never out of raw text.

A field name is not enough to identify a vocabulary. ``priority`` is a task field
and a punchlist field with different scales, and "critical" is legal in the
second and refused by the first; ``status`` belongs to nearly every module. Each
literal is therefore attributed to a schema by how much of its key set that
schema covers, and judged only against the vocabulary of the module it was
attributed to.

Constraints are read from ``model_fields`` rather than parsed from source,
because several are built from a module-level constant - contracts writes
``rf"^({COUNTERPARTY_TYPES})$"`` - and only the resolved pattern states the
actual vocabulary.

What this cannot see, measured rather than assumed. Reintroducing all four of the
defects above, it catches the contracts and tasks ones and misses the safety one,
because the safety values live in a tuple pool that a generator reads rather than
in a dict literal. That is the division of labour with
``test_demo_safety_vocabulary.py``, which calls the generator and validates real
schema objects: this file is wide and shallow across every module, that one is
narrow and deep on the module where it mattered. A module whose seed is generated
rather than written needs the second kind.

The floors below exist so that a change which quietly drops the attribution rate
to zero fails instead of passing, because a comparison over nothing passes. Of
615 dict literals in the seed sources, 143 attribute to a schema; the rest are
configuration and nested fragments that are not records at all.
"""

from __future__ import annotations

import ast
import importlib
import pkgutil
import re
from pathlib import Path
from typing import Any

import app.modules as modules_pkg
from app.core import demo_projects

# A pattern states a vocabulary only when it is a plain alternation of literals.
# Anything else - a date shape, a length rule - says nothing about which words
# are allowed and is skipped rather than guessed at.
_VOCABULARY = re.compile(r"\^\(([a-z0-9_|\-]+)\)\$")

# Minimum keys a literal must share with a schema before it is attributed at
# all, and the share of its keys that must land. Below either, the match is a
# coincidence: three-key config dicts overlap almost everything.
_MIN_SHARED_KEYS = 3
_MIN_COVERAGE = 0.5

# Floors, so that a scan which stops finding anything fails rather than passes.
# Measured 07.08: 418 schemas carry a vocabulary, 631 fields across them, and
# 143 seeded records attribute. Set well under those so ordinary drift does not
# trip them, but far enough above zero that a broken scan cannot look clean.
_MIN_SCHEMAS_WITH_VOCABULARY = 250
_MIN_ATTRIBUTED_RECORDS = 90


def _module_schemas() -> tuple[dict[str, set[str]], dict[str, dict[str, tuple[str, set[str]]]], dict[str, set[str]]]:
    """Every schema's field names, the ones that state a vocabulary, and their modules.

    Returns ``({SchemaName: field names}, {SchemaName: {field: (module, allowed)}},
    {SchemaName: modules that define it})``. A module whose schemas do not import
    is skipped rather than failing the run: this test is about the seed, and an
    import break has its own tests.
    """
    fields: dict[str, set[str]] = {}
    constrained: dict[str, dict[str, tuple[str, set[str]]]] = {}
    owners: dict[str, set[str]] = {}
    for info in pkgutil.iter_modules(modules_pkg.__path__):
        try:
            schemas = importlib.import_module(f"app.modules.{info.name}.schemas")
        except Exception:  # noqa: BLE001 - see docstring
            continue
        for attr in dir(schemas):
            model_fields = getattr(getattr(schemas, attr), "model_fields", None)
            if not isinstance(model_fields, dict) or not model_fields:
                continue
            fields[attr] = set(model_fields)
            owners.setdefault(attr, set()).add(info.name)
            for name, field in model_fields.items():
                for meta in getattr(field, "metadata", []) or []:
                    pattern = getattr(meta, "pattern", None)
                    if not isinstance(pattern, str):
                        continue
                    match = _VOCABULARY.fullmatch(pattern)
                    if match:
                        constrained.setdefault(attr, {})[name] = (info.name, set(match.group(1).split("|")))
    return fields, constrained, owners


def _seed_sources() -> list[Path]:
    core = Path(demo_projects.__file__).parent
    backend_app = core.parent
    return sorted(core.glob("demo_*.py")) + sorted(backend_app.glob("modules/*/seed.py"))


def _where(path: Path) -> str:
    """A path a reader can act on. Several seed files share the basename seed.py."""
    parts = path.parts
    return "/".join(parts[parts.index("app") :]) if "app" in parts else path.name


def _record_literals(path: Path) -> list[tuple[int, dict[str, Any]]]:
    """Every dict literal in the file, as ``(line, constant keys and values)``."""
    out: list[tuple[int, dict[str, Any]]] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if not isinstance(node, ast.Dict):
            continue
        record = {
            key.value: value.value
            for key, value in zip(node.keys, node.values, strict=False)
            if isinstance(key, ast.Constant) and isinstance(value, ast.Constant)
        }
        if len(record) >= _MIN_SHARED_KEYS:
            out.append((node.lineno, record))
    return out


def _attribute(record: dict[str, Any], fields: dict[str, set[str]]) -> list[str]:
    """Every schema that covers this record's keys best, or an empty list.

    All of the tied schemas are returned rather than one of them. Ties are the
    normal case, not the exception: a module's Create, Update and Out schemas
    describe the same record and cover it equally well, and picking whichever
    sorted first would judge the record against a vocabulary chosen by
    alphabet. The caller only reports a value that every tied candidate
    refuses, which is an answer that does not depend on the tie being broken.
    """
    keys = set(record)
    scored: list[tuple[float, str]] = []
    for name, schema_fields in fields.items():
        shared = len(keys & schema_fields)
        if shared < _MIN_SHARED_KEYS:
            continue
        scored.append((shared / len(keys), name))
    if not scored:
        return []
    best_score = max(score for score, _ in scored)
    if best_score < _MIN_COVERAGE:
        return []
    return [name for score, name in scored if score == best_score]


def _scan() -> tuple[int, list[str]]:
    fields, constrained, owners = _module_schemas()
    assert len(constrained) >= _MIN_SCHEMAS_WITH_VOCABULARY, (
        f"only {len(constrained)} schemas were found to state a vocabulary, "
        f"expected at least {_MIN_SCHEMAS_WITH_VOCABULARY}; the discovery has broken "
        f"and this check would pass without reading anything"
    )

    attributed = 0
    problems: list[str] = []
    for source in _seed_sources():
        # A module's own seed.py seeds that module's records, so its schemas are
        # the only candidates. Without this, the forms starter templates matched
        # SkillCreate on name / category / description and were judged against a
        # document vocabulary they have nothing to do with. The core seeder is
        # not scoped, because it writes for every module at once.
        home = source.parent.name if source.name == "seed.py" else None
        visible = {n: f for n, f in fields.items() if home is None or home in owners.get(n, set())}
        for line, record in _record_literals(source):
            candidates = [name for name in _attribute(record, visible) if name in constrained]
            if not candidates:
                continue
            attributed += 1
            # Which fields any candidate constrains, and what each of them would
            # accept. A value is only reported when no candidate accepts it.
            vocabularies: dict[str, list[tuple[str, str, set[str]]]] = {}
            for name in candidates:
                for field, (module_name, allowed) in constrained[name].items():
                    vocabularies.setdefault(field, []).append((name, module_name, allowed))
            for field, claimants in vocabularies.items():
                value = record.get(field)
                if not isinstance(value, str) or any(value in allowed for _, _, allowed in claimants):
                    continue
                accepted = sorted({word for _, _, allowed in claimants for word in allowed})
                named = sorted({module_name for _, module_name, _ in claimants})
                problems.append(
                    f"{_where(source)}:{line} seeds {field}={value!r}, but {'/'.join(named)} "
                    f"accepts only {'|'.join(accepted)} (matched {', '.join(sorted(candidates))})"
                )
    return attributed, problems


def test_no_seeded_record_holds_a_value_its_module_refuses() -> None:
    attributed, problems = _scan()
    assert attributed >= _MIN_ATTRIBUTED_RECORDS, (
        f"only {attributed} seeded records could be attributed to a schema, expected at "
        f"least {_MIN_ATTRIBUTED_RECORDS}; a scan that compares nothing reports clean"
    )
    assert not problems, "seeded values the owning module would refuse:\n  " + "\n  ".join(problems)


def test_the_scan_would_notice_a_refused_value() -> None:
    """The green run above has to mean the seed is right, not that nothing is read.

    A synthetic record is pushed through the same attribution and comparison the
    scan uses. If this stops failing, the check above has stopped checking.
    """
    fields, constrained, _owners = _module_schemas()
    record = {
        "code": "X",
        "title": "X",
        "contract_type": "lump_sum",
        "counterparty_type": "contractor",
        "project_id": "X",
    }
    candidates = [name for name in _attribute(record, fields) if "counterparty_type" in constrained.get(name, {})]
    assert candidates, "the sample record no longer attributes to any schema that owns counterparty_type"
    for name in candidates:
        allowed = constrained[name]["counterparty_type"][1]
        assert "contractor" not in allowed, (
            f"{name} now accepts 'contractor', so this sample no longer demonstrates a refusal"
        )

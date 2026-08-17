#!/usr/bin/env python3
"""Refuse a half-migrated collection endpoint.

An endpoint that returns ``{items, total, offset, limit}`` breaks every caller
still expecting a bare array. TypeScript catches most of that, but NOT the
case this guard exists for: React Query caches by key, and the key is a
string. If two files share ``queryKey: ['schedules']`` and only one is
migrated, the cache hands the wrong shape to the other at RUNTIME. ``npm run
build`` is green and the screen is broken.

So the unit of migration is one endpoint plus every consumer of it, in one
commit. This script counts both sides and fails when they disagree.

Usage:
    python scripts/check_page_envelope_consumers.py
    python scripts/check_page_envelope_consumers.py --self-test

Exit codes:
    0  every migrated endpoint has every consumer migrated
    1  at least one endpoint is half migrated
    2  the scan found no consumers at all (broken instrument, not a pass)
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FRONTEND = REPO / "frontend" / "src"

# Endpoints already migrated to the envelope. Add a line here in the same
# commit that migrates the endpoint, never later.
MIGRATED_ENDPOINTS: dict[str, str] = {
    "/v1/schedule/schedules/": "schedule list",
    "/v1/schedule/schedules/{}/activities/": "schedule activities",
    "/v1/finance/": "finance invoices",
    "/v1/finance/budgets/": "finance budgets",
    "/v1/finance/payments/": "finance payments",
    "/v1/transmittals/": "transmittals list",
    # Wave 2. No trailing slash on purpose: both callers write
    # `/v1/notifications?...`, and `url_shape` cuts at the `?`, so the route
    # this scan sees is the bare path.
    "/v1/notifications": "notifications list",
}

# Wave 2 measured five more enveloped endpoints - file_comments,
# file_distribution, file_references, file_saved_views, file_trash - and
# deliberately lists none of them, because an entry for any of them would
# report "0 call sites, 0 migrated" and pass without reading a thing. Their
# api layers build every URL from a module-level `const BASE = '/v1/file-x'`,
# so the only `/v1/` literal in the file sits on the BASE line, where the
# nearest preceding verb is whatever `api*` the import statement named. The
# same idiom hides their cache keys from the query-key scan below: those are
# written `queryKey: [fileTrashKeys.list, ...]`, a const reference, and
# QUERY_KEY_RE needs a quoted literal. A decorative entry is worse than no
# entry - it reads as coverage.

# React Query cache keys that must move in one commit with the endpoint they
# read. This is a SECOND constraint, not a restatement of the one above.
#
#   * the endpoint's response type binds every caller of the endpoint, and
#     TypeScript enforces that for us,
#   * a shared cache key binds every caller holding that key, and NOTHING
#     enforces that. The key is a string. React Query will hand a value
#     cached by a migrated file straight to an unmigrated one, at runtime,
#     with tsc and the build both green.
#
# So a key listed here is asserted to be wholly migrated the moment its
# endpoint appears in MIGRATED_ENDPOINTS. Keys that merely look related do
# NOT belong here: ['projects-switcher'] and ['projects'] are different
# cache entries and share nothing.
SHARED_QUERY_KEYS: dict[str, str] = {
    # "projects": "/v1/projects/",   # W1, 107 call sites across 81 files
    # Two readers (SchedulePage, ProjectDetailPage) cache Schedule rows under
    # this key. tsc caught SchedulePage consuming the raw Page envelope only
    # because the wrapper's return type happened to flow through; the URL
    # scan above never sees wrapper callers at all.
    "schedules": "/v1/schedule/schedules/",
    # Finance reads the invoice register twice under one prefix: the Insights
    # panel at page level with no direction filter, and the Invoices tab per
    # sub-tab. Different third elements, so different cache entries, but one
    # endpoint and one shape - migrating either alone leaves the other reading
    # an envelope as an array.
    "finance-invoices": "/v1/finance/",
    "finance-budgets": "/v1/finance/budgets/",
    "finance-payments": "/v1/finance/payments/",
    "transmittals": "/v1/transmittals/",
    # Notifications has two readers of one endpoint and no key to list: the
    # bell caches under ['notifications-list'], the inbox page under
    # ['notifications-page', filter, page]. Different first elements, so
    # different cache entries that cannot hand each other a value - the
    # ['projects-switcher'] vs ['projects'] case named above. Listing either
    # would assert a sharing that does not exist.
}

QUERY_KEY_RE = r"queryKey:\s*\[\s*['\"`]{key}['\"`]"

# A call is migrated when it names the envelope type. A call that still
# names a bare array of the row type is not, and neither is one hedging
# between the two: `apiGet<Row[] | {items: Row[]}>` unwraps whichever shape
# turns up and throws `total` away, which is the state this whole programme
# exists to leave behind. So the bare hint reads the type argument up to its
# first `>` and asks whether an array is in there at all - `Page<Row>` and
# `Pick<Page<Row>, 'items' | 'total'>` carry none, the union carries two.
ENVELOPE_HINT = re.compile(r"Page<|\.items\b|items:\s")
BARE_ARRAY_HINT = re.compile(r"apiGet<[^>]*\[\]")


def url_shape(url: str) -> str:
    """Reduce a URL to its route, with every interpolation collapsed."""
    url = url.split("?")[0]
    url = re.sub(r"\$\{[^}]*\}", "{}", url)
    return re.sub(r"/+", "/", url)


def scan(root: Path) -> tuple[dict[str, list[Path]], dict[str, list[Path]]]:
    """Return (consumers, unmigrated) keyed by migrated endpoint route."""
    consumers: dict[str, list[Path]] = {k: [] for k in MIGRATED_ENDPOINTS}
    unmigrated: dict[str, list[Path]] = {k: [] for k in MIGRATED_ENDPOINTS}

    for path in root.rglob("*.ts*"):
        if "node_modules" in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for m in re.finditer(r"[`'\"]((?:/api)?/v1/[^`'\"\s]*)[`'\"]", text):
            raw = m.group(1)
            shape = url_shape(raw).removeprefix("/api")
            if shape not in MIGRATED_ENDPOINTS:
                continue
            # Doc comments quote these routes constantly. A comment is not a
            # consumer, and counting one produces a failure nobody can fix.
            line_start = text.rfind("\n", 0, m.start()) + 1
            if text[line_start : m.start()].lstrip().startswith(("*", "//", "/*")):
                continue
            # Only a GET reads the collection. The same route is also a POST
            # target (create) and a DELETE target (clear); neither returns a
            # page, so neither can be half migrated.
            #
            # Bind to the NEAREST preceding call, not to any call in a window:
            # these api objects list one route per line, so a window wide
            # enough to hold the call is wide enough to hold its neighbour's.
            before = text[max(0, m.start() - 400) : m.start()]
            verbs = re.findall(r"api(Get|Post|Patch|Put|Delete)", before)
            if not verbs or verbs[-1] != "Get":
                continue
            consumers[shape].append(path)
            # Judge the call this URL belongs to, not the neighbourhood it
            # sits in. A window wide enough to hold the call is wide enough
            # to hold the previous one's type argument, and link pickers come
            # in runs: documents, transmittals, RFIs, one useQuery after
            # another. The documents route is bare and the transmittals route
            # is not, so a windowed read convicts the migrated call of its
            # neighbour's shape and no edit to the file can clear it.
            call = before[before.rfind("apiGet") :] + text[m.start() : m.start() + 200]
            if BARE_ARRAY_HINT.search(call) or not ENVELOPE_HINT.search(call):
                unmigrated[shape].append(path)
    return consumers, unmigrated


def scan_query_keys(root: Path) -> dict[str, tuple[list[Path], list[Path]]]:
    """Return {key: (reading call sites, unmigrated call sites)}.

    Only reads count. ``invalidateQueries({queryKey: ['projects']})`` names
    the key without consuming the value, so it cannot be handed the wrong
    shape and must not be counted; a ``queryFn`` in the window is what
    separates the two. Requiring ``apiGet`` instead would miss readers that
    fetch through an api wrapper (``scheduleApi.listSchedules(...)``), and a
    wrapper caller was exactly the consumer tsc caught unmigrated while this
    scan reported the key clean.
    """
    out: dict[str, tuple[list[Path], list[Path]]] = {
        k: ([], []) for k in SHARED_QUERY_KEYS
    }
    if not SHARED_QUERY_KEYS:
        return out
    patterns = {
        k: re.compile(QUERY_KEY_RE.format(key=re.escape(k))) for k in SHARED_QUERY_KEYS
    }

    for path in root.rglob("*.ts*"):
        if "node_modules" in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for key, pat in patterns.items():
            for m in pat.finditer(text):
                # The queryFn follows the key, so look forward from it.
                window = text[m.start() : m.start() + 600]
                if "queryFn" not in window:
                    continue
                reads, bad = out[key]
                reads.append(path)
                if BARE_ARRAY_HINT.search(window) or not ENVELOPE_HINT.search(window):
                    bad.append(path)
    return out


def report(root: Path) -> int:
    consumers, unmigrated = scan(root)
    total_consumers = sum(len(v) for v in consumers.values())
    if total_consumers == 0:
        print("FAIL: found no consumers of any migrated endpoint.")
        print("      A zero here means the scan is broken, not that the tree is clean.")
        return 2

    failed = False
    for route, label in MIGRATED_ENDPOINTS.items():
        seen = consumers[route]
        bad = unmigrated[route]
        print(f"{label}: {len(seen)} call sites, {len(seen) - len(bad)} migrated")
        for p in sorted(set(bad)):
            print(f"  UNMIGRATED  {p.relative_to(REPO)}")
            failed = True
    for key, endpoint in SHARED_QUERY_KEYS.items():
        if endpoint not in MIGRATED_ENDPOINTS:
            continue
        reads, bad = scan_query_keys(root)[key]
        print(
            f"queryKey ['{key}']: {len(reads)} reading call sites, {len(reads) - len(bad)} migrated"
        )
        for p in sorted(set(bad)):
            print(f"  UNMIGRATED  {p.relative_to(REPO)}")
            failed = True

    if failed:
        print()
        print(
            "FAIL: an endpoint returns the envelope but some callers still read a bare array."
        )
        print(
            "      Migrate every consumer in this commit. A shared React Query key means"
        )
        print(
            "      a partial migration breaks at runtime and the build cannot see it."
        )
        return 1
    print("\nOK: every migrated endpoint has every consumer migrated.")
    return 0


def self_test() -> int:
    """Prove the guard can refuse.

    A guard nobody has watched fail is indistinguishable from one whose
    argument is ignored, so this plants a consumer that reads a bare array
    and asserts the scan rejects it.
    """
    with tempfile.TemporaryDirectory() as tmp:
        fake = Path(tmp)
        (fake / "Good.tsx").write_text(
            "const page = await apiGet<Page<Row>>(`/v1/schedule/schedules/?project_id=${id}`);\n"
            "return page.items;\n",
            encoding="utf-8",
        )
        consumers, unmigrated = scan(fake)
        if (
            len(consumers["/v1/schedule/schedules/"]) != 1
            or unmigrated["/v1/schedule/schedules/"]
        ):
            print("SELF-TEST FAIL: a correctly migrated consumer was not accepted.")
            return 1

        (fake / "Bad.tsx").write_text(
            "const rows = await apiGet<ScheduleRow[]>(`/v1/schedule/schedules/?project_id=${id}`);\n"
            "return rows;\n",
            encoding="utf-8",
        )
        consumers, unmigrated = scan(fake)
        if len(unmigrated["/v1/schedule/schedules/"]) != 1:
            print(
                "SELF-TEST FAIL: the guard accepted a consumer still reading a bare array."
            )
            print(
                "                It cannot refuse, so a green run from it means nothing."
            )
            return 1

        # The narrowings have to be proven too, or a later tightening could
        # silence the refusal above without anyone noticing.
        (fake / "Bad.tsx").unlink()
        # The read sits a few lines above the writers, exactly as it does in
        # the real feature api objects. A window-based check passes this file
        # by borrowing the neighbouring apiGet, so it has to be in the fixture.
        (fake / "Writer.tsx").write_text(
            "export const api = {\n"
            "  getGantt: (id) => apiGet<GanttData>(`/v1/schedule/schedules/${id}/gantt/`),\n"
            "  createActivity: (id, body) =>\n"
            "    apiPost<Activity>(`/v1/schedule/schedules/${id}/activities/`, body),\n"
            "  clearActivities: (id) =>\n"
            "    apiDelete<Cleared>(`/v1/schedule/schedules/${id}/activities/`),\n"
            "};\n",
            encoding="utf-8",
        )
        (fake / "Doc.tsx").write_text(
            "/** See `/v1/schedule/schedules/?project_id=...` for the shape. */\n",
            encoding="utf-8",
        )
        consumers, unmigrated = scan(fake)
        if unmigrated["/v1/schedule/schedules/{}/activities/"]:
            print(
                "SELF-TEST FAIL: a POST/DELETE on the route was counted as a truncated read."
            )
            return 1
        if len(consumers["/v1/schedule/schedules/"]) != 1:
            print(
                "SELF-TEST FAIL: a doc comment quoting the route was counted as a consumer."
            )
            return 1

        # A migrated call standing next to a bare read of some OTHER route.
        # Link pickers are written this way everywhere, and the neighbour's
        # route may have no envelope to migrate to, so convicting on it is a
        # failure the file cannot be edited out of.
        for f in fake.glob("*.tsx"):
            f.unlink()
        (fake / "Pickers.tsx").write_text(
            "const docs = useQuery({\n"
            "  queryFn: () => apiGet<PickerDocument[]>(`/v1/documents/?project_id=${id}`),\n"
            "});\n"
            "const schedules = useQuery({\n"
            "  queryFn: () => apiGet<Page<ScheduleRow>>(`/v1/schedule/schedules/?project_id=${id}`),\n"
            "});\n",
            encoding="utf-8",
        )
        consumers, unmigrated = scan(fake)
        if unmigrated["/v1/schedule/schedules/"]:
            print(
                "SELF-TEST FAIL: a migrated call was convicted of its neighbour's bare array."
            )
            print(
                "                Nothing in the file can clear that, so the guard blocks a"
            )
            print("                correct migration instead of an incorrect one.")
            return 1

        # The union that reads either shape is what the migration replaces, so
        # the guard has to refuse it. It is the easiest thing to mistake for
        # migrated: it does mention `items`.
        (fake / "Pickers.tsx").unlink()
        (fake / "Hedge.tsx").write_text(
            "const rows = await apiGet<ScheduleRow[] | { items: ScheduleRow[] }>(\n"
            "  `/v1/schedule/schedules/?project_id=${id}`,\n"
            ");\n",
            encoding="utf-8",
        )
        consumers, unmigrated = scan(fake)
        if len(unmigrated["/v1/schedule/schedules/"]) != 1:
            print(
                "SELF-TEST FAIL: the guard accepted a caller hedging between array and envelope."
            )
            print("                That caller still throws `total` away.")
            return 1
        (fake / "Hedge.tsx").unlink()

        # The cache-key half has to be proven too, and it cannot be proven from
        # the real tree while SHARED_QUERY_KEYS is empty: an empty dict makes
        # the check vacuously pass, which is the shape this whole script exists
        # to reject. So declare a key just for the fixture.
        global SHARED_QUERY_KEYS
        saved = SHARED_QUERY_KEYS
        try:
            SHARED_QUERY_KEYS = {"widgets": "/v1/widgets/"}
            for f in fake.glob("*.tsx"):
                f.unlink()
            (fake / "Reader.tsx").write_text(
                "useQuery({\n"
                "  queryKey: ['widgets'],\n"
                "  queryFn: () => apiGet<Page<Widget>>('/v1/widgets/').then((p) => p.items),\n"
                "});\n",
                encoding="utf-8",
            )
            (fake / "Stale.tsx").write_text(
                "useQuery({\n"
                "  queryKey: ['widgets'],\n"
                "  queryFn: () => apiGet<Widget[]>('/v1/widgets/'),\n"
                "});\n",
                encoding="utf-8",
            )
            # Naming a key to invalidate it never reads the value, so it can
            # never be handed the wrong shape and must not be counted.
            (fake / "Invalidate.tsx").write_text(
                "qc.invalidateQueries({ queryKey: ['widgets'] });\n",
                encoding="utf-8",
            )
            reads, bad = scan_query_keys(fake)["widgets"]
            if len(reads) != 2:
                print(
                    f"SELF-TEST FAIL: expected 2 reading call sites on the key, saw {len(reads)}."
                )
                print(
                    "                An invalidateQueries call was probably miscounted as a read."
                )
                return 1
            if [p.name for p in bad] != ["Stale.tsx"]:
                print(
                    "SELF-TEST FAIL: the cache-key check did not single out the unmigrated reader."
                )
                print(
                    "                It cannot refuse, so it cannot guard the runtime failure."
                )
                return 1
        finally:
            SHARED_QUERY_KEYS = saved

    print("SELF-TEST OK: accepts a migrated consumer, refuses an unmigrated one,")
    print("              ignores writers and doc comments on the same route, and")
    print("              refuses a shared cache key whose readers disagree.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--self-test", action="store_true", help="prove the guard can fail, then exit"
    )
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    # The self test runs before every real scan, not only on demand. The
    # matching here is narrow enough that a later tightening could stop it
    # seeing anything at all, and a guard that cannot refuse reports the same
    # clean run as a tree with nothing wrong in it. Costs one temp directory.
    if self_test() != 0:
        print(
            "FAIL: the guard could not prove it still refuses, so its verdict means nothing."
        )
        return 2
    print()
    return report(FRONTEND)


if __name__ == "__main__":
    sys.exit(main())

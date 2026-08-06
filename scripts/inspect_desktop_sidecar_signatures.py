"""Report the code signature of every Mach-O the onefile sidecar carries inside itself.

Why this exists
---------------
The 14.4.0 desktop build failed to start on macOS with

    code signature in '.../_MEIxxxx/Python.framework/Versions/3.12/Python' not valid
    for use in process: mapping process and mapped file (non-platform) have different
    Team IDs

The onefile bootloader unpacks its archive at launch and dyld then maps those files into
the running process. So the property that decides whether the app starts is not the
signature on the executable a reader sees, it is the signature on the members sealed
inside it. Signing the wrapper says nothing about them, and running the binary on a
build machine says nothing either: enforcement of Team ID matching depends on the
policy applied to the process, and a locally built, never quarantined binary is judged
more leniently than the same file after a user downloads it.

This script reads the archive of the executable that will actually be shipped and prints
what each Mach-O member is signed with. A member carrying a real Team ID while the
process carries none is the exact mismatch dyld refuses, whether or not this machine
happens to enforce it today.

What it measured, and how far that reaches
------------------------------------------
Not the cause of the 14.4.0 failure. The 14.4.0 sidecar was read alongside two later
builds that differ only in the spec's codesign_identity line, and all three came back the
same: 402 Mach-O members, every one ad-hoc with no Team ID. PyInstaller rewrites rpaths
in the binaries it collects, which invalidates their original signatures, and re-signs
them ad-hoc on its own, so that result is what one would expect.

That result was then read more widely than it can carry, and this file was part of why.
The count covers only members this script could open and whose signature it could parse.
A member the reader failed to extract used to drop out of the total silently, and a
member whose codesign output did not yield a TeamIdentifier line was filed under "no Team
ID" rather than "could not tell". Either one would remove a framework binary from the
census without leaving a mark - and a framework binary is precisely what the failure
names. So "402, all ad-hoc" supported "every member we opened is ad-hoc", not "every
member is". Both gaps are now reported, both fail the gate, and --require-member makes a
run fail unless a named member was genuinely inspected.

Whether the shipped archive is clean is therefore still open. What is settled is that the
spec's codesign_identity line does not change this property either way.

That leaves this script as a tripwire rather than a fix: it fails the build the day a
dependency or a packer upgrade starts sealing a vendor-signed binary inside the archive,
which would introduce that failure for real.

Usage:
    python scripts/inspect_desktop_sidecar_signatures.py desktop/dist/openconstructionerp-server

Exit code is 0 unless --fail-on-foreign-team-id is passed, so it can also run as plain
evidence without deciding anything by itself.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Mach-O and universal-binary magic numbers, in the byte order they appear on disk.
MACHO_MAGIC = (
    b"\xcf\xfa\xed\xfe",  # 64-bit little endian
    b"\xce\xfa\xed\xfe",  # 32-bit little endian
    b"\xfe\xed\xfa\xcf",  # 64-bit big endian
    b"\xfe\xed\xfa\xce",  # 32-bit big endian
    b"\xca\xfe\xba\xbe",  # universal
    b"\xbe\xba\xfe\xca",  # universal, swapped
)

TEAM_ID = re.compile(r"^TeamIdentifier=(.+)$", re.MULTILINE)
SIGNATURE = re.compile(r"^Signature=(.+)$", re.MULTILINE)
FLAGS = re.compile(r"^CodeDirectory .*?flags=(\S+)", re.MULTILINE)


def open_archive(path: Path):
    """Return a CArchiveReader over the onefile executable, or None with a reason printed."""
    try:
        from PyInstaller.archive.readers import CArchiveReader
    except ImportError as exc:
        print(f"PyInstaller is not importable here, cannot read the archive: {exc}")
        return None
    try:
        return CArchiveReader(str(path))
    except Exception as exc:  # noqa: BLE001 - any reader failure is equally uninformative
        print(f"could not open {path} as a PyInstaller archive: {exc!r}")
        return None


def member_names(reader) -> list[str]:
    """List archive member names across the reader shapes PyInstaller has shipped."""
    toc = getattr(reader, "toc", None)
    if isinstance(toc, dict):
        return list(toc.keys())
    if isinstance(toc, list):
        names = []
        for entry in toc:
            if isinstance(entry, (list, tuple)) and entry:
                names.append(
                    str(entry[-1]) if isinstance(entry[-1], str) else str(entry[0])
                )
            else:
                names.append(str(entry))
        return names
    print(
        f"unfamiliar reader shape, attributes: {sorted(a for a in dir(reader) if not a.startswith('_'))}"
    )
    return []


def extract(reader, name: str) -> bytes | None:
    for attempt in ("extract", "extract_file", "open_embedded_archive"):
        fn = getattr(reader, attempt, None)
        if fn is None:
            continue
        try:
            data = fn(name)
        except Exception:  # noqa: BLE001 - try the next shape
            continue
        if isinstance(data, tuple) and len(data) == 2:
            data = data[1]
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
    return None


def describe(path: Path) -> dict[str, str]:
    proc = subprocess.run(
        ["codesign", "-dvvv", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    text = proc.stdout + proc.stderr
    team = TEAM_ID.search(text)
    sig = SIGNATURE.search(text)
    flags = FLAGS.search(text)
    return {
        "team": team.group(1).strip()
        if team
        else ("unsigned" if "not signed" in text else "unknown"),
        "signature": sig.group(1).strip() if sig else "none",
        "flags": flags.group(1).strip() if flags else "-",
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("executable", type=Path)
    parser.add_argument(
        "--limit",
        type=int,
        default=600,
        help="stop after this many Mach-O members; the count skipped is always printed",
    )
    parser.add_argument(
        "--fail-on-foreign-team-id",
        action="store_true",
        help=(
            "exit non-zero when a member carries a Team ID the wrapper does not, "
            "and also when any member could not be read or parsed - a census "
            "that skipped members cannot support a claim about all of them"
        ),
    )
    parser.add_argument(
        "--require-member",
        action="append",
        metavar="SUBSTRING",
        help=(
            "fail unless a member whose name contains SUBSTRING was actually "
            "inspected. Repeatable. Use it to name the file in a failure report "
            "(for example Python.framework) so a run cannot clear it by silently "
            "never opening it."
        ),
    )
    args = parser.parse_args()

    if sys.platform != "darwin":
        print("codesign only exists on macOS, nothing to measure here")
        return 0
    if not args.executable.is_file():
        print(f"no such file: {args.executable}")
        return 1

    wrapper = describe(args.executable)
    print(
        f"wrapper: Signature={wrapper['signature']} TeamIdentifier={wrapper['team']} flags={wrapper['flags']}"
    )
    print()

    reader = open_archive(args.executable)
    if reader is None:
        return 1

    names = member_names(reader)
    print(f"archive members: {len(names)}")

    workdir = Path(tempfile.mkdtemp(prefix="sidecar-inspect-"))
    try:
        checked = 0
        skipped_over_limit = 0
        unreadable_names: list[str] = []
        inspected_names: list[str] = []
        by_team: dict[str, list[str]] = {}
        for name in names:
            data = extract(reader, name)
            if data is None:
                # Keep the name, not just a tally. A member the reader cannot
                # open is not a member without a Team ID: it is a member nobody
                # looked at, and it drops out of every count below. The 402
                # figure this script produced was read as "every member is
                # ad-hoc" when what it could support was "every member we could
                # open is ad-hoc" - and the one file named in the failure is
                # precisely the one whose absence from the census would be
                # invisible.
                unreadable_names.append(name)
                continue
            if data[:4] not in MACHO_MAGIC:
                continue
            if checked >= args.limit:
                skipped_over_limit += 1
                continue
            target = workdir / Path(name).name
            target.write_bytes(data)
            info = describe(target)
            by_team.setdefault(info["team"], []).append(name)
            inspected_names.append(name)
            checked += 1
            target.unlink(missing_ok=True)

        print(f"Mach-O members inspected: {checked}")
        if skipped_over_limit:
            print(
                f"Mach-O members NOT inspected because --limit {args.limit} was reached: {skipped_over_limit}"
            )
        if unreadable_names:
            print(f"members the reader could not extract: {len(unreadable_names)}")
            for name in sorted(unreadable_names)[:12]:
                print(f"    {name}")
            if len(unreadable_names) > 12:
                print(f"    ... and {len(unreadable_names) - 12} more")
        print()
        for team in sorted(by_team):
            members = by_team[team]
            print(f"TeamIdentifier={team}: {len(members)} member(s)")
            for name in sorted(members)[:12]:
                print(f"    {name}")
            if len(members) > 12:
                print(f"    ... and {len(members) - 12} more")

        foreign = {
            t: m
            for t, m in by_team.items()
            if t not in ("not set", "unsigned", "unknown")
        }
        # "unknown" means codesign printed something this script could not parse
        # a TeamIdentifier out of. Folding it into "no Team ID" is how a member
        # whose signature could not be read came to be counted as evidence that
        # no member has one. It is inconclusive, and it belongs with the members
        # that could not be extracted at all.
        inconclusive = list(by_team.get("unknown", [])) + unreadable_names
        if inconclusive:
            print()
            print(
                f"INCONCLUSIVE: {len(inconclusive)} member(s) were not read or not parsed, "
                "so no statement about the archive as a whole is supported by this run."
            )

        missing_required = [
            pat
            for pat in (args.require_member or [])
            if not any(pat in n for n in inspected_names)
        ]
        if missing_required:
            print()
            for pat in missing_required:
                print(
                    f"NOT INSPECTED: no member whose name contains {pat!r} was measured."
                )
            print(
                "A census that never opened the file named in the failure cannot clear it."
            )

        if foreign and wrapper["team"] in ("not set", "unsigned"):
            print()
            print("MISMATCH: the wrapper carries no Team ID and these members do.")
            print(
                "This is the shape that makes dyld refuse to map them into the process."
            )
            if args.fail_on_foreign_team_id:
                return 1
        elif not foreign and not inconclusive and not missing_required:
            print()
            print(
                "No member carries a Team ID, so no member can disagree with the process about one."
            )

        # Under the gate, an unread member and an unmeasured required member are
        # failures in their own right: the gate's whole claim is that nothing
        # foreign is in there, and that claim is only as wide as what was opened.
        if args.fail_on_foreign_team_id and (inconclusive or missing_required):
            return 1
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

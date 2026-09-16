#!/usr/bin/env python3
"""Differential lint check: poly's embedded engines against the CLI they embed.

`poly check` links its linters in as libraries rather than downloading them, so
what a user gets is poly's call into the engine, not the engine's own binary.
That is the whole bet of it -- three of four per-tool failure modes stop
existing -- and the cost is that nothing in the repo's own tests can tell the
difference between "poly drives the engine the way its CLI does" and "poly
drives it some other way and the fixtures happen not to notice". Only running
both over the same files answers that.

Two things make the answer trustworthy:

* The upstream version is read out of `cli/Cargo.toml`, and the pin must be
  exact. A comparison against a different version of the engine measures the
  engine's release notes, not poly.
* The corpus is the engine project's own test fixtures, at the tag matching
  that pin -- files whose authors wrote each one to trip a specific rule. They
  are fetched, never committed: somebody else's test data in this repo would be
  a stale fork of it.

The corpus is copied out of the clone before either side sees it. A fixture
tree that is still inside its own repository is governed by that repository's
config -- ruff's own `[tool.ruff]`, its `exclude`, its
`per-file-target-version` -- and which side picks that up depends on where each
one starts looking. Measured: inside the clone the two disagreed on 3,418
findings, of which every one was the outer config reaching one side; copied out
and given one config of this script's own, 3,015 of those differences were
never real.

Usage: python3 tools/engine-diff.py <poly-binary> [engine ...]
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(tempfile.gettempdir()) / "poly-engine-diff"


@dataclass(frozen=True)
class Engine:
    """One embedded engine, and how to ask its own CLI the same question."""

    #: What is being compared: findings, or the bytes of the formatted file.
    mode: str
    #: The crate in `cli/Cargo.toml` whose pin names the upstream *release*, and
    #: with it the tag the corpus is taken from. Not always the crate doing the
    #: work: ruff publishes its formatter and notebook crates on their own 0.0.x
    #: line, so the only pin that names a ruff release is the linter's.
    crate: str
    #: mise's name for the upstream CLI. Installed but never activated, so
    #: nothing here touches a config file or PATH.
    cli: str
    repo: str
    #: Where the project keeps the fixtures, inside its own repository.
    fixtures: str
    #: File extensions worth counting. A fixture tree holds more than the
    #: engine's own language, and a file neither side lints is not a finding.
    suffixes: tuple[str, ...]
    #: The config both sides read, written into the copied corpus, or None for
    #: no config at all. Selecting every rule is what makes a linter's fixtures
    #: worth running: each was written for one rule, and the default set leaves
    #: most of them silent.
    #:
    #: None is not "nothing to configure" -- it is for a tool whose behaviour
    #: the file's mere presence changes. StyLua reads `.editorconfig` only when
    #: it finds no `stylua.toml`, so writing an empty one to "hold the config
    #: still" silences an entire layer on the upstream side and nothing on
    #: poly's. Measured: it invented four differences and hid whatever the real
    #: ones were.
    config: tuple[str, str] | None
    #: The upstream invocation, minus the directory.
    argv: tuple[str, ...]
    #: `git tag` for `version`, where the project's tags are not bare versions.
    tag: str = "{version}"
    #: Globs, matched against both the slash-separated path under `fixtures`
    #: and the bare name, for what to leave behind. For files that are in the
    #: tree for the project's own test harness rather than for the engine.
    skip: tuple[str, ...] = ()
    #: Crates that must also carry an exact pin for this comparison to mean
    #: anything, for engines whose working crate is not the one naming the
    #: release. Unpinning one of these would change poly's answer while the
    #: version printed by this script stayed put.
    pins: tuple[str, ...] = ()


ENGINES: dict[str, Engine] = {
    "ruff": Engine(
        mode="lint",
        crate="ruff_linter",
        cli="ruff",
        repo="astral-sh/ruff",
        fixtures="crates/ruff_linter/resources/test/fixtures",
        suffixes=(".py", ".pyi", ".ipynb"),
        config=("ruff.toml", '[lint]\nselect = ["ALL"]\n'),
        argv=("check", "--output-format", "json", "--no-cache"),
    ),
    "ruff-format": Engine(
        mode="format",
        # ruff_python_formatter's own pin is 0.0.12, which names no ruff
        # release; the linter's is the one that does. Both are checked.
        crate="ruff_linter",
        pins=("ruff_python_formatter", "ruff_notebook"),
        cli="ruff",
        repo="astral-sh/ruff",
        fixtures="crates/ruff_linter/resources/test/fixtures",
        suffixes=(".py", ".pyi", ".ipynb"),
        # The formatter has no rule selection to widen, so the config exists
        # only to stop an ancestor `pyproject.toml` from reaching one side.
        config=("ruff.toml", "[format]\n"),
        argv=("format", "--no-cache"),
    ),
    "stylua": Engine(
        mode="format",
        crate="stylua",
        cli="stylua",
        repo="JohnnyMorganz/StyLua",
        tag="v{version}",
        fixtures="tests",
        suffixes=(".lua", ".luau"),
        # StyLua's defaults and poly's `[format.lua]` defaults are the same
        # three numbers -- 120 columns, 4-wide, tabs -- so both sides can run
        # at their own defaults. No config written: see `Engine.config`.
        config=None,
        # The project's own harness, not the engine's input: `.snap` files are
        # expected output and the `.rs` files are the test drivers, which poly
        # would hand to rustfmt.
        skip=("snapshots", "*.rs", "*.snap"),
        argv=(),
    ),
}


# Rules the two sides are expected to disagree about, and why.
#
# Checked in both directions, like every other differential here: a rule listed
# that stops differing is reported as a lapse, because the only two ways that
# happens are poly gaining the behaviour (delete the entry) and the upstream
# losing it (worth knowing).
EXPECTED: dict[tuple[str, str], str] = {
    ("ruff", "N999"): (
        "package detection: poly passes no package to `lint_only`, so the module name "
        "a module-name rule needs is not there (poly-engines/src/lint.rs)"
    ),
    ("ruff", "INP001"): (
        "the same, read the other way: with no package every file looks like it is in "
        "an implicit namespace one"
    ),
    ("ruff", "D100"): (
        "the same -- a module docstring rule has to know the file is a module"
    ),
    ("ruff", "D104"): "the same, for a package's `__init__.py`",
    ("ruff", "PLW0406"): (
        "the same -- import-self compares against the module's own name"
    ),
    ("ruff", "RUF200"): (
        "ruff lints `pyproject.toml` itself; poly's ruff engine answers for Python "
        "source, and poly's own toml rules answer for the manifest"
    ),
    # Format mode is keyed by what kind of difference it is rather than by a
    # rule, because a formatter has no rule to name. See `ruff_format_class`.
    ("ruff-format", "toml"): (
        "`ruff format` formats Python; `poly fmt` formats the whole tree, so poly's "
        "toml formatter reaches the pyproject.toml files ruff walks past"
    ),
    ("stylua", "stylua-toml"): (
        "poly does not read `stylua.toml`: `[format.lua]` sets the layout and "
        "`.editorconfig` is the file both tools share (poly.example.toml, [format.<lang>]). "
        "So where a fixture has both, StyLua takes the stylua.toml and poly the "
        ".editorconfig -- and this is the only Lua fixture of 416 where they part"
    ),
}


def run(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    # No `check`: every caller here reads the exit code itself, and a linter
    # exits non-zero precisely when it has the findings this script is after.
    return subprocess.run(argv, capture_output=True, text=True, check=False, **kwargs)


def pinned(crate: str) -> str:
    """The exact version `cli/Cargo.toml` pins, or a loud failure."""
    manifest = (ROOT / "cli" / "Cargo.toml").read_text(encoding="utf-8")
    match = re.search(
        rf'^{re.escape(crate)} = (?:"([^"]+)"|\{{ version = "([^"]+)")',
        manifest,
        re.MULTILINE,
    )
    if not match:
        raise SystemExit(f"{crate} is not a dependency in cli/Cargo.toml")
    version = match.group(1) or match.group(2)
    if not version.startswith("="):
        # A caret pin resolves to whatever cargo felt like, and the corpus tag
        # would then name a different release than the one linked in. The
        # comparison would still run and would mean nothing.
        raise SystemExit(
            f"{crate} is pinned as {version!r}; this comparison needs an exact `=` pin"
        )
    return version.lstrip("=")


def upstream_cli(engine: Engine, version: str) -> list[str]:
    """The upstream binary at `version`, installed through mise but not activated."""
    spec = f"{engine.cli}@{version}"
    if run(["mise", "x", spec, "--", engine.cli, "--version"]).returncode != 0:
        print(f"  installing {spec}", flush=True)
        install = run(["mise", "install", spec])
        if install.returncode != 0:
            raise SystemExit(f"mise install {spec} failed:\n{install.stderr}")
    return ["mise", "x", spec, "--", engine.cli]


def corpus(engine: Engine, version: str, copy: str = "corpus") -> Path:
    """The project's own fixtures at `version`, copied out of the clone.

    Sparse and blob-filtered: the fixtures are megabytes and the repositories
    they live in are gigabytes, and nothing here reads anything else.
    """
    clone = CACHE / f"{engine.cli}-{version}"
    if not (clone / ".git").exists():
        shutil.rmtree(clone, ignore_errors=True)
        clone.parent.mkdir(parents=True, exist_ok=True)
        tag = engine.tag.format(version=version)
        print(f"  cloning {engine.repo} at {tag}", flush=True)
        got = run(
            [
                "git",
                "clone",
                "--depth",
                "1",
                "--filter=blob:none",
                "--sparse",
                "--branch",
                tag,
                f"https://github.com/{engine.repo}",
                str(clone),
            ]
        )
        if got.returncode != 0:
            raise SystemExit(f"cloning {engine.repo} at {tag} failed:\n{got.stderr}")
        sparse = run(["git", "sparse-checkout", "set", engine.fixtures], cwd=clone)
        if sparse.returncode != 0:
            raise SystemExit(f"sparse-checkout failed:\n{sparse.stderr}")

    # Rebuilt every run rather than cached: it is a copy of files already on
    # disk, and a scratch tree that survives a change to `config` would answer
    # yesterday's question.
    out = CACHE / f"{engine.cli}-{version}-{copy}"
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(clone / engine.fixtures, out)
    # Deepest first, so removing a directory cannot invalidate a path still to
    # be visited.
    for path in sorted(out.rglob("*"), key=lambda p: -len(p.parts)):
        rel = str(path.relative_to(out)).replace(os.sep, "/")
        if any(fnmatch(rel, pat) or fnmatch(path.name, pat) for pat in engine.skip):
            shutil.rmtree(path) if path.is_dir() else path.unlink()
    if engine.config is not None:
        name, text = engine.config
        # A config the project ships at the root of its own fixtures would
        # answer for one side and not the other, as an ancestor one would.
        (out / name).unlink(missing_ok=True)
        (out / f".{name}").unlink(missing_ok=True)
        (out / name).write_text(text, encoding="utf-8")
    return out


def poly_findings(poly: str, where: Path, tool: str) -> Counter:
    """`poly check`'s findings for one tool, as anchors."""
    got = run([poly, "check", "--format", "json", "."], cwd=where)
    # The coverage block is printed after the document rather than inside it,
    # so the JSON is a prefix and not the whole of stdout.
    report, _ = json.JSONDecoder().raw_decode(got.stdout)
    return Counter(
        (
            issue["file"].replace(os.sep, "/"),
            issue["line"],
            issue["col"],
            issue["rule"] or "",
        )
        for issue in report["issues"]
        if issue["tool"] == tool
    )


def ruff_findings(cli: list[str], where: Path) -> Counter:
    got = run(cli + list(ENGINES["ruff"].argv) + ["."], cwd=where)
    return Counter(
        (
            os.path.relpath(
                os.path.realpath(one["filename"]), os.path.realpath(where)
            ).replace(os.sep, "/"),
            one["location"]["row"],
            one["location"]["column"],
            one["code"] or "",
        )
        for one in json.loads(got.stdout)
    )


READERS = {"ruff": ruff_findings}


def ruff_format_class(root: Path, rel: str, mine: bytes, theirs: bytes) -> str:
    """What kind of difference this is, for a file the two formatted differently.

    Notebooks are split into two classes rather than one. They agree today, so
    neither is declared -- but the two ways they could stop agreeing deserve
    separate names, because one is cosmetic and the other is a cell of somebody's
    Python formatted wrongly. `ipynb-key-order` was a real entry here until
    `with_sorted_keys` landed in poly-engines, and it is the difference that
    comes back if that sort is ever dropped.

    A key of `.ipynb` would merge the two, and the cosmetic one is the more
    likely to reappear -- so the cell-content difference, the one that matters,
    would be the one hiding behind a declared entry.
    """
    if rel.endswith(".ipynb"):
        try:
            same = json.loads(mine) == json.loads(theirs)
        except (ValueError, UnicodeDecodeError):
            same = False
        return "ipynb-key-order" if same else "ipynb-content"
    if rel.endswith(".toml"):
        return "toml"
    return Path(rel).suffix.lstrip(".") or "no-suffix"


def stylua_class(root: Path, rel: str, mine: bytes, theirs: bytes) -> str:
    """A `stylua.toml` in scope answers a different question from the rest.

    StyLua reads that file and poly does not -- `[format.lua]` is poly's answer
    and `.editorconfig` is the shared one -- so a fixture sitting under one is
    measuring a documented choice. Everything else is keyed by the directory
    StyLua filed it under, which is what it is testing; a key of `.lua` would
    merge every fixture in the project into one number.
    """
    parts = rel.split("/")
    for depth in range(len(parts) - 1, -1, -1):
        if (root.joinpath(*parts[:depth]) / "stylua.toml").exists():
            return "stylua-toml"
    return parts[0]


CLASSES = {"ruff-format": ruff_format_class, "stylua": stylua_class}


def format_differences(
    engine: Engine, name: str, cli: list[str], version: str, poly: str
) -> tuple[int, Counter, dict[str, str]]:
    """Format one copy of the corpus with each side; classify what differs.

    Two copies rather than one and a `--diff` flag: `poly fmt` writes, and the
    question is what a user's tree looks like afterwards. A flag that prints a
    diff is a different code path in both tools.
    """
    mine_dir = corpus(engine, version, "poly")
    theirs_dir = corpus(engine, version, "upstream")
    total = sum(1 for p in mine_dir.rglob("*") if p.suffix in engine.suffixes)
    run([poly, "fmt", "."], cwd=mine_dir)
    run(cli + list(engine.argv) + ["."], cwd=theirs_dir)

    classify = CLASSES[name]
    differences: Counter = Counter()
    examples: dict[str, str] = {}
    for path in sorted(mine_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = str(path.relative_to(mine_dir)).replace(os.sep, "/")
        if engine.config is not None and rel == engine.config[0]:
            continue
        other = theirs_dir / rel
        mine, theirs = path.read_bytes(), other.read_bytes() if other.exists() else b""
        if mine == theirs:
            continue
        kind = classify(mine_dir, rel, mine, theirs)
        differences[kind] += 1
        examples.setdefault(kind, rel)
    return total, differences, examples


def compare(name: str, engine: Engine, poly: str) -> int:
    version = pinned(engine.crate)
    for extra in engine.pins:
        pinned(extra)
    print(f"{name} {version} (pinned as {engine.crate} in cli/Cargo.toml)")
    cli = upstream_cli(engine, version)

    if engine.mode == "format":
        total, by_rule, examples = format_differences(engine, name, cli, version, poly)
        print(f"  {total} fixtures, {sum(by_rule.values())} formatted differently")
        only_theirs = only_mine = Counter()
    else:
        where = corpus(engine, version)
        files = sum(1 for p in where.rglob("*") if p.suffix in engine.suffixes)
        print(f"  {files} fixtures in {where}")
        theirs = READERS[name](cli, where)
        mine = poly_findings(poly, where, name)
        only_theirs, only_mine = theirs - mine, mine - theirs
        agreed = sum((theirs & mine).values())
        print(
            f"  upstream {sum(theirs.values())}, poly {sum(mine.values())}, agreed {agreed}"
        )
        by_rule = Counter()
        for anchor in only_theirs.elements():
            by_rule[anchor[3]] += 1
        for anchor in only_mine.elements():
            by_rule[anchor[3]] += 1
        examples = {}

    failed = 0
    declared = set()
    for rule, count in by_rule.most_common():
        reason = EXPECTED.get((name, rule))
        if reason:
            declared.add(rule)
            print(f"  note {rule}: {count} differ on purpose -- {reason}")
            continue
        failed += 1
        if engine.mode == "format":
            print(
                f"  FAIL {rule}: {count} files formatted differently with no reason on record"
            )
            print(f"         e.g. {examples[rule]}")
            continue
        print(f"  FAIL {rule}: {count} findings differ with no reason on record")
        for anchor in list((only_theirs + only_mine).elements()):
            if anchor[3] != rule:
                continue
            side = "only upstream" if anchor in only_theirs else "only poly"
            print(f"         {anchor[0]}:{anchor[1]}:{anchor[2]} {side}")
            break

    # The other direction. A reason on record for a rule that no longer differs
    # is a claim nobody is checking any more, and it reads as coverage.
    for (engine_name, rule), reason in EXPECTED.items():
        if engine_name == name and rule not in declared:
            failed += 1
            print(
                f"  FAIL {rule}: agrees now, but is still recorded as differing -- {reason}"
            )
    return failed


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    # Absolute: both sides are run with the corpus as their working directory,
    # so a path like `cli/target/release/poly` would resolve against that.
    poly = str(Path(sys.argv[1]).resolve())
    wanted = sys.argv[2:] or list(ENGINES)
    unknown = [name for name in wanted if name not in ENGINES]
    if unknown:
        print(f"no such engine: {', '.join(unknown)}", file=sys.stderr)
        return 2

    CACHE.mkdir(parents=True, exist_ok=True)
    failed = sum(compare(name, ENGINES[name], poly) for name in wanted)
    print()
    if failed:
        print(f"{failed} difference(s) with no reason on record")
        return 1
    print(
        f"{len(wanted)} engine(s) agree with the CLI they embed, but for what is recorded"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

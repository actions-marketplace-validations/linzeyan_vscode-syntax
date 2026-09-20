#!/usr/bin/env python3
"""Differential check: poly's embedded engines against the projects they embed.

`poly fmt` and `poly check` link their engines in as libraries rather than
downloading them, so what a user gets is poly's call into the engine, not the
engine's own binary. That is the whole bet of it -- three of four per-tool
failure modes stop existing -- and the cost is that nothing in the repo's own
tests can tell the difference between "poly drives the engine the way its
project does" and "poly drives it some other way and the fixtures happen not to
notice". Only asking both the same question answers that.

There are two ways to ask, and `Engine.mode` picks one:

* `lint` and `format` run the engine's own CLI over a corpus and compare. This
  is for the engines that ship a binary somebody can install.
* `fixture` compares against the expected output the project keeps in its own
  repository, beside each input -- the file its CI holds it to. Nothing
  upstream is installed or run. Most of poly's formatters have no CLI to
  install: the dprint and g-plane engines ship as wasm plugins, and a
  comparison against a wasm build is a comparison against a different artefact
  than the crate poly links.

Two things make the answer trustworthy either way:

* The upstream version comes from `cli/Cargo.lock` -- the release actually
  linked in. Where poly pins a crate exactly, the manifest is checked against
  the lock as well, because a pin the lock disagrees with would mean the corpus
  and the binary came from different releases.
* The corpus is the project's own test fixtures at the tag matching that
  version -- files whose authors wrote each one to pin down one behaviour.
  They are fetched, never committed: somebody else's test data in this repo
  would be a stale fork of it.

What a `fixture` run cannot ask is as important as what it can. Every project
here has cases that configure the engine beyond the three keys
`[format.<lang>]` exposes, and each loader counts and names those rather than
dropping them -- a loader that skipped them quietly would report a thousand
comparisons and make a hundred. The exception is a config poly *can* say:
dprint's specs mostly just narrow `lineWidth` to make a case break somewhere
visible, and those are translated into a poly.toml beside the case, which is
what takes dprint-plugin-typescript from 311 comparable cases to 944.

For the CLI modes, the corpus is copied out of the clone before either side
sees it. A fixture tree that is still inside its own repository is governed by
that repository's config -- ruff's own `[tool.ruff]`, its `exclude`, its
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
    """One embedded engine, and how to ask the same question upstream.

    Two ways to ask it, and which one applies is `mode`. `lint` and `format`
    run the engine's own CLI over a corpus and compare the two answers.
    `fixture` does not run anything upstream at all: some projects keep the
    expected output *in the repository*, beside the input, and that file is
    already the answer their CI holds them to. Comparing against it needs no
    binary to install and cannot drift from the tag, which matters most for
    exactly the engines that have no CLI to install -- the dprint and g-plane
    formatters ship as wasm plugins, not as tools.
    """

    #: What is being compared: findings, the bytes of the formatted file, or
    #: the bytes the project's own fixtures say to expect.
    mode: str
    #: The crate in `cli/Cargo.toml` whose pin names the upstream *release*, and
    #: with it the tag the corpus is taken from. Not always the crate doing the
    #: work: ruff publishes its formatter and notebook crates on their own 0.0.x
    #: line, so the only pin that names a ruff release is the linter's.
    crate: str
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
    #: mise's name for the upstream CLI, for the two modes that run one.
    #: Installed but never activated, so nothing here touches a config file or
    #: PATH. Empty in `fixture` mode, which runs nothing upstream.
    cli: str = ""
    #: The upstream invocation, minus the directory.
    argv: tuple[str, ...] = ()
    #: How the project lays its fixtures out, in `fixture` mode. One loader per
    #: shape rather than per project: the four g-plane formatters share a test
    #: harness, and so do the five dprint plugins.
    layout: str = ""
    #: Whether `cli/Cargo.toml` must pin this crate exactly. True for the
    #: engines whose rule set or layout *is* poly's answer, where a caret pin
    #: would let `cargo update` change what poly calls clean.
    #:
    #: False is not "the pin does not matter" -- it is for the crates poly
    #: already pins with a caret, where the version to compare against is
    #: whatever `cli/Cargo.lock` resolved. Reading the lock keeps this
    #: comparison honest either way: the corpus always comes from the release
    #: that is actually linked in, not the one the manifest asked for.
    exact: bool = True
    #: poly's language id for this engine's files, for writing a `[format.<lang>]`
    #: table when a case asks for one.
    language: str = ""
    #: Which of poly's three knobs this language has. Setting one it does not
    #: have fails the whole run rather than being ignored, which is the right
    #: behaviour for a user's poly.toml and a trap for a generated one:
    #: markdown takes a line width and rejects both of the others.
    knobs: tuple[str, ...] = ()
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
    "malva": Engine(
        mode="fixture",
        layout="g-plane",
        crate="malva",
        # Caret-pinned in cli/Cargo.toml, so the release to compare against is
        # whichever one the lock resolved. See `Engine.exact`.
        exact=False,
        repo="g-plane/malva",
        tag="v{version}",
        fixtures="malva/tests/fmt",
        suffixes=(".css", ".scss", ".less"),
        # No config, and none possible: the corpus is read out of the clone
        # rather than copied through `corpus()`, and the scratch tree it is
        # written into lives under /tmp with no .editorconfig above it. Both
        # sides are therefore at malva's own defaults, which is the only
        # arrangement where its snapshots are the right answer.
        config=None,
    ),
    "pretty_yaml": Engine(
        mode="fixture",
        layout="g-plane",
        crate="pretty_yaml",
        exact=False,
        repo="g-plane/pretty_yaml",
        tag="v{version}",
        # `pretty_yaml/tests/fmt` only. The sibling `yaml_parser/tests` holds
        # the parser's own cases, and its snapshots are parse trees rather than
        # formatted YAML -- the same tree, a different question.
        fixtures="pretty_yaml/tests/fmt",
        suffixes=(".yaml",),
        config=None,
    ),
    "pretty_graphql": Engine(
        mode="fixture",
        layout="g-plane",
        crate="pretty_graphql",
        exact=False,
        repo="g-plane/pretty_graphql",
        tag="v{version}",
        fixtures="pretty_graphql/tests/fmt",
        suffixes=(".graphql",),
        config=None,
    ),
    "markup_fmt": Engine(
        mode="fixture",
        layout="g-plane",
        crate="markup_fmt",
        exact=False,
        repo="g-plane/markup_fmt",
        tag="v{version}",
        fixtures="markup_fmt/tests/fmt",
        # The six of the project's ten extensions poly has a language for.
        # `.njk` and `.vto` are template dialects poly does not map; `.mustache`
        # is one poly reaches only through `.hbs`; and `.xml` poly formats with
        # xmlem rather than with markup_fmt, so its cases would be comparing
        # the wrong engine.
        suffixes=(".html", ".vue", ".svelte", ".astro", ".jinja", ".hbs"),
        config=None,
    ),
    "mago": Engine(
        mode="fixture",
        layout="mago",
        # Exactly pinned, and all ten mago crates move together -- a `Program`
        # from one release is not one the next release's formatter takes.
        crate="mago-formatter",
        repo="carthage-software/mago",
        # The whole `tests` directory, not just `cases`: the harness's own .rs
        # files are what say which PHP each case was run at. See `mago_versions`.
        fixtures="crates/formatter/tests",
        suffixes=(".php",),
        config=None,
    ),
    # The five dprint plugins, all caret-pinned and all laid out the same way.
    # `fixtures="tests"` rather than `tests/specs` for each of them: the
    # runner's .rs file beside it is what names the language the specs are in.
    "dprint-typescript": Engine(
        mode="fixture",
        layout="dprint",
        crate="dprint-plugin-typescript",
        exact=False,
        repo="dprint/dprint-plugin-typescript",
        language="typescript",
        knobs=("line-width", "indent-width", "use-tabs"),
        fixtures="tests",
        suffixes=(".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"),
        # The one engine where poly's default is deliberately not the
        # plugin's. dprint inherits dprint-core's global indent width of four
        # for TypeScript; poly ships two, which is what the ecosystem and
        # poly.example.toml both say. That is a decision about house style and
        # not about how poly drives the plugin, and comparing at two turned 133
        # of 311 cases into "this line is indented differently" -- with the 18
        # that were about something else underneath them.
        config=("poly.toml", "[format.typescript]\nindent-width = 4\n"),
    ),
    "dprint-json": Engine(
        mode="fixture",
        layout="dprint",
        crate="dprint-plugin-json",
        exact=False,
        repo="dprint/dprint-plugin-json",
        language="json",
        knobs=("line-width", "indent-width", "use-tabs"),
        fixtures="tests",
        suffixes=(".json", ".jsonc"),
        config=None,
    ),
    "dprint-markdown": Engine(
        mode="fixture",
        layout="dprint",
        crate="dprint-plugin-markdown",
        exact=False,
        repo="dprint/dprint-plugin-markdown",
        language="markdown",
        # No indent width and no tabs: poly rejects both for markdown.
        knobs=("line-width",),
        fixtures="tests",
        suffixes=(".md",),
        config=None,
    ),
    "dprint-toml": Engine(
        mode="fixture",
        layout="dprint",
        crate="dprint-plugin-toml",
        exact=False,
        repo="dprint/dprint-plugin-toml",
        language="toml",
        knobs=("line-width", "indent-width", "use-tabs"),
        fixtures="tests",
        suffixes=(".toml",),
        config=None,
    ),
    "dprint-dockerfile": Engine(
        mode="fixture",
        layout="dprint",
        crate="dprint-plugin-dockerfile",
        exact=False,
        repo="dprint/dprint-plugin-dockerfile",
        language="dockerfile",
        # poly rejects use-tabs for Dockerfile.
        knobs=("line-width", "indent-width"),
        fixtures="tests",
        suffixes=(".dockerfile",),
        config=None,
    ),
}


# Rules the two sides are expected to disagree about, and why.
#
# Checked in both directions, like every other differential here: a rule listed
# that stops differing is reported as a lapse, because the only two ways that
# happens are poly gaining the behaviour (delete the entry) and the upstream
# losing it (worth knowing).
EXPECTED: dict[tuple[str, str], str] = {
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
    ("dprint-typescript", "external_formatter/sql"): (
        "poly formats a sql`` template with sqruff, the engine it formats a .sql file "
        "with; dprint-plugin-typescript's spec runner uses dprint-plugin-sql. Both are "
        "correct SQL and they lay it out differently -- sqruff normalises the "
        "whitespace and keeps the statement on one line where it fits, sqlformat breaks "
        "every clause. Matching upstream here would mean linking a second SQL formatter "
        "and having poly lay the same query out differently depending on whether it sat "
        "in a .sql file or a template literal"
    ),
    ("markup_fmt", "angular-template"): (
        "poly has no `angular` language and does not want one (decided 2026-09-17). "
        "markup_fmt reads `*.component.html` as Angular, where `@if` / `@for` / "
        "`@switch` / `@defer` are markup it indents; poly's language table maps the "
        "file to html, so those blocks are text and stay on one line. An Angular "
        "template poly formats is left readable but not laid out -- it is not "
        "rewritten wrongly"
    ),
    # markup_fmt hands every embedded language back to its caller; its own
    # harness returns the code untouched and poly formats it. See
    # `markup_class`. Each of the three was read case by case before it was
    # declared -- 35 differences, every one of them inside embedded code.
    ("markup_fmt", "embedded-front-matter"): (
        "Astro's `---` fence is TypeScript, and poly formats it: semicolons, `// ` "
        "after a line comment's slashes, double quotes. markup_fmt's harness returns "
        "the fence unchanged"
    ),
    ("markup_fmt", "embedded-script-style"): (
        "the same, for a `<script>` or `<style>` block -- poly reaches "
        "dprint-plugin-typescript and malva for the contents"
    ),
    ("markup_fmt", "embedded-expression"): (
        "the same, for an interpolation, a directive value or an inline `style` "
        'attribute: `{{ a||b }}` becomes `{{ a || b }}` and `style="color:#fff"` '
        "gains its space and semicolon. One knock-on is worth naming -- formatting "
        "an attribute can change its length, so a tag that fitted on one line "
        "before poly touched the attribute no longer does (html/attributes/iframe.html)"
    ),
    ("dprint-markdown", "embedded-code-block"): (
        "a fenced code block: poly formats the block with the engine for the language "
        "on the fence, and dprint-plugin-markdown's test runner returns None for every "
        "language but its own stub -- so upstream's `\u0060\u0060\u0060ts` block keeps the "
        "missing semicolon poly adds"
    ),
    ("dprint-markdown", "fake-format-language"): (
        "the other direction, and not a language: upstream's runner answers a block "
        "tagged `format` by appending `_formatted_<line width>` to it, which is how it "
        "tests that the width reaches an embedded block at all. poly has no `format` "
        "language and leaves the block alone"
    ),
    ("mago", "line-endings"): (
        "the mago CLI writes LF whatever it read; poly round-trips the file's own "
        "endings, and `end_of_line = cr` resolves to None rather than rewriting every "
        "line in the file (poly-core/src/lib.rs). Normalised, the two agree on the "
        "bytes that are not line endings -- including the heredoc indent of issue_225"
    ),
    ("mago", "not-utf8"): (
        "poly does not format a file that is not UTF-8, and mago does: it reads bytes "
        "and poly reads text. One fixture, `non_utf8_identifiers`, where poly hands "
        "the file back untouched rather than guessing at an encoding"
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


def resolved(crate: str) -> str:
    """The version `cli/Cargo.lock` actually resolved, or a loud failure.

    The lock rather than the manifest, because the lock is what was linked in.
    For an exactly pinned crate the two agree and this is a second reading of
    the same number; for a caret-pinned one the manifest names a range and only
    this says which release poly is carrying.
    """
    lock = (ROOT / "cli" / "Cargo.lock").read_text(encoding="utf-8")
    match = re.search(
        rf'^name = "{re.escape(crate)}"\nversion = "([^"]+)"',
        lock,
        re.MULTILINE,
    )
    if not match:
        raise SystemExit(f"{crate} is not in cli/Cargo.lock")
    return match.group(1)


def version_of(engine: Engine) -> str:
    """The upstream release to compare against, and the tag to fetch."""
    if engine.exact:
        version = pinned(engine.crate)
        for extra in engine.pins:
            pinned(extra)
        # The manifest and the lock disagreeing would mean the corpus came from
        # one release and the binary from another, which is the one failure
        # this whole script exists to be unable to have.
        got = resolved(engine.crate)
        if got != version:
            raise SystemExit(
                f"{engine.crate} is pinned as ={version} but Cargo.lock resolved {got}"
            )
        return version
    return resolved(engine.crate)


def upstream_cli(engine: Engine, version: str) -> list[str]:
    """The upstream binary at `version`, installed through mise but not activated."""
    spec = f"{engine.cli}@{version}"
    if run(["mise", "x", spec, "--", engine.cli, "--version"]).returncode != 0:
        print(f"  installing {spec}", flush=True)
        install = run(["mise", "install", spec])
        if install.returncode != 0:
            raise SystemExit(f"mise install {spec} failed:\n{install.stderr}")
    return ["mise", "x", spec, "--", engine.cli]


def clone_at(name: str, engine: Engine, version: str) -> Path:
    """The project's repository at `version`, with only its fixtures checked out.

    Sparse and blob-filtered: the fixtures are megabytes and the repositories
    they live in are gigabytes, and nothing here reads anything else.
    """
    clone = CACHE / f"{name}-{version}"
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
    return clone


def corpus(name: str, engine: Engine, version: str, copy: str = "corpus") -> Path:
    """The project's own fixtures at `version`, copied out of the clone."""
    clone = clone_at(name, engine, version)

    # Rebuilt every run rather than cached: it is a copy of files already on
    # disk, and a scratch tree that survives a change to `config` would answer
    # yesterday's question.
    out = CACHE / f"{name}-{version}-{copy}"
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


@dataclass(frozen=True)
class Case:
    """One upstream test case: an input file, and the bytes upstream expects back."""

    #: Path under the corpus. Keeps the project's own directories, so two cases
    #: with the same stem cannot collide, and keeps the suffix, which is how
    #: poly decides what language the file is.
    rel: str
    source: bytes
    expected: bytes
    #: A `poly.toml` to write beside the file, for a case the project runs at
    #: something other than the engine's defaults. Configs merge upward with
    #: the nearest winning, so one per case directory is how a corpus can hold
    #: cases that disagree about the line width.
    config: str = ""


def insta_body(text: str) -> str | None:
    """The snapshot itself, out of an insta `.snap` file.

    The file opens with a YAML header between two `---` lines -- what wrote it,
    and whatever metadata the harness did not turn off. Everything after the
    second one is the value that was asserted.
    """
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 3)
    if end < 0:
        return None
    return text[end + len("\n---\n") :]


def gplane_cases(root: Path, engine: Engine) -> tuple[list[Case], Counter]:
    """g-plane's snapshot fixtures: `<name>.<ext>` in, `<name>.snap` out.

    All four projects share one harness (`tests/fmt.rs` in each repository): it
    formats every matched file at `FormatOptions::default()` and writes the
    result beside it. poly reaches that same default -- `format_css`,
    `format_yaml`, `format_markup` and `format_graphql` each start from
    `FormatOptions::default()` and override only what `[format.<lang>]` or
    .editorconfig set -- so with no config anywhere, the snapshot is what poly
    should produce, byte for byte.

    Where a case wants a *non*-default option the harness says so, and then the
    snapshot is named `<name>.<variant>.snap` instead: a `config.toml` beside
    the file (`config.json` for GraphQL), or, for malva, a leading
    `/*cfg ... */` comment inside it. poly reaches none of those options --
    `[format.<lang>]` is three keys, deliberately, and the rest belong to the
    engine. So a case with a config is not a disagreement to report; it is a
    question poly cannot be asked. Counted and named rather than silently
    dropped: a loader that skipped them quietly would report a hundred
    comparisons and make ten.
    """
    cases: list[Case] = []
    skipped: Counter = Counter()
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix == ".snap":
            continue
        rel = str(path.relative_to(root)).replace(os.sep, "/")
        if path.name in ("config.toml", "config.json"):
            continue
        if path.suffix not in engine.suffixes:
            # A language the project formats and poly does not: malva's `.sass`
            # (the indented syntax), markup_fmt's `.njk` and `.vto`. poly would
            # not open the file at all, so there is nothing to compare.
            skipped[f"not a poly language ({path.suffix})"] += 1
            continue
        source = path.read_bytes()
        if (path.parent / "config.toml").exists() or (
            path.parent / "config.json"
        ).exists():
            skipped["case sets engine-specific options"] += 1
            continue
        if source.lstrip().startswith(b"/*cfg"):
            skipped["case sets engine-specific options"] += 1
            continue
        snap = path.with_suffix(".snap")
        if not snap.exists():
            # Every input is supposed to have one. If this ever fires, the
            # harness changed shape and the loader is reading the wrong tree.
            skipped["no snapshot beside the input"] += 1
            continue
        body = insta_body(snap.read_text(encoding="utf-8"))
        if body is None:
            skipped["snapshot has no insta header"] += 1
            continue
        cases.append(Case(rel, source, body.encode("utf-8")))
    return cases, skipped


#: `test_case!(name)` or `test_case!(name, PHPVersion::PHP83)` in mago's own
#: harness. The second form pins a case to a PHP the rest of the suite is not
#: run at, and it is the difference between `(new Foo())->bar()` and PHP 8.4's
#: `new Foo()->bar()`.
MAGO_CASE = re.compile(
    r"test_case!\(\s*(\w+)\s*(?:,\s*PHPVersion::(\w+)\s*)?[,)]", re.MULTILINE
)
#: The default the harness's own macro applies, read out of its definition
#: rather than assumed. See `mago_versions`.
MAGO_DEFAULT = re.compile(r"test_case!\(\$name,\s*PHPVersion::(\w+)\)")


def mago_versions(root: Path) -> tuple[str, dict[str, str]]:
    """Which PHP each of mago's formatter cases is run at.

    The expected output of a case is only the right answer at the version the
    harness ran it at: `php83_instantiation_with_member_access_parentheses`
    keeps the parentheses that PHP 8.4 lets you drop, and poly -- which formats
    at `PHPVersion::LATEST`, deliberately (see `php_version` in
    poly-engines/src/lint.rs) -- drops them. Comparing against it would be
    reading mago's changelog, not poly.

    The default is read out of the macro rather than written down here, so an
    upstream that moves it fails loudly instead of quietly comparing every case
    against a version neither side ran.
    """
    default = ""
    versions: dict[str, str] = {}
    for source in sorted(root.glob("*.rs")):
        text = source.read_text(encoding="utf-8")
        found = MAGO_DEFAULT.search(text)
        if found:
            default = found.group(1)
        for name, version in MAGO_CASE.findall(text):
            if version:
                versions[name] = version
    if not default:
        raise SystemExit(
            "mago's test_case! macro no longer names a default PHPVersion; "
            "the loader in tools/engine-diff.py is reading the wrong harness"
        )
    return default, versions


def mago_cases(root: Path, engine: Engine) -> tuple[list[Case], Counter]:
    """mago's formatter cases: a directory per case, `before.php` -> `after.php`.

    The third file in each directory is `settings.inc`, a Rust expression the
    project's harness pastes into its test: `FormatSettings::default()` for most
    of them, a struct literal with a field or two changed for the rest. poly
    formats PHP at mago's defaults and exposes none of those fields -- its three
    knobs are already mago's three, and the comment in `format_php` says so --
    so a case with a non-default literal is a question poly cannot be asked.

    Matching on the literal text rather than parsing it: the only value that
    matters is the exact default, anything else is skipped, and a parser for
    Rust struct-update syntax would be a way to get that wrong.
    """
    default, versions = mago_versions(root)
    cases: list[Case] = []
    skipped: Counter = Counter()
    for settings in sorted((root / "cases").rglob("settings.inc")):
        case = settings.parent
        if case.name.startswith("-"):
            # `-template` is the file the project copies to start a new case.
            continue
        before, after = case / "before.php", case / "after.php"
        if not before.exists() or not after.exists():
            skipped["case is missing before.php or after.php"] += 1
            continue
        if settings.read_text(encoding="utf-8").strip() != "FormatSettings::default()":
            skipped["case sets engine-specific options"] += 1
            continue
        if versions.get(case.name, default) != default:
            skipped[f"case pins a PHP version of its own (not {default})"] += 1
            continue
        # Named for the case, so `poly fmt` sees one PHP file per directory and
        # never the expected output as an input of its own.
        cases.append(
            Case(f"{case.name}/before.php", before.read_bytes(), after.read_bytes())
        )
    return cases, skipped


#: `default_file_name: "file.md"` in a dprint plugin's spec runner. Read out of
#: the harness rather than written down per engine: it is what decides the
#: language of every spec that does not name a path of its own, and a plugin
#: that changed it would otherwise have poly formatting the wrong language
#: against the right expectations.
DPRINT_DEFAULT = re.compile(r'default_file_name:\s*"([^"]+)"')


#: dprint's name for each of poly's three knobs. Everything else a spec can set
#: -- `quoteStyle`, `arrowFunction.useParentheses`, `textWrap` -- is the
#: engine's own, and `[format.<lang>]` is deliberately only these three.
POLY_KNOBS = {
    "lineWidth": "line-width",
    "indentWidth": "indent-width",
    "useTabs": "use-tabs",
}


def spec_config(text: str, engine: Engine) -> str | None:
    """A spec's `~~ ~~` block as a poly.toml, or None if poly cannot say it.

    Read the way `parse_config` reads it: newlines removed, then either a JSON
    object or `key: value` pairs separated by commas.

    Most of the value here is in the specs this *lets* through. Upstream sets a
    narrow `lineWidth` to make a case break somewhere visible, and before this
    every one of those was skipped -- 2,068 of dprint-plugin-typescript's 2,379
    cases, which left the comparison running on the 13% that happened to want
    no configuration.
    """
    text = text.replace("\n", "").strip()
    if text.startswith("{"):
        try:
            got = json.loads(text)
        except ValueError:
            return None
    else:
        got = {}
        for item in text.split(","):
            if ":" not in item:
                return None
            key, _, value = item.partition(":")
            got[key.strip()] = value.strip()
    lines = []
    for key, value in got.items():
        knob = POLY_KNOBS.get(key)
        # `knobs` rather than all three: poly *fails the run* on a knob the
        # engine does not have -- markdown has no indent width -- so writing
        # one would turn the comparison into a corpus-wide error.
        if knob is None or knob not in engine.knobs:
            return None
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif (
            isinstance(value, str)
            # All three knobs take a number or a bool. Anything else is a key
            # poly does not have under a name it does happen to share.
            and value not in ("true", "false")
            and not value.lstrip("-").isdigit()
        ):
            return None
        lines.append(f"{knob} = {value}")
    if not lines:
        return ""
    return f"[format.{engine.language}]\n" + "\n".join(lines) + "\n"


def dprint_cases(root: Path, engine: Engine) -> tuple[list[Case], Counter]:
    """dprint's spec files: input and expected output in one `.txt`.

    The format is dprint-development's, and this reads it the way
    `parse_specs` does:

        --                        (optional) the file path the case is for,
        path/to/file.tsx          which is what decides the language;
        --                        otherwise the runner's default_file_name
        ~~ lineWidth: 40 ~~       (optional) config for every case in the file
        == what this is about ==
        the input
        [expect]
        what the plugin prints

    Two kinds of case are left out, and the counts say which. A file with a
    `~~ ~~` block is asking for configuration that `[format.<lang>]`'s three
    keys cannot express -- and, unlike the g-plane fixtures, the block covers
    every case in the file, so one config line removes all of them at once.
    `(skip)` and `(trace)` are the project's own markers for a case its runner
    does not format.
    """
    default = ""
    for source in sorted(root.glob("*.rs")):
        found = DPRINT_DEFAULT.search(source.read_text(encoding="utf-8"))
        if found:
            default = found.group(1)
    if not default:
        raise SystemExit(
            f"no default_file_name in {engine.repo}'s spec runner; "
            "the loader in tools/engine-diff.py is reading the wrong harness"
        )

    cases: list[Case] = []
    skipped: Counter = Counter()
    for spec in sorted((root / "specs").rglob("*.txt")):
        text = spec.read_text(encoding="utf-8").replace("\r\n", "\n")
        name = default
        if text.startswith("--"):
            end = text.index("--\n", len("--"))
            name = text[len("--") : end].strip()
            text = text[end + len("--\n") :]
        # `!!` for Markdown, because `==` under a line of text is a setext
        # heading and a Markdown spec has to be able to contain one.
        separator = "!!" if name.endswith(".md") else "=="
        config = ""
        if text.startswith("~~"):
            end = text.index("~~\n", len("~~"))
            config = spec_config(text[len("~~") : end], engine)
            text = text[end + len("~~\n") :]
            if config is None:
                # Counted per case rather than per file: the block configures
                # every case below it, and one line at the top of a spec can
                # remove twenty comparisons. The number is what says how much
                # of the corpus this is costing.
                skipped["spec sets engine-specific options"] += sum(
                    1 for line in text.split("\n") if line.startswith(separator)
                )
                continue
        suffix = Path(name).suffix or Path(name).name
        if suffix not in engine.suffixes:
            skipped[f"not a poly language ({suffix})"] += 1
            continue

        lines = text.split("\n")
        starts = [i for i, line in enumerate(lines) if line.startswith(separator)]
        stem = str(spec.relative_to(root / "specs")).replace(os.sep, "/")[
            : -len(".txt")
        ]
        for n, start in enumerate(starts):
            end = starts[n + 1] if n + 1 < len(starts) else len(lines)
            message = lines[start].lower()
            if "(skip)" in message or "(trace)" in message:
                skipped["case is marked (skip) or (trace) upstream"] += 1
                continue
            body = "\n".join(lines[start + 1 : end])
            if "[expect]" not in body:
                skipped["case has no [expect] section"] += 1
                continue
            before, after = body.split("[expect]", 1)
            # A directory per case, holding the file under the *name* the spec
            # gave it. Not the extension alone: `Cargo.toml` is a name both
            # dprint-plugin-toml and poly treat differently from any other TOML
            # -- dependency sorting, the `[package]` key order -- so a case
            # written `0.toml` would compare poly's plain TOML against
            # upstream's Cargo one and call every line of it a difference.
            cases.append(
                Case(
                    f"{stem}/{n}/{Path(name).name}",
                    before[: -len("\n")].encode("utf-8"),
                    after[len("\n") :].encode("utf-8"),
                    config,
                )
            )
    return cases, skipped


LOADERS = {
    "g-plane": gplane_cases,
    "mago": mago_cases,
    "dprint": dprint_cases,
}


def fixture_differences(
    engine: Engine, name: str, version: str, poly: str
) -> tuple[int, Counter, dict[str, str], Counter]:
    """Format the project's own inputs with poly; compare against its snapshots.

    One `poly fmt` over the whole tree rather than a run per file: that is the
    invocation a user makes, and a few thousand processes would take minutes to
    answer the same question.
    """
    root = clone_at(name, engine, version) / engine.fixtures
    cases, skipped = LOADERS[engine.layout](root, engine)

    tree = CACHE / f"{name}-{version}-cases"
    shutil.rmtree(tree, ignore_errors=True)
    for case in cases:
        out = tree / case.rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(case.source)
        if case.config:
            (out.parent / "poly.toml").write_text(case.config, encoding="utf-8")
    if engine.config is not None:
        # The scratch tree is under /tmp with nothing above it, so this is the
        # only configuration either side sees. It exists for the one thing that
        # is a product decision rather than a difference in how poly drives the
        # engine: where poly's default for a language is deliberately not the
        # engine's, comparing at poly's would report the decision, once per
        # indented line, and bury everything else.
        (tree / engine.config[0]).write_text(engine.config[1], encoding="utf-8")
    # Only the inputs are written, never the snapshots: `poly fmt` formats
    # every file it recognises, and a `.snap` full of YAML-looking header is a
    # file it would have opinions about.
    run([poly, "fmt", "."], cwd=tree)

    classify = CLASSES[name]
    differences: Counter = Counter()
    examples: dict[str, str] = {}
    for case in cases:
        mine = (tree / case.rel).read_bytes()
        if mine == case.expected:
            continue
        kind = classify(tree, case.rel, mine, case.expected)
        differences[kind] += 1
        examples.setdefault(kind, case.rel)
    return len(cases), differences, examples, skipped


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


def directory_class(root: Path, rel: str, mine: bytes, theirs: bytes) -> str:
    """Keyed by the directory the project filed the case under.

    That directory is what the case is *about* -- `css/at-rule`, `yaml/block-folded`
    -- so a difference carries the name of the construct it is about rather than
    the language, which would merge every case in the project into one number.

    Trailing newlines get their own key ahead of that. insta stores a snapshot
    with exactly one, and a formatter that emitted two would otherwise be
    reported once per directory and look like several unrelated defects.
    """
    if mine.rstrip(b"\n") == theirs.rstrip(b"\n"):
        return "trailing-newline"
    parts = rel.split("/")
    return "/".join(parts[:2]) if len(parts) > 2 else parts[0]


#: A `<script>` or `<style>` block.
EMBEDDED_TAG = re.compile(rb"<(script|style)[\s>]", re.IGNORECASE)
#: An expression markup_fmt hands to the same callback as a whole block: an
#: interpolation, a framework directive, or an inline `style` attribute.
#
#: The braced form spans lines on purpose: a Svelte or Astro expression is
#: often the whole file, and `[^{}]` rather than `.` keeps it from swallowing a
#: document where two separate braces happen to appear.
EMBEDDED_EXPR = re.compile(
    rb"\{\{|\{[^{}]+\}|style\s*=|\s(?::|@|v-|x-|bind:|on:|client:)[\w.:-]+\s*=",
    re.IGNORECASE,
)


def markup_class(root: Path, rel: str, mine: bytes, theirs: bytes) -> str:
    """markup_fmt's cases, and the one difference poly is supposed to have.

    markup_fmt formats markup and nothing else. Every embedded language -- a
    `<script>` or `<style>` block, an Astro front-matter fence, a Vue
    interpolation, a `style` attribute -- it hands back to its caller and asks
    what to do with it. Its own harness answers `|code, _| Ok(code.into())`:
    leave it exactly as it was, because the project is testing its markup
    printer and not somebody else's JavaScript. poly answers by formatting the
    block with the engine for that language, which is the whole point of a
    formatter that covers the file rather than the tag soup in it. So those
    cases are measuring poly's dispatch against a deliberate no-op.

    The three embedded keys are separate because they reach three different
    engines of poly's -- dprint-plugin-typescript, malva, and whatever the
    front-matter turns out to be -- and a regression in one should not be able
    to hide inside another's declared count.

    Anything else falls through to the directory it sits in, deliberately: a
    difference in the markup itself is the thing this comparison exists to
    find, and it must not land in a bucket that has a reason on record. That is
    how `angular-template` below stayed visible.
    """
    if rel.endswith(".component.html"):
        # markup_fmt's `detect_language` reads `*.component.html` as Angular,
        # and Angular's `@if` / `@for` / `@switch` blocks are markup to it.
        # poly's language table has no `angular`, so `format_markup` falls to
        # `Language::Html` and those blocks are text. Not a declared
        # difference: a real gap, and the only one this engine's fixtures
        # found.
        return "angular-template"
    if rel.endswith(".astro") and theirs.lstrip().startswith(b"---"):
        return "embedded-front-matter"
    if EMBEDDED_TAG.search(theirs) or EMBEDDED_TAG.search(mine):
        return "embedded-script-style"
    if EMBEDDED_EXPR.search(theirs) or EMBEDDED_EXPR.search(mine):
        return "embedded-expression"
    return directory_class(root, rel, mine, theirs)


def mago_class(root: Path, rel: str, mine: bytes, theirs: bytes) -> str:
    """Keyed by the case's own directory name, which is what mago named it for.

    `adds_empty_line_after_use`, `align_array_like` -- the project files one
    case per behaviour and names the directory after it, so the key is already
    the sentence describing what differs.

    Two keys come first, because both are about the file rather than about PHP,
    and each would otherwise be reported under whichever case happened to carry
    it.
    """
    if mine.replace(b"\r\n", b"\n").replace(b"\r", b"\n") == theirs.replace(
        b"\r\n", b"\n"
    ).replace(b"\r", b"\n"):
        return "line-endings"
    try:
        theirs.decode("utf-8")
    except UnicodeDecodeError:
        return "not-utf8"
    return rel.split("/")[0]


#: A fenced code block with a language on it, which is the only thing
#: dprint-plugin-markdown hands to its caller.
CODE_FENCE = re.compile(rb"^ *(```|~~~)\w", re.MULTILINE)


def markdown_class(root: Path, rel: str, mine: bytes, theirs: bytes) -> str:
    """dprint-plugin-markdown's cases, and what a code block is for each side.

    Same shape as `markup_class`: the plugin formats Markdown and hands each
    fenced block to its caller. Upstream's runner answers with a stub that
    appends `_formatted_<width>` to anything tagged `format` and returns None
    for every other language -- so a ```ts block comes back untouched, and a
    ```format block comes back with a word no formatter would ever write. poly
    answers by formatting the block with the engine for that language.

    Both directions therefore show up here, and they are separate keys because
    they are opposite failures: one is poly doing more than the fixture, the
    other is the fixture doing something poly cannot.
    """
    if b"```format" in theirs:
        return "fake-format-language"
    if CODE_FENCE.search(theirs):
        return "embedded-code-block"
    return directory_class(root, rel, mine, theirs)


CLASSES = {
    "ruff-format": ruff_format_class,
    "stylua": stylua_class,
    "malva": directory_class,
    "pretty_yaml": directory_class,
    "pretty_graphql": directory_class,
    "markup_fmt": markup_class,
    "mago": mago_class,
    "dprint-typescript": directory_class,
    "dprint-json": directory_class,
    "dprint-markdown": markdown_class,
    "dprint-toml": directory_class,
    "dprint-dockerfile": directory_class,
}


def format_differences(
    engine: Engine, name: str, cli: list[str], version: str, poly: str
) -> tuple[int, Counter, dict[str, str]]:
    """Format one copy of the corpus with each side; classify what differs.

    Two copies rather than one and a `--diff` flag: `poly fmt` writes, and the
    question is what a user's tree looks like afterwards. A flag that prints a
    diff is a different code path in both tools.
    """
    mine_dir = corpus(name, engine, version, "poly")
    theirs_dir = corpus(name, engine, version, "upstream")
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
    version = version_of(engine)
    origin = "pinned as" if engine.exact else "resolved by cli/Cargo.lock for"
    print(f"{name} {version} ({origin} {engine.crate})")

    if engine.mode == "fixture":
        total, by_rule, examples, skipped = fixture_differences(
            engine, name, version, poly
        )
        print(f"  {total} cases from {engine.repo}, {sum(by_rule.values())} differ")
        for reason, count in skipped.most_common():
            print(f"  skipped {count}: {reason}")
        only_theirs = only_mine = Counter()
        return report(name, engine, by_rule, examples, only_theirs, only_mine)

    cli = upstream_cli(engine, version)
    if engine.mode == "format":
        total, by_rule, examples = format_differences(engine, name, cli, version, poly)
        print(f"  {total} fixtures, {sum(by_rule.values())} formatted differently")
        only_theirs = only_mine = Counter()
    else:
        where = corpus(name, engine, version)
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

    return report(name, engine, by_rule, examples, only_theirs, only_mine)


def report(
    name: str,
    engine: Engine,
    by_rule: Counter,
    examples: dict[str, str],
    only_theirs: Counter,
    only_mine: Counter,
) -> int:
    """Print what differs, and count what has no reason on record."""
    failed = 0
    declared = set()
    for rule, count in by_rule.most_common():
        reason = EXPECTED.get((name, rule))
        if reason:
            declared.add(rule)
            print(f"  note {rule}: {count} differ on purpose -- {reason}")
            continue
        failed += 1
        if engine.mode in ("format", "fixture"):
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

#!/usr/bin/env python3
"""Differential: formatting through `poly lsp` against formatting through `poly fmt`.

poly-lsp's central promise is that there is no editor answer and CI answer,
only one answer (A4). `poly fmt` and the daemon are supposed to be the same
code reached two ways -- but they are reached differently enough that "same
code" is a claim rather than a fact:

* the CLI reads bytes off disk; the daemon is handed a buffer by the client,
  already decoded, and hands back a list of `TextEdit`s rather than a file
* the CLI knows a file's language from its path; the daemon is told a
  `languageId` by the editor and may be given a path that does not exist
* the daemon caches -- config, resolved tools, engine state -- across requests,
  and the CLI is a fresh process every time

Each of those is a place the two can drift without any test noticing, because
every other test in this repo asks only one of them. `make smoke` drives the
daemon and asserts the answer looks right; `poly fmt` is covered by its own
tests. Nothing until this asked both the same question about the same file.

Unlike the other differentials here there is no upstream to download and no
declared-difference table, because there is no legitimate difference to
declare: a file the two format differently is a defect, full stop.

Usage: python3 tools/lsp-fmt-diff.py <poly-binary> [corpus-dir ...]

With no corpus the repo itself is used, which is a real mixed-language tree and
needs no network. The engine-diff corpora are used too when they are already on
disk, because they are 2,000 more files in two languages poly formats.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: What LSP counts as the end of a line, and nothing else. See `apply_edits`.
LINE_BREAK = re.compile(r"\r\n|\r|\n")

# What the editor would say a file is. Not poly's own table: the point is to
# hand the daemon what a client hands it, and a client names the language from
# its own list. Anything absent here is a file VSCode would not have opened
# with a poly language id, so the daemon would never be asked about it.
LANGUAGES = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".jsonc": "jsonc",
    ".md": "markdown",
    ".toml": "toml",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".py": "python",
    ".pyi": "python",
    ".ipynb": "jupyter",
    ".sql": "sql",
    ".xml": "xml",
    ".html": "html",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".lua": "lua",
    ".php": "php",
    ".sh": "shellscript",
    ".bash": "shellscript",
}


class Daemon:
    """`poly lsp` over stdio, enough of the protocol to format a document."""

    def __init__(self, binary: str, root: Path):
        # The daemon logs a line per request to stderr; over a corpus this size
        # that is megabytes of noise around the few lines that matter.
        self.proc = subprocess.Popen(
            [binary, "lsp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.next_id = 0
        self.request(
            "initialize",
            {"processId": None, "rootUri": root.as_uri(), "capabilities": {}},
        )
        self.notify("initialized", {})

    def send(self, msg: dict) -> None:
        data = json.dumps(msg).encode()
        self.proc.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
        self.proc.stdin.flush()

    def notify(self, method: str, params: dict) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: dict):
        self.next_id += 1
        want = self.next_id
        self.send({"jsonrpc": "2.0", "id": want, "method": method, "params": params})
        while True:
            msg = self.recv()
            # Diagnostics and progress arrive unbidden between request and
            # response; only the id matters here.
            if msg.get("id") == want:
                return msg.get("result")

    def recv(self) -> dict:
        length = 0
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise SystemExit("poly lsp closed the connection")
            if line in (b"\r\n", b"\n"):
                break
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":")[1])
        return json.loads(self.proc.stdout.read(length))

    def format(self, path: Path, language: str, text: str) -> str:
        """The document as the daemon would leave it."""
        uri = path.as_uri()
        self.notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": uri,
                    "languageId": language,
                    "version": 1,
                    "text": text,
                }
            },
        )
        edits = self.request(
            "textDocument/formatting",
            # tabSize/insertSpaces are what an editor sends from its own
            # settings. poly's config and .editorconfig outrank them, which is
            # the behaviour under test: the CLI has no such client to ask.
            {
                "textDocument": {"uri": uri},
                "options": {"tabSize": 4, "insertSpaces": True},
            },
        )
        self.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
        return apply_edits(text, edits or [])

    def close(self) -> None:
        self.request("shutdown", {})
        self.notify("exit", {})
        self.proc.wait(timeout=30)


def apply_edits(text: str, edits: list[dict]) -> str:
    """Apply LSP `TextEdit`s the way a client does: right to left.

    Positions are line/UTF-16-offset into the *original* document, so applying
    left to right would invalidate every later range. Real clients sort and
    apply in reverse, and getting this wrong here would show up as poly's
    defect rather than the harness's.
    """
    # Not `str.splitlines`: that also breaks on form feed, vertical tab and
    # U+2028, none of which start a new line as far as LSP or any editor is
    # concerned. Python source with a form feed in it is not hypothetical --
    # ruff ships fixtures for exactly that, and using splitlines here made
    # poly look like it duplicated a line.
    starts = [0] + [m.end() for m in LINE_BREAK.finditer(text)]

    def offset(pos: dict) -> int:
        line = pos["line"]
        if line >= len(starts):
            return len(text)
        end = starts[line + 1] if line + 1 < len(starts) else len(text)
        # UTF-16 code units, not characters: a client counts them that way and
        # so does poly. Only matters past the BMP, which fixtures do contain.
        utf16, count = 0, pos["character"]
        for i in range(starts[line], end):
            if utf16 >= count:
                return i
            utf16 += 2 if ord(text[i]) > 0xFFFF else 1
        return end

    out = text
    for edit in sorted(
        edits,
        key=lambda e: (e["range"]["start"]["line"], e["range"]["start"]["character"]),
        reverse=True,
    ):
        out = (
            out[: offset(edit["range"]["start"])]
            + edit["newText"]
            + out[offset(edit["range"]["end"]) :]
        )
    return out


def corpora(given: list[str]) -> list[Path]:
    if given:
        return [Path(one).resolve() for one in given]
    found = [ROOT]
    # Whatever engine-diff has already fetched, for free: 1,725 Python files
    # and 416 Lua ones that nothing else here formats.
    cache = Path(tempfile.gettempdir()) / "poly-engine-diff"
    if cache.is_dir():
        found += sorted(
            p for p in cache.iterdir() if p.is_dir() and p.name.endswith("-corpus")
        )
    return found


# Build output and local tool state, not documents. Shared by the walk and the
# copy so the two cannot drift into disagreeing about what the corpus is.
SKIP = (
    ".git",
    ".codegraph",
    ".vscode-test",
    "node_modules",
    "target",
    "out",
    "dist",
    "__pycache__",
)


def walk(where: Path) -> list[Path]:
    """The files poly would format, which is not every file on disk.

    `poly fmt` honours .gitignore. Walking the tree directly instead finds
    build output and scratch directories that the CLI skips and the daemon
    would happily format if an editor opened one -- so every such file reads as
    a disagreement. Measured on this repo: 13,620 of them, none real.
    """
    tracked = run_git(where)
    if tracked is not None:
        return sorted(p for p in tracked if p.suffix in LANGUAGES and p.is_file())
    files = []
    for path in where.rglob("*"):
        if not path.is_file() or path.suffix not in LANGUAGES:
            continue
        if set(SKIP) & set(path.relative_to(where).parts):
            continue
        files.append(path)
    return sorted(files)


def run_git(where: Path) -> list[Path] | None:
    """Everything git tracks under `where`, or None when it is not a repository."""
    if not (where / ".git").exists():
        return None
    got = subprocess.run(
        ["git", "-C", str(where), "ls-files", "-z"],
        capture_output=True,
        check=False,
    )
    if got.returncode != 0:
        return None
    return [where / name.decode() for name in got.stdout.split(b"\0") if name]


def copy_document(src: str, dst: str) -> None:
    """`shutil.copy2` for anything a document could be, and a no-op otherwise.

    A socket or a fifo somewhere in the tree -- a running daemon leaves one --
    makes plain `copytree` abort the whole copy rather than skip the one file.
    """
    if stat.S_ISSOCK(os.lstat(src).st_mode) or stat.S_ISFIFO(os.lstat(src).st_mode):
        return
    shutil.copy2(src, dst)


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: python3 tools/lsp-fmt-diff.py <poly-binary> [corpus-dir ...]",
            file=sys.stderr,
        )
        return 2
    poly = str(Path(sys.argv[1]).resolve())

    failed = 0
    for where in corpora(sys.argv[2:]):
        files = walk(where)
        if not files:
            continue
        # A copy, because `poly fmt` writes: the corpus itself is either this
        # repo or somebody else's fixtures.
        scratch = Path(tempfile.mkdtemp(prefix="poly-lsp-fmt-"))
        try:
            tree = scratch / where.name
            shutil.copytree(
                where,
                tree,
                symlinks=True,
                copy_function=copy_document,
                ignore=shutil.ignore_patterns(*SKIP),
            )
            subprocess.run(
                [poly, "fmt", "."], cwd=tree, capture_output=True, check=False
            )

            daemon = Daemon(poly, tree)
            checked = differing = unreadable = 0
            try:
                for original in files:
                    rel = original.relative_to(where)
                    copy = tree / rel
                    if not copy.exists():
                        continue
                    try:
                        before = original.read_text(encoding="utf-8")
                        after_cli = copy.read_text(encoding="utf-8")
                    except UnicodeDecodeError:
                        # Not a document any editor would have open either.
                        unreadable += 1
                        continue
                    checked += 1
                    after_lsp = daemon.format(copy, LANGUAGES[original.suffix], before)
                    if after_lsp == after_cli:
                        continue
                    differing += 1
                    failed += 1
                    if differing <= 5:
                        print(f"  FAIL {rel}: the daemon and `poly fmt` disagree")
                        for line in sample(after_cli, after_lsp):
                            print(f"         {line}")
            finally:
                daemon.close()
            note = f", {unreadable} not UTF-8" if unreadable else ""
            print(f"{where}: {checked} files{note}, {differing} formatted differently")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    print()
    if failed:
        print(f"{failed} file(s) where the editor and the CLI disagree")
        return 1
    print("the daemon and `poly fmt` agree on every file")
    return 0


def sample(cli: str, lsp: str) -> list[str]:
    """The first line the two differ on, both sides, for the failure message."""
    left, right = LINE_BREAK.split(cli), LINE_BREAK.split(lsp)
    for i in range(max(len(left), len(right))):
        one = left[i] if i < len(left) else "<end of file>"
        two = right[i] if i < len(right) else "<end of file>"
        if one != two:
            return [f"line {i + 1} cli {one!r}", f"line {i + 1} lsp {two!r}"]
    return ["identical line by line, so the difference is the trailing newline"]


if __name__ == "__main__":
    sys.exit(main())

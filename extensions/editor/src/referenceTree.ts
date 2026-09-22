import * as vscode from "vscode";

import { enclosing, rowPrefix, TreeSymbol } from "./referenceRows";

/** A file with hits in it, or one hit. */
type Node =
  | { kind: "file"; uri: vscode.Uri; rows: Row[] }
  | { kind: "row"; uri: vscode.Uri; row: Row };

interface Row {
  readonly range: vscode.Range;
  /** The line's own source, trimmed -- what the built-in tree shows. */
  readonly text: string;
  /** `func handle`, `var config`, or empty for a hit inside nothing. */
  readonly kind: string;
  /** 1-based, as printed. */
  readonly number: string;
}

/**
 * How many files' outlines are fetched to label the rows.
 *
 * A symbol query per file, and a reference search over a monorepo can return
 * hits in hundreds. The rows beyond the cap still appear with their line
 * numbers -- what they lose is the kind column, which is the part that costs a
 * round trip to a language server.
 */
const MAX_OUTLINES = 60;

/**
 * poly's own references tree.
 *
 * It exists because `references-view` is a different extension and a
 * `TreeDataProvider` owns its rows: there is no contribution point for "add a
 * column to that tree". What this adds is the line number and the enclosing
 * symbol, which is the whole reason to have a second one -- everything else
 * here is the built-in tree's behaviour reimplemented to keep it.
 *
 * Nothing is computed until a lens is clicked. The view holds one result set at
 * a time, the way the built-in one does, because a reference search is a
 * question asked about a cursor and keeping the last five answers around would
 * mean five stale ones.
 */
export class ReferenceTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private files: { uri: vscode.Uri; rows: Row[] }[] = [];

  /** What the view's title should say it is showing. */
  summary = "";

  async show(what: string, locations: readonly vscode.Location[]): Promise<void> {
    const byFile = new Map<string, vscode.Location[]>();
    for (const location of locations) {
      const key = location.uri.toString();
      byFile.set(key, [...(byFile.get(key) ?? []), location]);
    }

    const files: { uri: vscode.Uri; rows: Row[] }[] = [];
    let outlines = 0;
    for (const [key, hits] of byFile) {
      const uri = vscode.Uri.parse(key);
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        // Deleted or unreadable between the search and now. One file missing is
        // not a reason to show none of the others.
        continue;
      }
      const symbols = outlines++ < MAX_OUTLINES ? await outlineOf(uri) : [];
      const rows = hits
        .map((hit) => {
          const { number, kind } = rowPrefix(
            hit.range.start.line,
            enclosing(symbols, hit.range.start.line),
          );
          return {
            range: hit.range,
            text: document.lineAt(hit.range.start.line).text.trim(),
            kind,
            number,
          };
        })
        .sort((a, b) => a.range.start.line - b.range.start.line);
      files.push({ uri, rows });
    }
    files.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));

    this.files = files;
    const hits = files.reduce((n, file) => n + file.rows.length, 0);
    this.summary = `${what} — ${hits} in ${files.length} file${files.length === 1 ? "" : "s"}`;
    // The view is hidden until there is something in it. An always-present
    // "References" panel sitting empty in the Explorer is a row of chrome for a
    // feature most sessions never use, and the reference lens is off by default
    // -- so for most people the view would never fill in at all.
    await vscode.commands.executeCommand("setContext", "poly.hasReferences", true);
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.files.map((file) => ({ kind: "file", ...file }));
    }
    return node.kind === "file"
      ? node.rows.map((row) => ({ kind: "row", uri: node.uri, row }))
      : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "file") {
      const item = new vscode.TreeItem(
        vscode.workspace.asRelativePath(node.uri),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = `${node.rows.length}`;
      item.resourceUri = node.uri;
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }
    const { row } = node;
    // The line number leads, because it is what the eye scans down and what a
    // `path:line` reference needs. The code is the label rather than the
    // description so that the tree's own filter box searches it.
    const item = new vscode.TreeItem(
      `${row.number}  ${row.text}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = row.kind;
    item.tooltip = row.kind
      ? `${vscode.workspace.asRelativePath(node.uri)}:${row.number} — in ${row.kind}`
      : `${vscode.workspace.asRelativePath(node.uri)}:${row.number}`;
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [
        node.uri,
        { selection: row.range } satisfies vscode.TextDocumentShowOptions,
      ],
    };
    return item;
  }
}

/**
 * A file's outline, or nothing.
 *
 * Nothing is the answer for every language with no symbol provider installed,
 * which is most of them in most windows -- so it is a row without a kind
 * column, not an error and not an empty tree.
 */
async function outlineOf(uri: vscode.Uri): Promise<TreeSymbol[]> {
  let symbols: vscode.DocumentSymbol[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri,
    );
  } catch {
    return [];
  }
  // No shape check, and that is measured rather than assumed. A provider may
  // answer in either of the two symbol shapes -- bash-language-server sends the
  // flat `SymbolInformation`, gopls the nested `DocumentSymbol` --  but
  // `executeDocumentSymbolProvider` normalises before handing anything back, so
  // both arrive carrying `range`. `tools/ref-lens-check` pins that with a
  // provider that really answers in the old shape; a conversion here would be a
  // branch nothing can reach.
  const convert = (level: readonly vscode.DocumentSymbol[]): TreeSymbol[] =>
    level.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      startLine: symbol.range.start.line,
      endLine: symbol.range.end.line,
      children: symbol.children && convert(symbol.children),
    }));
  return symbols ? convert(symbols) : [];
}

export function registerReferenceTree(
  context: vscode.ExtensionContext,
): ReferenceTree {
  const tree = new ReferenceTree();
  const view = vscode.window.createTreeView("polyReferences", {
    treeDataProvider: tree,
  });
  context.subscriptions.push(
    view,
    tree.onDidChangeTreeData(() => {
      view.description = tree.summary;
    }),
  );
  return tree;
}

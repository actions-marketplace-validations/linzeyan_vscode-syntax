import * as vscode from "vscode";

import { scheduleUpdateCheck } from "../../lsp/src/update";

// The only code this extension runs: the grammars are declarations VSCode reads
// without activating anything. The update check is here so that someone with
// the grammars alone still hears about a release, on a schedule of their own
// (`poly.syntax.updateCheck.*`), and it is Poly's own check -- one file, so the
// two cannot disagree about what a release is or how to install one.
let log: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  scheduleUpdateCheck(context, "poly.syntax", (line) => {
    // Created on first use: a check that succeeds says nothing, and an empty
    // channel is one more entry in the Output list for nothing.
    if (!log) {
      log = vscode.window.createOutputChannel("Poly Syntax Highlight");
      context.subscriptions.push(log);
    }
    log.appendLine(line);
  });
}

import * as vscode from "vscode";

/**
 * Whether `what` may start a program: false in Restricted Mode, after saying so.
 *
 * Each caller runs something the folder can choose or steer -- its scripts,
 * its git config, the browser a markdown file's HTML runs in -- which is what
 * an untrusted folder must not get. Asked where the program starts rather than
 * declared as `enablement` on the commands: that covers menus and keys only,
 * and a lens or a webview runs a command by its id.
 */
export function mayRun(what: string): boolean {
  if (vscode.workspace.isTrusted) {
    return true;
  }
  const manage = "Manage Workspace Trust";
  void vscode.window
    .showWarningMessage(`Poly: ${what} runs programs, so it waits until this folder is trusted.`, manage)
    .then((pick) => pick === manage && vscode.commands.executeCommand("workbench.trust.manage"));
  return false;
}

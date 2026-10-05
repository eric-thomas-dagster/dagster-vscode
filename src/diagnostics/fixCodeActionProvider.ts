import * as vscode from 'vscode';

/** Diagnostic `.source` values this Quick Fix applies to -- both
 * dgCheckDiagnostics.ts and assetRefDiagnostics.ts tag their own
 * diagnostics with one of these. */
const FIXABLE_SOURCES = new Set(['dg check', 'dagster-asset-refs']);

export class DagsterFixCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    codeActionContext: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    return codeActionContext.diagnostics
      .filter((d) => FIXABLE_SOURCES.has(d.source ?? ''))
      .map((diagnostic) => {
        const action = new vscode.CodeAction('Ask Dagster Expert to fix this', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.command = {
          command: 'dagsterPowerUser.fixDiagnosticWithAi',
          title: 'Ask Dagster Expert to fix this',
          arguments: [document.uri, diagnostic],
        };
        return action;
      });
  }
}

export function registerFixCodeActionProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(['python', 'yaml'], new DagsterFixCodeActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    })
  );
}

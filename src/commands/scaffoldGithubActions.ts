import * as vscode from 'vscode';
import type { DagsterProject } from '../projectDetection';
import { runInTerminal } from '../util/terminalRun';

/** `dg scaffold github-actions` writes a workflow into `.github/workflows/`
 * -- confirmed via its own CLI help, which also notes `dg plus deploy
 * configure --git-provider github` is the newer replacement; kept to this
 * simpler, backward-compatible command since Dagster+ deploy config needs
 * real account credentials this extension doesn't have a flow for yet. */
export function scaffoldGithubActions(project: DagsterProject): void {
  if (!project.dgPath) {
    vscode.window.showWarningMessage('Dagster: no dg-detected project to scaffold into.');
    return;
  }
  runInTerminal(
    'Scaffold GitHub Actions',
    project.folder.uri.fsPath,
    `${JSON.stringify(project.dgPath)} scaffold github-actions`,
    (exitCode) => {
      if (exitCode === 0) {
        vscode.window.showInformationMessage('Dagster: GitHub Actions workflow scaffolded in .github/workflows/.');
      } else {
        vscode.window.showErrorMessage(`Dagster: scaffolding GitHub Actions failed (exit code ${exitCode}).`);
      }
    }
  );
}

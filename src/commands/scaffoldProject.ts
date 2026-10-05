import * as vscode from 'vscode';
import { runInTerminal } from '../util/terminalRun';

/**
 * `dg` itself only manages an EXISTING project (scaffold components/defs
 * within one, check it, run it) -- creating a brand-new project from a
 * blank folder is a separate tool, `create-dagster` (confirmed live:
 * `uvx create-dagster project .` scaffolds pyproject.toml + src/<name>/
 * {definitions.py, defs/, components/} + tests/ directly into the cwd).
 * Run in a visible terminal, not a hidden subprocess -- it has its own
 * interactive "run uv sync?" prompt the user needs to actually answer.
 */
export async function scaffoldNewProject(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'Open an empty folder first, then run "Dagster: Scaffold New Project" again to create one there.',
      'Open Folder'
    );
    if (choice === 'Open Folder') {
      await vscode.commands.executeCommand('vscode.openFolder');
    }
    return;
  }

  let cwd = folders[0].uri.fsPath;
  if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { title: 'Scaffold a new Dagster project in which folder?' }
    );
    if (!pick) return;
    cwd = pick.folder.uri.fsPath;
  }

  runInTerminal('Scaffold Dagster Project', cwd, 'uvx create-dagster project .');
  vscode.window.showInformationMessage(
    'Dagster: scaffolding in the terminal -- answer its prompts there, then run "Dagster: Refresh Project Detection" once it finishes.'
  );
}

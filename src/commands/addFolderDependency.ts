import * as vscode from 'vscode';
import type { AssetIndexStore } from '../data/assetIndex';

/**
 * Adds an upstream dependency to every asset in a folder via a
 * DefsFolderComponent's `post_processing.assets` block -- confirmed live
 * by reading the real `dagster` source (not guessed): `defs_module.py`'s
 * `DefsFolderComponent`/`ComponentFileModel`, and `core_models.py`'s
 * `AssetPostProcessorModel` (`target`/`operation`/`attributes`) backed by
 * `SharedAssetKwargs`, which genuinely includes `deps` (plus group_name,
 * tags, owners, kinds, automation_condition, etc.). This is a POST-HOC
 * overlay applied via `Definitions.map_asset_specs` after a folder's
 * children already built their AssetSpecs, so it works identically
 * whether those children are plain `@asset`-decorated Python or any
 * other component type -- one mechanism, not per-component-type UI.
 *
 * Reuses the exact same suggest-a-fix + diff-preview + Apply/Discard
 * flow as the dg check Quick Fix, the run-failure analyzer, and
 * "Set Default Status in Code" -- a synthetic Diagnostic carrying the
 * instruction instead of a real error, same trick each of those already
 * uses. The target file may not exist yet (a folder with no explicit
 * defs.yaml is still implicitly a DefsFolderComponent) -- an empty file
 * is created first so there's always a real document to diff against;
 * computeSnippetRange naturally clamps to the whole (possibly empty)
 * small file, so no changes to that shared pipeline were needed.
 */
export function registerAddFolderDependencyCommand(context: vscode.ExtensionContext, assets: AssetIndexStore): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.addFolderDependency', async (folderUri?: vscode.Uri) => {
      if (!folderUri) {
        vscode.window.showWarningMessage('Dagster: right-click a folder in the Explorer to use this.');
        return;
      }

      const seen = new Set<string>();
      const keys = [...assets.getIndex().values()].map((i) => i.key).filter((k) => !seen.has(k) && seen.add(k));
      if (keys.length === 0) {
        vscode.window.showWarningMessage('Dagster: no assets loaded yet -- is a dev server running for this project?');
        return;
      }
      const assetKey = await vscode.window.showQuickPick(keys, {
        title: 'Add dependency on which asset?',
        placeHolder: 'Every asset in this folder will depend on the one you pick',
      });
      if (!assetKey) return;

      const defsYamlUri = vscode.Uri.joinPath(folderUri, 'defs.yaml');
      let existed = true;
      try {
        await vscode.workspace.fs.stat(defsYamlUri);
      } catch {
        existed = false;
        await vscode.workspace.fs.writeFile(defsYamlUri, new Uint8Array());
      }

      const instruction = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        existed
          ? `This defs.yaml configures a Dagster DefsFolderComponent for this folder (or should be updated to). Add a dependency on the asset "${assetKey}" to every asset in this folder: ensure "type: dagster.DefsFolderComponent" is set, and add "${assetKey}" to the deps list under post_processing.assets for a { target: "*", operation: merge } entry -- create that structure if it doesn't exist yet, without removing or duplicating any existing post_processing entries or other configuration in this file.`
          : `This is a brand-new, empty defs.yaml for a folder that should become a Dagster DefsFolderComponent. Write a complete, minimal, valid defs.yaml with "type: dagster.DefsFolderComponent" and a post_processing.assets entry with { target: "*", operation: merge, attributes: { deps: ["${assetKey}"] } }, so every asset in this folder depends on "${assetKey}".`,
        vscode.DiagnosticSeverity.Hint
      );
      await vscode.commands.executeCommand('dagsterPowerUser.fixDiagnosticWithAi', defsYamlUri, instruction);
    })
  );
}

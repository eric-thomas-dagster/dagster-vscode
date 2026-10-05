import * as vscode from 'vscode';
import { computeSnippetRange, snippetToRange, suggestFix } from '../ai/fixSuggester';
import { MissingApiKeyError, setApiKey } from '../ai/llmClient';

const PREVIEW_SCHEME = 'dagster-fix-preview';

/** Serves the proposed full-file text for a diff preview -- an in-memory
 * virtual document, never written to disk unless the user hits "Apply
 * Fix". One entry per preview; small and short-lived, no cleanup needed
 * beyond overwriting on the next fix (previews aren't meant to persist
 * across reloads). */
class FixPreviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, text: string): void {
    this.contents.set(uri.toString(), text);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }
}

export function registerFixDiagnosticCommand(context: vscode.ExtensionContext): void {
  const previewProvider = new FixPreviewContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider));
  let previewCounter = 0;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dagsterPowerUser.fixDiagnosticWithAi',
      async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
        const document = await vscode.workspace.openTextDocument(uri);
        const snippet = computeSnippetRange(document, diagnostic.range.start.line);

        let suggestion;
        try {
          suggestion = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Dagster Expert: analyzing fix...' },
            () => suggestFix(context, document, diagnostic.message, snippet)
          );
        } catch (e) {
          if (e instanceof MissingApiKeyError) {
            const choice = await vscode.window.showWarningMessage(
              `Dagster: no ${e.provider} API key set.`,
              'Set API Key'
            );
            if (choice === 'Set API Key') await setApiKey(context, e.provider);
          } else {
            vscode.window.showErrorMessage(
              `Dagster: couldn't get a fix (${e instanceof Error ? e.message : String(e)}).`
            );
          }
          return;
        }

        const fullText = document.getText();
        const range = snippetToRange(document, snippet);
        const before = document.getText(new vscode.Range(new vscode.Position(0, 0), range.start));
        const after = document.getText(new vscode.Range(range.end, document.positionAt(fullText.length)));
        const proposedFullText = before + suggestion.fixedSnippet + after;

        previewCounter += 1;
        const fileName = uri.path.split('/').pop() ?? 'file';
        const previewUri = vscode.Uri.parse(`${PREVIEW_SCHEME}:/fix-${previewCounter}-${fileName}`);
        previewProvider.set(previewUri, proposedFullText);

        await vscode.commands.executeCommand(
          'vscode.diff',
          uri,
          previewUri,
          `Dagster Expert Fix: ${vscode.workspace.asRelativePath(uri)} (preview -- not yet applied)`
        );

        const choice = await vscode.window.showInformationMessage(
          suggestion.explanation,
          'Apply Fix',
          'Discard'
        );
        if (choice === 'Apply Fix') {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, range, suggestion.fixedSnippet);
          const applied = await vscode.workspace.applyEdit(edit);
          if (applied) {
            vscode.window.showInformationMessage('Dagster: fix applied -- review and save the file.');
          } else {
            vscode.window.showErrorMessage('Dagster: could not apply the fix (the file may have changed).');
          }
        }
      }
    )
  );
}

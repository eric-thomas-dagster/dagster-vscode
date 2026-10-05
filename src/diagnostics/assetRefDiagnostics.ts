import * as vscode from 'vscode';
import { extractAssetRefs } from '../language/assetRefExtraction';
import type { AssetIndexStore } from '../data/assetIndex';

const DIAGNOSTIC_OWNER = 'dagster-asset-refs';
const DEBOUNCE_MS = 400;

/** Squiggles any `deps`/`asset_key` reference that doesn't resolve to a
 * real asset in the current dev server's graph -- see
 * assetRefExtraction.ts for why this is scoped to structured refs only. */
export class AssetRefDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_OWNER);
  private readonly debounceHandles = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly store: AssetIndexStore) {}

  refreshDocument(document: vscode.TextDocument): void {
    if (document.languageId !== 'python' && document.languageId !== 'yaml') {
      this.collection.delete(document.uri);
      return;
    }
    const refs = extractAssetRefs(document.languageId, document.getText());
    const index = this.store.getIndex();
    const diagnostics: vscode.Diagnostic[] = [];
    for (const ref of refs) {
      if (index.has(ref.name)) continue;
      const range = new vscode.Range(document.positionAt(ref.start), document.positionAt(ref.end));
      const diagnostic = new vscode.Diagnostic(
        range,
        `Unknown asset "${ref.name}" — not found in this project's asset graph.`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = 'dagster-asset-refs';
      diagnostics.push(diagnostic);
    }
    this.collection.set(document.uri, diagnostics);
  }

  refreshDocumentDebounced(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.debounceHandles.get(key);
    if (existing) clearTimeout(existing);
    this.debounceHandles.set(
      key,
      setTimeout(() => {
        this.debounceHandles.delete(key);
        this.refreshDocument(document);
      }, DEBOUNCE_MS)
    );
  }

  refreshAllOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) this.refreshDocument(doc);
  }

  dispose(): void {
    for (const handle of this.debounceHandles.values()) clearTimeout(handle);
    this.collection.dispose();
  }
}

export function registerAssetRefDiagnostics(
  context: vscode.ExtensionContext,
  store: AssetIndexStore
): AssetRefDiagnostics {
  const diagnostics = new AssetRefDiagnostics(store);
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => diagnostics.refreshDocument(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => diagnostics.refreshDocumentDebounced(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.refreshDocument(doc))
  );

  store.onDidChange(() => diagnostics.refreshAllOpenDocuments(), null, context.subscriptions);

  diagnostics.refreshAllOpenDocuments();
  return diagnostics;
}

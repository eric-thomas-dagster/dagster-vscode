import * as vscode from 'vscode';
import { searchDagsterDocs, type DocsSearchHit } from '../data/docsSearch';

const DEBOUNCE_MS = 250;

interface DocsQuickPickItem extends vscode.QuickPickItem {
  url: string;
}

export function registerSearchDocsCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.searchDocs', () => {
      const qp = vscode.window.createQuickPick<DocsQuickPickItem>();
      qp.title = 'Search Dagster Docs';
      qp.placeholder = 'Type to search docs.dagster.io...';
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;

      let debounceHandle: ReturnType<typeof setTimeout> | undefined;
      qp.onDidChangeValue((value) => {
        if (debounceHandle) clearTimeout(debounceHandle);
        if (!value.trim()) {
          qp.items = [];
          return;
        }
        debounceHandle = setTimeout(async () => {
          qp.busy = true;
          try {
            const hits = await searchDagsterDocs(value);
            qp.items = hits.map((h: DocsSearchHit) => ({
              label: h.title,
              description: h.breadcrumb,
              detail: h.snippet,
              url: h.url,
            }));
          } catch (e) {
            qp.items = [];
            vscode.window.showWarningMessage(
              `Dagster: docs search failed: ${e instanceof Error ? e.message : e}`
            );
          } finally {
            qp.busy = false;
          }
        }, DEBOUNCE_MS);
      });

      qp.onDidAccept(() => {
        const picked = qp.selectedItems[0];
        if (picked) void vscode.env.openExternal(vscode.Uri.parse(picked.url));
        qp.hide();
      });

      qp.onDidHide(() => qp.dispose());
      qp.show();
    })
  );
}

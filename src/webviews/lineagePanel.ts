import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import { fetchAssetGraph } from '../data/graphqlClient';
import { toGraphElements } from '../data/toGraphElements';
import type { DgCheckIssue } from '../diagnostics/dgCheckDiagnostics';

let currentPanel: vscode.WebviewPanel | undefined;

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** Reads the Vite-built webview-ui bundle's index.html and rewrites it for
 * a VS Code webview: relative `./assets/...` references become
 * `webview.asWebviewUri()` URIs (the only URIs the webview's sandbox is
 * allowed to load), and a strict nonce-based CSP replaces the open-by-default
 * web page this HTML would otherwise be -- no inline/remote script execution
 * beyond the one nonced bundle entry point. */
async function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const webviewDistUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const htmlUri = vscode.Uri.joinPath(webviewDistUri, 'index.html');
  const bytes = await vscode.workspace.fs.readFile(htmlUri);
  let html = new TextDecoder('utf-8').decode(bytes);

  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  html = html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
  html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_match, attr: string, relPath: string) => {
    const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDistUri, relPath));
    return `${attr}="${assetUri.toString()}"`;
  });
  html = html.replace('<script type="module"', `<script nonce="${nonce}" type="module"`);

  return html;
}

/** Singleton panel -- re-reveals the existing one instead of spawning a
 * second, matching how most "show me a view" VS Code commands behave. */
export async function showAssetLineagePanel(
  context: vscode.ExtensionContext,
  graphqlUrl: string,
  getValidationIssues: () => Promise<DgCheckIssue[]>
): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal();
    void loadRealGraph(currentPanel, graphqlUrl, getValidationIssues);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'dagsterPowerUser.assetLineage',
    'Dagster: Asset Lineage',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      retainContextWhenHidden: true,
    }
  );

  panel.webview.html = await buildHtml(panel.webview, context.extensionUri);
  panel.onDidDispose(() => {
    currentPanel = undefined;
  });
  panel.webview.onDidReceiveMessage(async (message: { type: string; filePath?: string; line?: number }) => {
    if (message.type === 'openIssueLocation' && message.filePath) {
      const uri = vscode.Uri.file(message.filePath);
      const line = Math.max(0, (message.line ?? 1) - 1);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line, 0, line, 0),
        viewColumn: vscode.ViewColumn.Beside,
      });
    }
  });
  currentPanel = panel;

  // The webview starts with its own hardcoded demo graph (so it never
  // looks broken/empty) and replaces it the moment real data arrives.
  void loadRealGraph(panel, graphqlUrl, getValidationIssues);
}

async function loadRealGraph(
  panel: vscode.WebviewPanel,
  graphqlUrl: string,
  getValidationIssues: () => Promise<DgCheckIssue[]>
): Promise<void> {
  try {
    const summary = await fetchAssetGraph(graphqlUrl);
    const { nodes, edges } = toGraphElements(summary);
    if (nodes.length === 0) {
      // Confirmed live: a broken code location does NOT surface as a
      // GraphQL error here -- `dg dev`'s API just quietly returns
      // `assetNodes: []`, same as a genuinely empty project would. Check
      // `dg check` to tell the two apart before deciding whether this is
      // "nothing to show yet" or "something's broken" -- only show the
      // banner if it actually found something.
      const issues = await getValidationIssues();
      if (issues.length > 0) {
        void panel.webview.postMessage({ type: 'validationError', issues });
        return;
      }
    }
    void panel.webview.postMessage({ type: 'graph', nodes, edges });
  } catch (e) {
    // A thrown exception (network error, non-2xx, malformed response) --
    // the dev server likely isn't reachable at all rather than reachable
    // but broken. Still worth checking dg check in case it's informative.
    const issues = await getValidationIssues();
    if (issues.length > 0) {
      void panel.webview.postMessage({ type: 'validationError', issues });
    } else {
      void panel.webview.postMessage({
        type: 'validationError',
        issues: [{ message: e instanceof Error ? e.message : String(e), filePath: null, line: null }],
      });
    }
  }
}

import * as vscode from 'vscode';
import {
  fetchRuns,
  fetchRunLogs,
  terminateRunById,
  retryRun,
  deriveWebBaseUrl,
  type RunSummary,
  type RunLogEntry,
} from '../data/graphqlClient';
import { type ActiveTargetStore, describeTarget, resolveEndpoint } from '../data/activeTarget';

let currentPanel: vscode.WebviewPanel | undefined;

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const STATUS_CLASS: Record<string, string> = {
  SUCCESS: 'ok',
  FAILURE: 'danger',
  CANCELED: 'neutral',
  CANCELING: 'warning',
  QUEUED: 'neutral',
  NOT_STARTED: 'neutral',
  MANAGED: 'neutral',
  STARTING: 'warning',
  STARTED: 'warning',
};

function formatRelativeTime(unixSeconds: number): string {
  const diffSeconds = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diffSeconds < 60) return `${Math.round(diffSeconds)}s ago`;
  if (diffSeconds < 3600) return `${Math.round(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.round(diffSeconds / 3600)}h ago`;
  return `${Math.round(diffSeconds / 86400)}d ago`;
}

function formatDuration(startTime: number | null, endTime: number | null): string {
  if (!startTime) return '–';
  const end = endTime ?? Date.now() / 1000;
  const seconds = Math.max(0, end - startTime);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}

function renderRunRow(run: RunSummary, webBaseUrl: string): string {
  const colorClass = STATUS_CLASS[run.status] ?? 'neutral';
  const time = run.startTime ? formatRelativeTime(run.startTime) : formatRelativeTime(run.creationTime);
  const duration = formatDuration(run.startTime, run.endTime);
  const canTerminate = run.hasTerminatePermission && run.canTerminate;
  const canRetry = run.hasReExecutePermission && !['QUEUED', 'STARTING', 'STARTED', 'CANCELING'].includes(run.status);
  const canAnalyze = run.status === 'FAILURE';
  const runUrl = `${webBaseUrl}/runs/${run.runId}`;

  return `
    <div class="run-row" data-run-id="${run.runId}">
      <div class="run-main">
        <span class="status-badge ${colorClass}">${run.status}</span>
        <span class="run-job">${escapeHtml(run.jobName)}</span>
        <span class="run-time muted">${time}</span>
        <span class="run-duration muted">${duration}</span>
        <span class="run-actions">
          <a href="${runUrl}" target="_blank" title="Open in Dagster"><i class="codicon codicon-link-external"></i></a>
          <button class="icon-btn log-btn" title="View logs" data-run-id="${run.runId}"><i class="codicon codicon-output"></i></button>
          ${canAnalyze ? `<button class="icon-btn analyze-btn" title="Ask Dagster Expert to analyze this failure" data-run-id="${run.runId}"><i class="codicon codicon-sparkle"></i></button>` : ''}
          ${canRetry ? `<button class="icon-btn retry-btn" title="Retry" data-run-id="${run.runId}"><i class="codicon codicon-debug-rerun"></i></button>` : ''}
          ${canTerminate ? `<button class="icon-btn terminate-btn" title="Terminate" data-run-id="${run.runId}"><i class="codicon codicon-debug-stop"></i></button>` : ''}
        </span>
      </div>
      <div class="run-id muted">${run.runId}</div>
      <div class="run-logs" id="logs-${run.runId}" style="display:none"></div>
    </div>`;
}

function renderBody(nonce: string, connected: boolean, targetLabel: string, runs?: RunSummary[], webBaseUrl?: string, error?: string): string {
  if (error) {
    return `
      <div class="cta">
        <i class="codicon codicon-error"></i>
        <h2>Couldn't load runs</h2>
        <p>${escapeHtml(error)}</p>
        <button id="refresh-btn">Retry</button>
      </div>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('refresh-btn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
      </script>`;
  }
  if (!connected) {
    return `
      <div class="cta">
        <i class="codicon codicon-debug-disconnect"></i>
        <h2>No target to show runs for</h2>
        <p>Switch to a target with a local project, a remote URL, or a connected Dagster+ deployment.</p>
        <button id="switch-btn">Switch Target</button>
      </div>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('switch-btn').addEventListener('click', () => vscode.postMessage({ type: 'switchTarget' }));
      </script>`;
  }

  const rows = (runs ?? []).map((r) => renderRunRow(r, webBaseUrl ?? '')).join('');

  return `
    <div class="header-row">
      <span class="target-badge">${escapeHtml(targetLabel)}</span>
      <button id="refresh-btn" title="Refresh"><i class="codicon codicon-refresh"></i></button>
    </div>
    <div class="runs-list">${rows || '<p class="muted">No runs yet.</p>'}</div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('refresh-btn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
      document.querySelectorAll('.log-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const runId = btn.getAttribute('data-run-id');
          const el = document.getElementById('logs-' + runId);
          const nowHidden = el.style.display === 'none';
          el.style.display = nowHidden ? 'block' : 'none';
          if (nowHidden && !el.dataset.loaded) {
            el.textContent = 'Loading...';
            vscode.postMessage({ type: 'viewLogs', runId });
          }
        });
      });
      document.querySelectorAll('.retry-btn').forEach((btn) => {
        btn.addEventListener('click', () => vscode.postMessage({ type: 'retry', runId: btn.getAttribute('data-run-id') }));
      });
      document.querySelectorAll('.analyze-btn').forEach((btn) => {
        btn.addEventListener('click', () => vscode.postMessage({ type: 'analyzeFailure', runId: btn.getAttribute('data-run-id') }));
      });
      document.querySelectorAll('.terminate-btn').forEach((btn) => {
        btn.addEventListener('click', () => vscode.postMessage({ type: 'terminate', runId: btn.getAttribute('data-run-id') }));
      });
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'logs') {
          const el = document.getElementById('logs-' + message.runId);
          if (!el) return;
          el.dataset.loaded = '1';
          el.textContent = message.entries.length
            ? message.entries.map((e) => '[' + e.level + '] ' + e.message).join('\\n')
            : '(no log messages)';
        }
      });
    </script>`;
}

function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, nonce: string, body: string): string {
  const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicons', 'codicon.css'));
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link href="${codiconCssUri}" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; font-size: 13px; }
    h2 { margin: 12px 0 4px; }
    .cta { text-align: center; padding: 60px 20px; }
    .cta .codicon { font-size: 32px; opacity: 0.7; }
    .cta p { opacity: 0.8; max-width: 420px; margin: 0 auto 16px; }
    button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    #refresh-btn { background: transparent; color: var(--vscode-foreground); padding: 4px 8px; }
    #refresh-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .target-badge {
      font-size: 12px; font-weight: 600;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      padding: 3px 10px; border-radius: 999px;
    }
    .muted { opacity: 0.65; }
    .runs-list { display: flex; flex-direction: column; gap: 6px; }
    .run-row {
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 6px;
      padding: 8px 10px;
    }
    .run-main { display: flex; align-items: center; gap: 10px; }
    .status-badge {
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
      padding: 2px 7px; border-radius: 4px; color: white;
      flex-shrink: 0;
    }
    .status-badge.ok { background: var(--vscode-charts-green, #3fb950); }
    .status-badge.warning { background: var(--vscode-charts-yellow, #d29922); color: black; }
    .status-badge.danger { background: var(--vscode-charts-red, #f85149); }
    .status-badge.neutral { background: var(--vscode-charts-blue, #4a9eff); }
    .run-job { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-time, .run-duration { flex-shrink: 0; font-size: 12px; }
    .run-actions { display: flex; gap: 2px; flex-shrink: 0; }
    .run-actions a, .icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border-radius: 4px; cursor: pointer;
      background: transparent; border: none; color: var(--vscode-foreground); padding: 0;
    }
    .run-actions a:hover, .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .run-id { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); margin-top: 3px; margin-left: 2px; }
    .run-logs {
      margin-top: 8px; padding: 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); border-radius: 4px;
      white-space: pre-wrap; max-height: 300px; overflow-y: auto;
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

async function refresh(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  mediaRoot: vscode.Uri,
  activeTargetStore: ActiveTargetStore,
  getLocalGraphqlUrl: () => string | undefined
): Promise<void> {
  const nonce = getNonce();
  const target = activeTargetStore.get();
  const targetLabel = describeTarget(target);
  const localUrl = getLocalGraphqlUrl() ?? '';

  const endpoint = await resolveEndpoint(context, target, localUrl);
  if (!endpoint || (target.kind === 'local' && !localUrl)) {
    panel.webview.html = renderHtml(panel.webview, mediaRoot, nonce, renderBody(nonce, false, targetLabel));
    return;
  }

  try {
    const runs = await fetchRuns(endpoint);
    panel.webview.html = renderHtml(
      panel.webview,
      mediaRoot,
      nonce,
      renderBody(nonce, true, targetLabel, runs, deriveWebBaseUrl(endpoint.url))
    );
  } catch (e) {
    panel.webview.html = renderHtml(
      panel.webview,
      mediaRoot,
      nonce,
      renderBody(nonce, true, targetLabel, undefined, undefined, e instanceof Error ? e.message : String(e))
    );
  }
}

export async function showRunExplorerPanel(
  context: vscode.ExtensionContext,
  activeTargetStore: ActiveTargetStore,
  getLocalGraphqlUrl: () => string | undefined
): Promise<void> {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');

  if (currentPanel) {
    currentPanel.reveal();
    void refresh(context, currentPanel, mediaRoot, activeTargetStore, getLocalGraphqlUrl);
    return;
  }

  const panel = vscode.window.createWebviewPanel('dagsterPowerUser.runExplorer', 'Dagster Runs', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [mediaRoot],
  });
  currentPanel = panel;
  panel.onDidDispose(() => {
    currentPanel = undefined;
    targetChangeDisposable?.dispose();
  });

  const targetChangeDisposable = activeTargetStore.onDidChange(() =>
    refresh(context, panel, mediaRoot, activeTargetStore, getLocalGraphqlUrl)
  );

  panel.webview.onDidReceiveMessage(async (message: { type: string; runId?: string }) => {
    const target = activeTargetStore.get();
    const localUrl = getLocalGraphqlUrl() ?? '';
    const endpoint = await resolveEndpoint(context, target, localUrl);

    if (message.type === 'refresh') {
      void refresh(context, panel, mediaRoot, activeTargetStore, getLocalGraphqlUrl);
    } else if (message.type === 'switchTarget') {
      await vscode.commands.executeCommand('dagsterPowerUser.switchTarget');
      void refresh(context, panel, mediaRoot, activeTargetStore, getLocalGraphqlUrl);
    } else if (message.type === 'viewLogs' && message.runId && endpoint) {
      try {
        const entries = await fetchRunLogs(endpoint, message.runId);
        void panel.webview.postMessage({ type: 'logs', runId: message.runId, entries });
      } catch (e) {
        void panel.webview.postMessage({
          type: 'logs',
          runId: message.runId,
          entries: [{ level: 'ERROR', message: e instanceof Error ? e.message : String(e) } as Partial<RunLogEntry>],
        });
      }
    } else if (message.type === 'terminate' && message.runId && endpoint) {
      const outcome = await terminateRunById(endpoint, message.runId);
      vscode.window.showInformationMessage(`Dagster: ${outcome.message}`);
      void refresh(context, panel, mediaRoot, activeTargetStore, getLocalGraphqlUrl);
    } else if (message.type === 'retry' && message.runId && endpoint) {
      const outcome = await retryRun(endpoint, message.runId);
      if (outcome.success) {
        vscode.window.showInformationMessage(`Dagster: ${outcome.message}`);
      } else {
        vscode.window.showErrorMessage(`Dagster: retry failed -- ${outcome.message}`);
      }
      void refresh(context, panel, mediaRoot, activeTargetStore, getLocalGraphqlUrl);
    } else if (message.type === 'analyzeFailure' && message.runId) {
      await vscode.commands.executeCommand('dagsterPowerUser.analyzeRunFailure', message.runId);
    }
  });

  void refresh(context, panel, mediaRoot, activeTargetStore, getLocalGraphqlUrl);
}

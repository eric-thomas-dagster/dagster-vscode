import * as vscode from 'vscode';
import { getDagsterPlusUsageSummary, type DagsterPlusUsageSummary } from '../data/dagsterPlusClient';
import { type ActiveTargetStore, describeTarget, pickTarget } from '../data/activeTarget';
import { CHAT_SHARED_CSS, renderSidebarBodyHtml } from './chatStyles';
import { type SessionManager, sessionListMessage } from './sessionManager';

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** Pinned quick-action pills shown above the session list -- kept to just
 * the handful of commands used constantly (per the "let this panel do
 * EVERYTHING" ask). Everything else lives behind the "More Actions" pill
 * (src/commands/moreActions.ts) as a categorized QuickPick instead of a
 * flat row that just kept growing -- same idea as a toolbar "..." menu. */
export const QUICK_ACTIONS: Array<{ command: string; label: string; icon: string }> = [
  { command: 'dagsterPowerUser.devServerMenu', label: 'Dev Server', icon: 'server-process' },
  { command: 'dagsterPowerUser.materializeAssetSearch', label: 'Materialize Asset', icon: 'play' },
  { command: 'dagsterPowerUser.launchJobSearch', label: 'Launch Job', icon: 'play-circle' },
  { command: 'dagsterPowerUser.showMoreActions', label: 'More Actions', icon: 'ellipsis' },
];

export const MORE_ACTIONS_COMMAND = 'dagsterPowerUser.showMoreActions';

/**
 * The sidebar view -- docked under the same Activity Bar icon as Dagster
 * Definitions, same idea as Claude Code's own session-manager sidebar.
 * NOT a chat UI: no messages, no input box. It's a picker -- quick
 * actions, the Local/Remote target switch, Dagster+ usage, and the full
 * session list. Picking a session (or "New Chat") opens/focuses that
 * session's own editor tab (chatPanel.ts), where the actual conversation
 * lives -- exactly Claude Code's own "session list sidebar + separate
 * chat tabs" split, per explicit feedback that a single merged view
 * wasn't what was wanted.
 */
export class DagsterExpertChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'dagsterPowerUser.chat';
  private view: vscode.WebviewView | undefined;
  private plusUsage: DagsterPlusUsageSummary | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessions: SessionManager,
    private readonly activeTarget: ActiveTargetStore,
    private readonly hasLocalProject: () => boolean,
    private readonly openSessionTab: (sessionId: string) => void
  ) {
    // Sessions/target can both change from OUTSIDE this webview's own
    // messages (e.g. "New Chat"/"Chat History" run as real vscode
    // commands, or a session being appended to from an "ask Dagster
    // Expert about this error" flow elsewhere) -- resync whenever either
    // does, not just right after this view's own messages.
    this.sessions.onDidChange(() => this.syncState());
    this.activeTarget.onDidChange(() => this.syncState());
  }

  private syncState(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'target',
      isLocal: this.activeTarget.get().kind === 'local',
      label: describeTarget(this.activeTarget.get()),
    });
    void this.view.webview.postMessage(
      sessionListMessage(this.sessions.listSessions(), this.sessions.getActiveSession().id)
    );
    // Re-post whatever Dagster+ summary is already cached (no network
    // call here) so switching back to this view doesn't flash blank
    // while refreshPlusUsage()'s own fetch is still in flight.
    if (this.plusUsage) {
      void this.view.webview.postMessage({ type: 'plusUsage', summary: this.plusUsage });
    }
  }

  /** The one real network call in this file -- kept off the hot path of
   * every quick action and only triggered on view-open and after "More
   * Actions" (the only place Connect Dagster+ / credential changes can
   * come from), not on every single command run. */
  private async refreshPlusUsage(): Promise<void> {
    this.plusUsage = await getDagsterPlusUsageSummary(this.context);
    if (this.view) {
      void this.view.webview.postMessage({ type: 'plusUsage', summary: this.plusUsage });
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    webviewView.webview.html = this.renderHtml(webviewView.webview, mediaRoot);

    webviewView.webview.onDidReceiveMessage(
      async (message: {
        type: string;
        command?: string;
        to?: 'local' | 'remote';
        id?: string;
        archived?: boolean;
      }) => {
        if (message.type === 'switchTarget') {
          if (message.to === 'local') {
            await this.activeTarget.set({ kind: 'local' });
          } else {
            const picked = await pickTarget(this.context, this.hasLocalProject());
            if (picked) await this.activeTarget.set(picked);
          }
          return;
        }
        if (message.type === 'switchSession' && message.id) {
          this.openSessionTab(message.id);
          return;
        }
        if (message.type === 'newSessionInline') {
          const session = await this.sessions.newSession();
          this.openSessionTab(session.id);
          return;
        }
        if (message.type === 'archiveSessionInline' && message.id) {
          await this.sessions.archive(message.id, !!message.archived);
          return;
        }
        if (message.type === 'deleteSessionInline' && message.id) {
          const target = this.sessions.listSessions().find((s) => s.id === message.id);
          const confirm = await vscode.window.showWarningMessage(
            `Delete "${target?.title ?? 'this session'}"?`,
            { modal: true },
            'Delete'
          );
          if (confirm === 'Delete') await this.sessions.remove(message.id);
          return;
        }
        if (message.type === 'ready') {
          this.syncState();
          void this.refreshPlusUsage();
          return;
        }
        if (message.type === 'runCommand' && message.command) {
          await vscode.commands.executeCommand(message.command);
          if (message.command === MORE_ACTIONS_COMMAND) {
            // The only place a Dagster+ credential change can come from
            // right now (it's a More Actions entry, not a pinned pill).
            void this.refreshPlusUsage();
          }
          this.syncState();
        }
      }
    );
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chatSidebar.js'));
    const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicons', 'codicon.css'));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    const actionButtons = QUICK_ACTIONS.map(
      (a) =>
        `<button class="quick-action" data-run-command="${a.command}" title="${a.label}">` +
        `<i class="codicon codicon-${a.icon}"></i><span>${a.label}</span></button>`
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link href="${codiconCssUri}" rel="stylesheet" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
${CHAT_SHARED_CSS}
  </style>
</head>
<body>${renderSidebarBodyHtml(actionButtons)}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

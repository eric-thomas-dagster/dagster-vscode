import * as vscode from 'vscode';
import { askDagsterExpert } from '../ai/dagsterExpert';
import { hasApiKey, setApiKey } from '../ai/llmClient';
import type { AssetIndexStore } from '../data/assetIndex';
import type { PrimitiveIndexStore } from '../data/primitiveIndex';
import { SessionManager, sessionListMessage } from './sessionManager';
import { getDagsterPlusUsageSummary, type DagsterPlusUsageSummary } from '../data/dagsterPlusClient';
import { type ActiveTargetStore, describeTarget, pickTarget } from '../data/activeTarget';
import { CHAT_SHARED_CSS, renderChatBodyHtml } from './chatStyles';
import { QUICK_ACTIONS, MORE_ACTIONS_COMMAND } from './chatViewProvider';

let currentPanel: vscode.WebviewPanel | undefined;

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** The same Dagster Expert chat as the sidebar view, but as an editor
 * TAB with a visible session-list rail down the left (Claude.ai's own
 * layout) instead of the sidebar's single-conversation view + a QuickPick
 * for history. Shares the sidebar's CSS/body markup and client script
 * (media/chatView.js) wholesale -- only the rail and its thin wrapper
 * layout are new; everything else (quick actions, bubbles, target tabs,
 * Dagster+ usage) behaves identically in both. Singleton, like the asset
 * lineage panel: reveals the existing tab instead of spawning a second. */
export class DagsterExpertChatPanel {
  private readonly panel: vscode.WebviewPanel;
  private plusUsage: DagsterPlusUsageSummary | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: AssetIndexStore,
    private readonly primitives: PrimitiveIndexStore,
    private readonly sessions: SessionManager,
    private readonly activeTarget: ActiveTargetStore,
    private readonly hasLocalProject: () => boolean
  ) {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'dagsterPowerUser.chatPanel',
      'Dagster Expert',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [mediaRoot], retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.renderHtml(this.panel.webview, mediaRoot);

    this.disposables.push(
      this.sessions.onDidChange(() => this.syncState()),
      this.activeTarget.onDidChange(() => this.syncState()),
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  static showOrReveal(
    context: vscode.ExtensionContext,
    store: AssetIndexStore,
    primitives: PrimitiveIndexStore,
    sessions: SessionManager,
    activeTarget: ActiveTargetStore,
    hasLocalProject: () => boolean
  ): void {
    if (currentPanel) {
      currentPanel.reveal();
      return;
    }
    const instance = new DagsterExpertChatPanel(context, store, primitives, sessions, activeTarget, hasLocalProject);
    currentPanel = instance.panel;
  }

  private dispose(): void {
    currentPanel = undefined;
    for (const d of this.disposables) d.dispose();
  }

  private syncState(): void {
    const session = this.sessions.getActiveSession();
    void this.panel.webview.postMessage({ type: 'loadHistory', title: session.title, messages: session.messages });
    void this.panel.webview.postMessage({
      type: 'target',
      isLocal: this.activeTarget.get().kind === 'local',
      label: describeTarget(this.activeTarget.get()),
    });
    void this.panel.webview.postMessage(sessionListMessage(this.sessions.listSessions(), session.id));
    if (this.plusUsage) {
      void this.panel.webview.postMessage({ type: 'plusUsage', summary: this.plusUsage });
    }
  }

  private async refreshPlusUsage(): Promise<void> {
    this.plusUsage = await getDagsterPlusUsageSummary(this.context);
    void this.panel.webview.postMessage({ type: 'plusUsage', summary: this.plusUsage });
  }

  private async onMessage(message: {
    type: string;
    question?: string;
    command?: string;
    to?: 'local' | 'remote';
    id?: string;
    archived?: boolean;
  }): Promise<void> {
    const webview = this.panel.webview;
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
      await this.sessions.switchTo(message.id);
      return;
    }
    if (message.type === 'newSessionInline') {
      await this.sessions.newSession();
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
      const ok = await hasApiKey(this.context);
      void webview.postMessage({ type: ok ? 'ready' : 'needsKey' });
      this.syncState();
      void this.refreshPlusUsage();
      return;
    }
    if (message.type === 'setKey') {
      await setApiKey(this.context, 'anthropic');
      const ok = await hasApiKey(this.context);
      void webview.postMessage({ type: ok ? 'ready' : 'needsKey' });
      return;
    }
    if (message.type === 'runCommand' && message.command) {
      await vscode.commands.executeCommand(message.command);
      if (message.command !== MORE_ACTIONS_COMMAND) {
        const action = QUICK_ACTIONS.find((a) => a.command === message.command);
        void webview.postMessage({ type: 'commandRan', label: action?.label ?? message.command });
      } else {
        void this.refreshPlusUsage();
      }
      this.syncState();
      return;
    }
    if (message.type === 'ask' && message.question) {
      const question = message.question;
      try {
        const history = this.sessions.getActiveSession().messages;
        const answer = await askDagsterExpert(this.context, this.store, this.primitives, question, history);
        await this.sessions.appendMessage({ role: 'user', content: question });
        await this.sessions.appendMessage({ role: 'assistant', content: answer });
        void webview.postMessage({ type: 'answer', text: answer });
        this.syncState();
      } catch (e) {
        void webview.postMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chatView.js'));
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
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
      height: 100vh;
      overflow: hidden;
    }
    #app { display: flex; flex-direction: row; height: 100vh; }
    #session-rail {
      width: 240px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      background: var(--vscode-sideBar-background);
      border-right: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
    }
    #rail-new-btn {
      margin: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      align-self: auto;
      width: calc(100% - 16px);
    }
    #rail-list { flex: 1; overflow-y: auto; }
    .rail-item {
      position: relative;
      padding: 8px 32px 8px 10px;
      cursor: pointer;
      border-bottom: 1px solid var(--vscode-widget-border, transparent);
    }
    .rail-item:hover { background: var(--vscode-list-hoverBackground); }
    .rail-item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .rail-item-title {
      font-size: 0.85em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rail-item.archived .rail-item-title { opacity: 0.6; font-style: italic; }
    .rail-item-meta {
      font-size: 0.72em;
      opacity: 0.7;
      margin-top: 2px;
    }
    .rail-item-actions {
      position: absolute;
      right: 6px;
      top: 8px;
      display: none;
      gap: 6px;
    }
    .rail-item:hover .rail-item-actions { display: flex; }
    .rail-item-actions .codicon { cursor: pointer; opacity: 0.75; font-size: 13px; }
    .rail-item-actions .codicon:hover { opacity: 1; }
    #main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      height: 100%;
    }
${CHAT_SHARED_CSS}
  </style>
</head>
<body>
  <div id="app">
    <div id="session-rail">
      <button id="rail-new-btn"><i class="codicon codicon-add"></i>New Chat</button>
      <div id="rail-list"></div>
    </div>
    <div id="main">${renderChatBodyHtml(actionButtons)}
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function showDagsterExpertChatPanel(
  context: vscode.ExtensionContext,
  store: AssetIndexStore,
  primitives: PrimitiveIndexStore,
  sessions: SessionManager,
  activeTarget: ActiveTargetStore,
  hasLocalProject: () => boolean
): void {
  DagsterExpertChatPanel.showOrReveal(context, store, primitives, sessions, activeTarget, hasLocalProject);
}

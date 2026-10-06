import * as vscode from 'vscode';
import { askDagsterExpert } from '../ai/dagsterExpert';
import { hasApiKey, setApiKey } from '../ai/llmClient';
import type { AssetIndexStore } from '../data/assetIndex';
import type { PrimitiveIndexStore } from '../data/primitiveIndex';
import type { SessionManager } from './sessionManager';
import { CHAT_SHARED_CSS, renderTabBodyHtml } from './chatStyles';

/** One entry per currently-open session tab -- NOT a singleton, since
 * the whole point is multiple sessions open as separate editor tabs at
 * once (Claude Code's own sidebar-list + separate-tabs split), each
 * permanently bound to the ONE session it was opened for. */
const openPanels = new Map<string, DagsterExpertChatPanel>();

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** A single session's conversation, as its own editor tab -- just the
 * title, messages, key banner, and input. No quick actions, no target
 * switch, no Dagster+ usage, no session rail: those stay exclusive to
 * the sidebar view, whose job is now purely picking which session's tab
 * to open. VS Code's own tab bar is what lets you flip between several
 * open sessions, so there's nothing to reproduce for that in here. */
export class DagsterExpertChatPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: AssetIndexStore,
    private readonly primitives: PrimitiveIndexStore,
    private readonly sessions: SessionManager,
    private readonly sessionId: string
  ) {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const title = this.sessions.getSession(this.sessionId)?.title ?? 'Dagster Expert';
    this.panel = vscode.window.createWebviewPanel(
      'dagsterPowerUser.chatPanel',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [mediaRoot], retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.renderHtml(this.panel.webview, mediaRoot);

    this.disposables.push(
      // Covers both an edit from elsewhere (e.g. an "ask Dagster Expert
      // about this error" flow appending to this same session) and this
      // session being archived/deleted out from under an open tab.
      this.sessions.onDidChange(() => this.syncState()),
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      // Whichever tab the user is actually looking at becomes the
      // "active" session for anything elsewhere that doesn't open its
      // own tab (quick actions' "ask about this" handoffs) -- keeps that
      // pre-existing behavior sensible now that several sessions can be
      // open at once.
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) void this.sessions.switchTo(this.sessionId);
      }),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  /** Opens a NEW tab for this session, or reveals its existing one --
   * never a second tab for the same session id. */
  static showOrReveal(
    context: vscode.ExtensionContext,
    store: AssetIndexStore,
    primitives: PrimitiveIndexStore,
    sessions: SessionManager,
    sessionId: string
  ): void {
    const existing = openPanels.get(sessionId);
    if (existing) {
      existing.panel.reveal();
      void sessions.switchTo(sessionId);
      return;
    }
    const instance = new DagsterExpertChatPanel(context, store, primitives, sessions, sessionId);
    openPanels.set(sessionId, instance);
    void sessions.switchTo(sessionId);
  }

  private dispose(): void {
    openPanels.delete(this.sessionId);
    for (const d of this.disposables) d.dispose();
  }

  private syncState(): void {
    const session = this.sessions.getSession(this.sessionId);
    if (!session) {
      // Deleted (or archived away) while this tab was open -- nothing
      // left to show.
      this.panel.dispose();
      return;
    }
    this.panel.title = session.title;
    void this.panel.webview.postMessage({ type: 'loadHistory', title: session.title, messages: session.messages });
  }

  private async onMessage(message: { type: string; question?: string }): Promise<void> {
    const webview = this.panel.webview;
    if (message.type === 'ready') {
      const ok = await hasApiKey(this.context);
      void webview.postMessage({ type: ok ? 'ready' : 'needsKey' });
      this.syncState();
      return;
    }
    if (message.type === 'setKey') {
      await setApiKey(this.context, 'anthropic');
      const ok = await hasApiKey(this.context);
      void webview.postMessage({ type: ok ? 'ready' : 'needsKey' });
      return;
    }
    if (message.type === 'ask' && message.question) {
      const question = message.question;
      try {
        const history = this.sessions.getSession(this.sessionId)?.messages ?? [];
        const answer = await askDagsterExpert(this.context, this.store, this.primitives, question, history);
        await this.sessions.appendMessageTo(this.sessionId, { role: 'user', content: question });
        await this.sessions.appendMessageTo(this.sessionId, { role: 'assistant', content: answer });
        void webview.postMessage({ type: 'answer', text: answer });
        this.syncState();
      } catch (e) {
        void webview.postMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chatTab.js'));
    const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicons', 'codicon.css'));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource};`;

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
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
${CHAT_SHARED_CSS}
  </style>
</head>
<body>${renderTabBodyHtml()}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function showDagsterExpertChatTab(
  context: vscode.ExtensionContext,
  store: AssetIndexStore,
  primitives: PrimitiveIndexStore,
  sessions: SessionManager,
  sessionId: string
): void {
  DagsterExpertChatPanel.showOrReveal(context, store, primitives, sessions, sessionId);
}

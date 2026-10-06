import * as vscode from 'vscode';
import { askDagsterExpert } from '../ai/dagsterExpert';
import { hasApiKey, setApiKey } from '../ai/llmClient';
import type { AssetIndexStore } from '../data/assetIndex';
import type { PrimitiveIndexStore } from '../data/primitiveIndex';
import type { SessionManager } from './sessionManager';
import { getDagsterPlusUsageSummary, type DagsterPlusUsageSummary } from '../data/dagsterPlusClient';
import { type ActiveTargetStore, describeTarget, pickTarget } from '../data/activeTarget';
import { CHAT_SHARED_CSS, renderFullChatBodyHtml } from './chatStyles';
import { sessionListMessage } from './sessionManager';

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** Pinned quick-action pills shown above the chat input -- kept to just
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
 * The sidebar chat view -- docked under the same Activity Bar icon as
 * Dagster Definitions, same idea as Claude Code's own panel. Plain
 * inline HTML/CSS styled off VS Code's own `--vscode-*` theme variables
 * (a simple message list + input box doesn't need a component
 * framework); client-side JS lives in media/chatView.js as a real file
 * referenced via `asWebviewUri`, NOT inlined into this TS template
 * literal -- an earlier version hand-escaped regex literals inside the
 * inline script and got the double-escaping wrong (verified live: every
 * character came out individually wrapped in `<em>` tags), which a
 * real, directly-executable .js file can't do since there's no second
 * layer of string-escaping to get wrong.
 */
export class DagsterExpertChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'dagsterPowerUser.chat';
  private view: vscode.WebviewView | undefined;
  private plusUsage: DagsterPlusUsageSummary | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: AssetIndexStore,
    private readonly primitives: PrimitiveIndexStore,
    private readonly sessions: SessionManager,
    private readonly activeTarget: ActiveTargetStore,
    private readonly hasLocalProject: () => boolean
  ) {
    // Sessions/target can both change from OUTSIDE this webview's own
    // messages (e.g. "New Chat"/"Chat History" run as real vscode
    // commands via the generic runCommand handler below, same as every
    // other quick action) -- resync whenever either does, not just
    // right after this view's own `ask`.
    this.sessions.onDidChange(() => this.syncState());
    this.activeTarget.onDidChange(() => this.syncState());
  }

  private syncState(): void {
    if (!this.view) return;
    const session = this.sessions.getActiveSession();
    void this.view.webview.postMessage({
      type: 'loadHistory',
      title: session.title,
      messages: session.messages,
    });
    void this.view.webview.postMessage({
      type: 'target',
      isLocal: this.activeTarget.get().kind === 'local',
      label: describeTarget(this.activeTarget.get()),
    });
    // Harmless no-op in this narrow sidebar view (no rail in its HTML to
    // render it into) -- posted anyway so the SAME client script works
    // unchanged in the editor-tab panel, which does have one.
    void this.view.webview.postMessage(sessionListMessage(this.sessions.listSessions(), session.id));
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
        question?: string;
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
        // Posted by the session rail -- only rendered in the editor-tab
        // panel's HTML today, but handled here too (harmless if nothing
        // ever sends them from this narrower sidebar view) so this view
        // doesn't quietly fall behind if a rail is ever added here too.
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
          void webviewView.webview.postMessage({ type: ok ? 'ready' : 'needsKey' });
          this.syncState();
          void this.refreshPlusUsage();
          return;
        }
        if (message.type === 'setKey') {
          await setApiKey(this.context, 'anthropic');
          const ok = await hasApiKey(this.context);
          void webviewView.webview.postMessage({ type: ok ? 'ready' : 'needsKey' });
          return;
        }
        if (message.type === 'runCommand' && message.command) {
          await vscode.commands.executeCommand(message.command);
          // "More Actions" just opens a picker -- nothing actually ran
          // yet, so there's nothing worth echoing into the transcript.
          if (message.command !== MORE_ACTIONS_COMMAND) {
            const action = QUICK_ACTIONS.find((a) => a.command === message.command);
            void webviewView.webview.postMessage({ type: 'commandRan', label: action?.label ?? message.command });
          } else {
            // The only place a Dagster+ credential change can come from
            // right now (it's a More Actions entry, not a pinned pill).
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
            void webviewView.webview.postMessage({ type: 'answer', text: answer });
            this.syncState();
          } catch (e) {
            void webviewView.webview.postMessage({
              type: 'error',
              text: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    );
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
<body>${renderFullChatBodyHtml(actionButtons)}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

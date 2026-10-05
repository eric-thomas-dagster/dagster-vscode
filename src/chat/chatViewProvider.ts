import * as vscode from 'vscode';
import { askDagsterExpert } from '../ai/dagsterExpert';
import { hasApiKey, setApiKey } from '../ai/llmClient';
import type { AssetIndexStore } from '../data/assetIndex';
import type { PrimitiveIndexStore } from '../data/primitiveIndex';
import type { SessionManager } from './sessionManager';
import { getDagsterPlusUsageSummary, type DagsterPlusUsageSummary } from '../data/dagsterPlusClient';
import { type ActiveTargetStore, describeTarget, pickTarget } from '../data/activeTarget';

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
const QUICK_ACTIONS: Array<{ command: string; label: string; icon: string }> = [
  { command: 'dagsterPowerUser.devServerMenu', label: 'Dev Server', icon: 'server-process' },
  { command: 'dagsterPowerUser.materializeAssetSearch', label: 'Materialize Asset', icon: 'play' },
  { command: 'dagsterPowerUser.launchJobSearch', label: 'Launch Job', icon: 'play-circle' },
  { command: 'dagsterPowerUser.showMoreActions', label: 'More Actions', icon: 'ellipsis' },
];

const MORE_ACTIONS_COMMAND = 'dagsterPowerUser.showMoreActions';

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
      async (message: { type: string; question?: string; command?: string; to?: 'local' | 'remote' }) => {
        if (message.type === 'switchTarget') {
          if (message.to === 'local') {
            await this.activeTarget.set({ kind: 'local' });
          } else {
            const picked = await pickTarget(this.context, this.hasLocalProject());
            if (picked) await this.activeTarget.set(picked);
          }
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
    * { box-sizing: border-box; }
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
    #quick-actions {
      flex-shrink: 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
    }
    .quick-action {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-badge-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-badge-foreground));
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 5px;
      padding: 5px 8px;
      font-size: 0.85em;
      text-align: left;
      cursor: pointer;
      align-self: stretch;
      width: 100%;
    }
    .quick-action .codicon { font-size: 14px; flex-shrink: 0; opacity: 0.9; }
    .quick-action span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .quick-action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .row { display: flex; flex-direction: column; max-width: 92%; }
    .row.user { align-self: flex-end; align-items: flex-end; }
    .row.assistant { align-self: flex-start; align-items: flex-start; }
    .label {
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
      padding: 0 2px;
    }
    .bubble {
      border-radius: 10px;
      padding: 6px 10px;
      line-height: 1.45;
      word-wrap: break-word;
    }
    .row.user .bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-bottom-right-radius: 2px;
    }
    .row.assistant .bubble {
      background: var(--vscode-editorWidget-background, var(--vscode-input-background));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-bottom-left-radius: 2px;
    }
    .bubble p { margin: 0 0 6px 0; }
    .bubble p:last-child { margin-bottom: 0; }
    .bubble ul { margin: 4px 0; padding-left: 18px; }
    .bubble a {
      color: var(--vscode-textLink-foreground);
      word-break: break-all;
    }
    .bubble a:hover { color: var(--vscode-textLink-activeForeground); }
    .bubble code {
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.2));
      border-radius: 3px;
      padding: 1px 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.95em;
    }
    .system-note {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 0.9em;
      padding: 2px 4px;
    }
    .error-note {
      color: var(--vscode-errorForeground);
      font-size: 0.9em;
      padding: 2px 4px;
    }
    .thinking {
      align-self: flex-start;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 0.9em;
      padding: 2px 4px;
    }
    #input-row {
      display: flex;
      gap: 4px;
      padding: 8px;
      border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
    }
    #input {
      flex: 1;
      resize: none;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: inherit;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 4px 12px;
      cursor: pointer;
      align-self: flex-end;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.5; cursor: default; }
    #key-banner { display: none; padding: 10px; }
    #session-header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
    }
    #session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #plus-usage {
      flex-shrink: 0;
      display: none;
      padding: 8px 10px;
      font-size: 0.78em;
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
    }
    #plus-usage.visible { display: block; }
    #plus-usage-cta, #plus-usage-bar, #plus-usage-link { display: none; }
    #plus-usage a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
    #plus-usage a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    #plus-usage .codicon { font-size: 13px; vertical-align: -2px; margin-right: 3px; }
    #plus-bar-caption { display: flex; justify-content: space-between; margin-top: 5px; color: var(--vscode-descriptionForeground); }
    .bar-track { height: 6px; border-radius: 4px; background: var(--vscode-input-background); overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; }
    .bar-fill.ok { background: var(--vscode-charts-green, #3fb950); }
    .bar-fill.warning { background: var(--vscode-charts-yellow, #d29922); }
    .bar-fill.danger { background: var(--vscode-charts-red, #f85149); }
    /* A real segmented control, not two independent buttons -- a filled
       "pill" wrapper with the selected segment getting the SAME solid
       button colors as the Send button elsewhere in this UI (unambiguous
       in every theme, unlike the previous subtle-background attempt).
       The active segment also drops :hover and the pointer cursor
       entirely, so it can't be mistaken for "still clickable". */
    #target-tabs {
      flex-shrink: 0;
      display: flex;
      gap: 2px;
      margin: 8px 10px 0;
      padding: 2px;
      background: var(--vscode-input-background);
      border-radius: 6px;
    }
    .target-tab {
      flex: 1;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: none;
      border-radius: 4px;
      padding: 5px 6px;
      font-size: 0.78em;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .target-tab:not(.active):hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
      color: var(--vscode-foreground);
    }
    .target-tab.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
      cursor: default;
    }
  </style>
</head>
<body>
  <div id="target-tabs">
    <button class="target-tab" id="target-local" title="Run against your local dev server">Local</button>
    <button class="target-tab" id="target-remote" title="Run against a remote Dagster OSS server or a Dagster+ deployment">Remote</button>
  </div>
  <div id="session-header">
    <span id="session-title">New session</span>
  </div>
  <div id="plus-usage">
    <div id="plus-usage-cta">
      <a data-run-command="dagsterPowerUser.setDagsterPlusCredentials"><i class="codicon codicon-plug"></i>Connect Dagster+</a>
    </div>
    <div id="plus-usage-bar">
      <div class="bar-track"><div id="plus-bar-fill" class="bar-fill ok" style="width:0%"></div></div>
      <div id="plus-bar-caption">
        <span id="plus-bar-text"></span>
        <a data-run-command="dagsterPowerUser.showDagsterPlusUsage">Details</a>
      </div>
    </div>
    <div id="plus-usage-link">
      <a data-run-command="dagsterPowerUser.showDagsterPlusUsage"><i class="codicon codicon-graph"></i>View Dagster+ usage</a>
    </div>
  </div>
  <div id="quick-actions">${actionButtons}</div>
  <div id="messages">
    <div class="system-note">Ask Dagster Expert about this project's assets, groups, and kinds -- or use a button above.</div>
  </div>
  <div id="key-banner">
    <div class="system-note">Set an Anthropic API key to start chatting.</div>
    <button id="set-key-btn">Set API Key</button>
  </div>
  <div id="input-row">
    <textarea id="input" rows="2" placeholder="Ask a question..."></textarea>
    <button id="send-btn">Send</button>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

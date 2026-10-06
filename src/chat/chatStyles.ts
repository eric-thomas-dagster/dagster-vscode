/** CSS shared by both chat hosts -- the sidebar WebviewView
 * (chatViewProvider.ts) and the editor-tab WebviewPanel (chatPanel.ts).
 * Deliberately excludes each host's own top-level layout rule (`body` and
 * whatever wraps the session-rail in the tab version) since those two
 * genuinely differ; everything else (bubbles, quick actions, target tabs,
 * Dagster+ usage bar) is identical and was a straight extraction from the
 * sidebar view's original inline <style> block, kept in one place so a
 * fix/tweak doesn't need to happen twice. */
export const CHAT_SHARED_CSS = `
    * { box-sizing: border-box; }
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
`;

/** The chat body markup shared by both hosts -- target tabs, session
 * header, Dagster+ usage, quick actions, message list, key banner, input
 * row. Identical in both; only what WRAPS it (plain <body> for the
 * sidebar, a #main column next to the session rail for the tab) differs. */
export function renderChatBodyHtml(actionButtonsHtml: string): string {
  return `
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
  <div id="quick-actions">${actionButtonsHtml}</div>
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
  </div>`;
}

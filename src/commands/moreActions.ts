import * as vscode from 'vscode';

interface ActionDef {
  command: string;
  label: string;
  icon: string;
  category: string;
}

/** Everything that isn't pinned as a chat-panel pill (see QUICK_ACTIONS in
 * chatViewProvider.ts) lives here instead, behind one "More Actions" pill
 * -- a flat row of a dozen+ buttons stopped scaling, and this mirrors how
 * VS Code's own toolbars overflow into a "..." menu. Add new commands
 * here by default; only promote something to a pinned pill if it's
 * genuinely used constantly. */
const MORE_ACTIONS: ActionDef[] = [
  { command: 'dagsterPowerUser.showAssetLineage', label: 'Asset Lineage', icon: 'type-hierarchy-sub', category: 'Project' },
  { command: 'dagsterPowerUser.runDgCheck', label: 'Run dg check', icon: 'checklist', category: 'Project' },
  { command: 'dagsterPowerUser.refreshAssetIndex', label: 'Refresh Index', icon: 'refresh', category: 'Project' },
  { command: 'dagsterPowerUser.scaffoldNewProject', label: 'New Project', icon: 'new-folder', category: 'Project' },
  { command: 'dagsterPowerUser.scaffoldGithubActions', label: 'Scaffold GitHub Actions', icon: 'github-action', category: 'Project' },
  { command: 'dagsterPowerUser.searchComponentCatalog', label: 'Component Catalog', icon: 'search', category: 'Catalog & Docs' },
  { command: 'dagsterPowerUser.searchDocs', label: 'Search Docs', icon: 'book', category: 'Catalog & Docs' },
  { command: 'dagsterPowerUser.newChatSession', label: 'New Chat', icon: 'add', category: 'Sessions' },
  { command: 'dagsterPowerUser.showChatHistory', label: 'Chat History', icon: 'history', category: 'Sessions' },
  { command: 'dagsterPowerUser.showDagsterPlusUsage', label: 'Dagster+ Usage', icon: 'graph', category: 'Dagster+' },
  { command: 'dagsterPowerUser.setDagsterPlusCredentials', label: 'Connect Dagster+...', icon: 'plug', category: 'Dagster+' },
  { command: 'dagsterPowerUser.manageAutomations', label: 'Manage Schedules & Sensors', icon: 'debug-start', category: 'Automations' },
  { command: 'dagsterPowerUser.showRunExplorer', label: 'Show Runs', icon: 'history', category: 'Runs' },
  { command: 'dagsterPowerUser.setupDagsterPlusMcp', label: 'Set Up Dagster+ MCP Server', icon: 'plug', category: 'Dagster+' },
  { command: 'dagsterPowerUser.switchTarget', label: 'Switch Target (Local / Remote)...', icon: 'arrow-swap', category: 'Target' },
];

interface ActionQuickPickItem extends vscode.QuickPickItem {
  command?: string;
}

export function registerMoreActionsCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.showMoreActions', async () => {
      const items: ActionQuickPickItem[] = [];
      let lastCategory = '';
      for (const a of MORE_ACTIONS) {
        if (a.category !== lastCategory) {
          items.push({ label: a.category, kind: vscode.QuickPickItemKind.Separator });
          lastCategory = a.category;
        }
        items.push({ label: `$(${a.icon}) ${a.label}`, command: a.command });
      }
      const picked = await vscode.window.showQuickPick(items, { title: 'Dagster: More Actions' });
      if (picked?.command) await vscode.commands.executeCommand(picked.command);
    })
  );
}

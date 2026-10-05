import * as vscode from 'vscode';

/**
 * Writes/merges `.vscode/mcp.json` to point at Dagster+'s own HOSTED MCP
 * server -- confirmed live (see mcp_strategy notes): it's a real,
 * OAuth-protected MCP resource (401 + WWW-Authenticate pointing at
 * `https://dagster.cloud` as the authorization server, scope
 * `dagster.mcp`, confirmed via its `.well-known/oauth-protected-resource`
 * metadata). VS Code's own MCP client handles that OAuth/browser flow
 * itself for a `"type": "http"` server entry -- this file only needs to
 * write the URL, never a token.
 *
 * Deliberately NOT building our own MCP server here: the hosted one
 * already covers runs/assets/deployments/alerts/issues for Dagster+ (see
 * the MCP gap-analysis memory) -- this just wires existing editors
 * (Claude Code, Cursor, Copilot Chat) up to it with one click instead of
 * requiring everyone to hand-edit `.vscode/mcp.json` themselves.
 */

const SERVER_NAME = 'dagster-plus';
const SERVER_URL = 'https://mcp.agent.dagster.cloud/mcp';
const SERVER_URL_EU = 'https://mcp.agent.eu.dagster.cloud/mcp';

interface McpServerEntry {
  type: string;
  url: string;
  [key: string]: unknown;
}

interface McpConfig {
  servers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export async function setupDagsterPlusMcp(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('Dagster: open a workspace folder first.');
    return;
  }

  const region = await vscode.window.showQuickPick(
    [
      { label: 'US', description: SERVER_URL, url: SERVER_URL },
      { label: 'EU', description: SERVER_URL_EU, url: SERVER_URL_EU },
    ],
    { title: 'Dagster+ MCP Server Region' }
  );
  if (!region) return;

  const mcpUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'mcp.json');
  let config: McpConfig = {};

  try {
    const bytes = await vscode.workspace.fs.readFile(mcpUri);
    const text = Buffer.from(bytes).toString('utf-8');
    try {
      config = JSON.parse(text) as McpConfig;
    } catch {
      // Malformed existing file -- back it up rather than silently
      // clobbering whatever the user had, then start fresh.
      const bakUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'mcp.json.bak');
      await vscode.workspace.fs.writeFile(bakUri, bytes);
      vscode.window.showWarningMessage(
        'Dagster: existing .vscode/mcp.json was not valid JSON -- backed it up to mcp.json.bak and starting fresh.'
      );
      config = {};
    }
  } catch {
    // No existing file -- that's fine, we create one.
  }

  config.servers = {
    ...config.servers,
    [SERVER_NAME]: { type: 'http', url: region.url },
  };

  const vscodeDir = vscode.Uri.joinPath(folder.uri, '.vscode');
  try {
    await vscode.workspace.fs.createDirectory(vscodeDir);
  } catch {
    // Already exists -- fine.
  }
  await vscode.workspace.fs.writeFile(mcpUri, Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf-8'));

  vscode.window.showInformationMessage(
    `Dagster: wrote "${SERVER_NAME}" to .vscode/mcp.json. Open the MCP view (or ask your AI assistant to list tools) to complete sign-in -- it'll open your browser for Dagster+ auth the first time.`
  );
}

export function registerMcpConfigCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.setupDagsterPlusMcp', () => setupDagsterPlusMcp())
  );
}

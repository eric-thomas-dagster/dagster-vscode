import * as vscode from 'vscode';
import { detectAllProjects, DagsterProject } from './projectDetection';
import { showAssetLineagePanel } from './webviews/lineagePanel';
import { DevServerStatus, registerDevServerCommands } from './statusBar/devServerStatus';
import {
  reloadAllRepositoryLocations,
  startSchedule,
  stopSchedule,
  startSensor,
  stopSensor,
  fetchAssetGraph,
  fetchPrimitives,
  fetchRunLogs,
} from './data/graphqlClient';
import type { PrimitiveRefInfo } from './data/primitiveIndex';
import { askDagsterExpert } from './ai/dagsterExpert';
import { AssetIndexStore } from './data/assetIndex';
import { PrimitiveIndexStore } from './data/primitiveIndex';
import { registerAssetHoverProvider } from './language/hoverProvider';
import { registerAssetDefinitionProvider } from './language/definitionProvider';
import { registerAssetRefDiagnostics } from './diagnostics/assetRefDiagnostics';
import { registerDgCheckDiagnostics, DgCheckDiagnostics } from './diagnostics/dgCheckDiagnostics';
import { registerProjectComponentsView } from './views/projectComponentsProvider';
import { DagsterExpertChatViewProvider } from './chat/chatViewProvider';
import { setApiKey } from './ai/llmClient';
import { scaffoldNewProject } from './commands/scaffoldProject';
import { registerComponentCatalogView } from './views/componentCatalogProvider';
import { materializeAsset, launchJob } from './commands/launchRun';
import { registerSearchDocsCommand } from './commands/searchDocs';
import { scaffoldGithubActions } from './commands/scaffoldGithubActions';
import { SessionManager } from './chat/sessionManager';
import { registerChatHistoryCommands } from './commands/chatHistory';
import { registerMoreActionsCommand } from './commands/moreActions';
import { initUsageTracker } from './ai/usageTracker';
import { setDagsterPlusCredentials } from './data/dagsterPlusClient';
import { showDagsterPlusUsagePanel } from './webviews/dagsterPlusUsagePanel';
import { registerFixCodeActionProvider } from './diagnostics/fixCodeActionProvider';
import { registerFixDiagnosticCommand } from './commands/fixDiagnostic';
import { registerManageAutomationsCommand } from './commands/manageAutomations';
import { registerMcpConfigCommand } from './mcp/mcpConfigWriter';
import { ActiveTargetStore, pickTarget, resolveEndpoint } from './data/activeTarget';
import { showRunExplorerPanel } from './webviews/runExplorerPanel';
import { registerLanguageModelTools } from './lm/tools';

let projects = new Map<string, DagsterProject>();
let output: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let devServerStatus: DevServerStatus;
let assetIndexStore: AssetIndexStore;
let primitiveIndexStore: PrimitiveIndexStore;
let dgCheckDiagnostics: DgCheckDiagnostics;
let activeTargetStore: ActiveTargetStore;

/** First dg-CLI-resolved project -- same "primary project" notion
 * DevServerStatus uses, shared here rather than re-detected. */
function getPrimaryProject(): DagsterProject | undefined {
  return [...projects.values()].find((p) => p.detectionMethod === 'dg-cli');
}

function summarize(p: DagsterProject): string {
  const method =
    p.detectionMethod === 'dg-cli' ? `dg ${p.dgVersion}` :
    p.detectionMethod === 'heuristic' ? 'heuristic match (no dg CLI resolved)' :
    'no Dagster project detected';
  const dbt = p.dbtProjectPaths.length ? `, ${p.dbtProjectPaths.length} dbt project(s)` : '';
  return `${p.folder.name}: ${method}${dbt}`;
}

function updateStatusBar() {
  const detected = [...projects.values()].filter((p) => p.detectionMethod !== 'none');
  if (detected.length === 0) {
    statusBarItem.text = '$(circle-slash) Dagster: none detected';
  } else {
    statusBarItem.text = `$(target) Dagster: ${detected.length} project${detected.length === 1 ? '' : 's'}`;
  }
  statusBarItem.tooltip = detected.length
    ? detected.map(summarize).join('\n')
    : 'No workspace folder looks like a Dagster project yet.';
  statusBarItem.show();
}

async function runDetection() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  statusBarItem.text = '$(sync~spin) Dagster: detecting…';
  statusBarItem.tooltip = 'Scanning workspace folder(s) for a Dagster project...';
  statusBarItem.show();
  output.appendLine(`[detect] scanning ${folders.length} workspace folder(s)...`);
  try {
    projects = await detectAllProjects(folders);
    for (const p of projects.values()) {
      output.appendLine(`[detect] ${summarize(p)}`);
    }
  } catch (e) {
    output.appendLine(`[detect] failed: ${e}`);
  }
  updateStatusBar();
  devServerStatus.setProjects(projects.values());
  if (getPrimaryProject()) void dgCheckDiagnostics.run();
}

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Dagster Power User');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'dagsterPowerUser.showDetectedProjects';
  context.subscriptions.push(output, statusBarItem);

  devServerStatus = new DevServerStatus(context);
  context.subscriptions.push(devServerStatus);
  registerDevServerCommands(context, devServerStatus);

  assetIndexStore = new AssetIndexStore();
  context.subscriptions.push(assetIndexStore);
  primitiveIndexStore = new PrimitiveIndexStore();
  context.subscriptions.push(primitiveIndexStore);
  registerAssetHoverProvider(context, assetIndexStore, primitiveIndexStore);
  const definitionResolver = registerAssetDefinitionProvider(context, assetIndexStore, primitiveIndexStore);
  registerAssetRefDiagnostics(context, assetIndexStore);
  registerProjectComponentsView(context, assetIndexStore, primitiveIndexStore, definitionResolver, () => devServerStatus.getGraphqlUrl());

  // Primitives refresh AFTER assets (not in parallel) -- filtering out
  // asset-backing ops needs the asset index already populated.
  async function refreshIndexes(): Promise<void> {
    const url = devServerStatus.getGraphqlUrl();
    await assetIndexStore.refresh(url);
    await primitiveIndexStore.refresh(url, new Set(assetIndexStore.getIndex().keys()));
  }

  // After installing a community component, `dg dev` doesn't necessarily
  // notice the new file on its own -- force a reload, THEN refresh our
  // own indexes once the server has actually re-imported it.
  async function reloadAndRefresh(): Promise<void> {
    await reloadAllRepositoryLocations(devServerStatus.getGraphqlUrl());
    await refreshIndexes();
  }

  registerComponentCatalogView(context, getPrimaryProject, reloadAndRefresh);
  registerSearchDocsCommand(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.scaffoldGithubActions', () => {
      const project = getPrimaryProject();
      if (!project) {
        vscode.window.showWarningMessage('Dagster: no dg-detected project to scaffold into.');
        return;
      }
      scaffoldGithubActions(project);
    })
  );

  initUsageTracker(context);
  const sessionManager = new SessionManager(context);
  context.subscriptions.push(sessionManager);
  registerChatHistoryCommands(context, sessionManager);
  registerMoreActionsCommand(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.setDagsterPlusCredentials', () => setDagsterPlusCredentials(context)),
    vscode.commands.registerCommand('dagsterPowerUser.showDagsterPlusUsage', () => showDagsterPlusUsagePanel(context))
  );
  registerFixCodeActionProvider(context);
  registerFixDiagnosticCommand(context);
  registerManageAutomationsCommand(context, () => (getPrimaryProject() ? devServerStatus.getGraphqlUrl() : undefined));
  registerMcpConfigCommand(context);

  activeTargetStore = new ActiveTargetStore(context);
  context.subscriptions.push(activeTargetStore);
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.switchTarget', async () => {
      const picked = await pickTarget(context, !!getPrimaryProject());
      if (picked) await activeTargetStore.set(picked);
    }),
    vscode.commands.registerCommand('dagsterPowerUser.showRunExplorer', () =>
      showRunExplorerPanel(context, activeTargetStore, () => (getPrimaryProject() ? devServerStatus.getGraphqlUrl() : undefined))
    )
  );

  registerLanguageModelTools(context, activeTargetStore, () => (getPrimaryProject() ? devServerStatus.getGraphqlUrl() : undefined));

  async function toggleAutomationFromTree(treeItem: { info?: PrimitiveRefInfo }, target: 'start' | 'stop'): Promise<void> {
    const info = treeItem?.info;
    if (!info?.id || !info.repositoryName || !info.repositoryLocationName) return;
    const url = devServerStatus.getGraphqlUrl();
    const selector = { repositoryName: info.repositoryName, repositoryLocationName: info.repositoryLocationName, name: info.name };
    try {
      if (target === 'stop') {
        await (info.kind === 'schedule' ? stopSchedule(url, info.id) : stopSensor(url, info.id));
      } else {
        await (info.kind === 'schedule' ? startSchedule(url, selector) : startSensor(url, selector));
      }
      await refreshIndexes();
    } catch (e) {
      vscode.window.showErrorMessage(`Dagster: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.startAutomationFromTree', (treeItem: { info?: PrimitiveRefInfo }) =>
      toggleAutomationFromTree(treeItem, 'start')
    ),
    vscode.commands.registerCommand('dagsterPowerUser.stopAutomationFromTree', (treeItem: { info?: PrimitiveRefInfo }) =>
      toggleAutomationFromTree(treeItem, 'stop')
    )
  );

  /** Shared by anything that wants to hand a real error/failure straight
   * to Dagster Expert as a conversation (not a file-localized Quick Fix)
   * -- focuses the chat view, asks, and appends both sides to the active
   * session so it shows up there like any other exchange. */
  async function askDagsterExpertAbout(question: string): Promise<void> {
    await vscode.commands.executeCommand('dagsterPowerUser.chat.focus');
    try {
      const history = sessionManager.getActiveSession().messages;
      const answer = await askDagsterExpert(context, assetIndexStore, primitiveIndexStore, question, history);
      await sessionManager.appendMessage({ role: 'user', content: question });
      await sessionManager.appendMessage({ role: 'assistant', content: answer });
    } catch (e) {
      vscode.window.showErrorMessage(`Dagster Expert: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.showLoadError', async (errorText: string) => {
      const choice = await vscode.window.showErrorMessage(
        `Dagster: ${errorText.split('\n')[0]}`,
        'Ask Dagster Expert',
        'Copy Full Error'
      );
      if (choice === 'Copy Full Error') {
        await vscode.env.clipboard.writeText(errorText);
      } else if (choice === 'Ask Dagster Expert') {
        await askDagsterExpertAbout(
          `My project's definitions failed to load. Here's the real error:\n\n${errorText}\n\nWhat's likely wrong, and how do I fix it?`
        );
      }
    }),
    vscode.commands.registerCommand('dagsterPowerUser.analyzeRunFailure', async (runId: string) => {
      const target = activeTargetStore.get();
      const localUrl = getPrimaryProject() ? devServerStatus.getGraphqlUrl() : '';
      const endpoint = await resolveEndpoint(context, target, localUrl);
      if (!endpoint) {
        vscode.window.showWarningMessage('Dagster: no target connected to analyze this run.');
        return;
      }

      let logs;
      try {
        logs = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Dagster: loading failure details...' },
          () => fetchRunLogs(endpoint, runId, 300)
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Dagster: couldn't load logs (${e instanceof Error ? e.message : String(e)}).`);
        return;
      }

      // Real Dagster failure events embed the full Python traceback in
      // their own message -- confirmed live via logsForRun -- so
      // filtering to error-level/failure-typed entries and joining their
      // messages reconstructs the traceback without needing raw stdout.
      const failureEntries = logs.filter(
        (l) => /FAILURE/i.test(l.eventType ?? '') || l.level === 'ERROR' || l.level === 'CRITICAL'
      );
      const failureText = (failureEntries.length ? failureEntries : logs)
        .map((l) => l.message)
        .filter(Boolean)
        .join('\n\n');
      if (!failureText.trim()) {
        vscode.window.showInformationMessage("Dagster: no failure details found in this run's logs.");
        return;
      }

      // Same "last File \"...\", line N wins" rule as dg check's own
      // traceback parsing -- Dagster hides its own internal frames and
      // only prints the user's, so the last match is the real offender.
      const fileLineMatches = [...failureText.matchAll(/File "([^"]+)", line (\d+)/g)];
      const lastMatch = fileLineMatches[fileLineMatches.length - 1];

      if (lastMatch) {
        const uri = vscode.Uri.file(lastMatch[1]);
        const line = Math.max(0, parseInt(lastMatch[2], 10) - 1);
        try {
          await vscode.workspace.fs.stat(uri);
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(line, 0, line, 1000),
            failureText.split('\n').slice(0, 20).join('\n'),
            vscode.DiagnosticSeverity.Error
          );
          // Reuses the exact same suggest-a-fix + diff-preview + Apply/
          // Discard flow as the dg check Quick Fix lightbulb -- no
          // separate implementation needed for "a run failed" vs. "dg
          // check found an error".
          await vscode.commands.executeCommand('dagsterPowerUser.fixDiagnosticWithAi', uri, diagnostic);
          return;
        } catch {
          // The file the traceback points at isn't on disk here (e.g.
          // targeting a remote/Dagster+ deployment whose code isn't
          // checked out in this workspace) -- fall through to chat.
        }
      }

      await askDagsterExpertAbout(
        `A Dagster run just failed. Here are the real failure details from its logs:\n\n${failureText.slice(0, 4000)}\n\nWhat's likely wrong, and how do I fix it?`
      );
    })
  );

  const chatProvider = new DagsterExpertChatViewProvider(
    context,
    assetIndexStore,
    primitiveIndexStore,
    sessionManager,
    activeTargetStore,
    () => !!getPrimaryProject()
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DagsterExpertChatViewProvider.viewType, chatProvider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.setAnthropicApiKey', () => setApiKey(context, 'anthropic')),
    vscode.commands.registerCommand('dagsterPowerUser.setOpenAiApiKey', () => setApiKey(context, 'openai'))
  );
  context.subscriptions.push(
    devServerStatus.onDidChangeRunning((running) => {
      if (running) void refreshIndexes();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.refreshAssetIndex', async () => {
      await refreshIndexes();
      vscode.window.showInformationMessage(
        `Dagster: index refreshed (${assetIndexStore.getIndex().size} assets, ${primitiveIndexStore.getIndex().size} jobs/schedules/sensors/ops).`
      );
    })
  );

  dgCheckDiagnostics = registerDgCheckDiagnostics(
    context,
    () => getPrimaryProject()?.dgPath ?? null,
    () => getPrimaryProject()?.folder.uri.fsPath ?? null,
    output
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.refreshProjectDetection', async () => {
      await runDetection();
      vscode.window.showInformationMessage('Dagster: project detection refreshed.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.showDetectedProjects', async () => {
      const items: vscode.QuickPickItem[] = [...projects.values()].map((p) => ({
        label: p.folder.name,
        description:
          p.detectionMethod === 'dg-cli' ? `dg ${p.dgVersion}` :
          p.detectionMethod === 'heuristic' ? 'heuristic match' :
          'not detected',
        detail: p.dbtProjectPaths.length ? `dbt projects: ${p.dbtProjectPaths.join(', ')}` : undefined,
      }));
      if (items.length === 0) {
        vscode.window.showInformationMessage('No workspace folders open.');
        return;
      }
      await vscode.window.showQuickPick(items, {
        title: 'Detected Dagster Projects',
        placeHolder: 'Per-folder detection results (see "Dagster Power User" output channel for detail)',
      });
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void runDetection();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.scaffoldNewProject', () => scaffoldNewProject())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.showAssetLineage', () => {
      void showAssetLineagePanel(context, devServerStatus.getGraphqlUrl(), () => dgCheckDiagnostics.run());
    })
  );

  // The tree's inline context-menu button passes the TreeItem itself
  // (e.g. `{ info: { key: ... } }` for an asset row), not a bare string --
  // but the same command is also invoked directly with a plain string
  // from the chat's QuickPick-driven search flow below, so accept both.
  function extractKeyOrName(arg: unknown): string | undefined {
    if (typeof arg === 'string') return arg;
    const info = (arg as { info?: { key?: string; name?: string } } | undefined)?.info;
    return info?.key ?? info?.name;
  }

  // The Project Components TREE only ever reflects the LOCAL dev
  // server's index -- an inline play button there sending a locally-
  // sourced key to a remote/Dagster+ target would silently materialize
  // whatever that key happens to also mean over there (or nothing, or
  // the wrong thing), so these two stay local-only and just tell you to
  // switch targets instead. The search-based commands below this one
  // (materializeAssetSearch/launchJobSearch) DO browse the real remote
  // asset/job graph when the target isn't local.
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.materializeAssetFromTree', (arg: unknown) => {
      const assetKey = extractKeyOrName(arg);
      const target = activeTargetStore.get();
      const project = getPrimaryProject();
      if (target.kind !== 'local') {
        vscode.window.showWarningMessage('Dagster: switch to the Local target to materialize from this tree (it only reflects your local project).');
        return;
      }
      if (!assetKey || !project) {
        vscode.window.showWarningMessage('Dagster: no dg-detected project to materialize against.');
        return;
      }
      void materializeAsset(assetKey, project, context, target, devServerStatus.getGraphqlUrl());
    }),
    vscode.commands.registerCommand('dagsterPowerUser.launchJobFromTree', (arg: unknown) => {
      const jobName = extractKeyOrName(arg);
      const target = activeTargetStore.get();
      const project = getPrimaryProject();
      if (target.kind !== 'local') {
        vscode.window.showWarningMessage('Dagster: switch to the Local target to launch from this tree (it only reflects your local project).');
        return;
      }
      if (!jobName || !project) {
        vscode.window.showWarningMessage('Dagster: no dg-detected project to launch against.');
        return;
      }
      void launchJob(jobName, project, context, target, devServerStatus.getGraphqlUrl());
    })
  );

  /** Local keeps using the already-cached index (instant, no network
   * call). Remote/Dagster+ have no local index to read -- browsing them
   * means a real fresh fetch against the resolved endpoint, so this
   * always reflects THAT target's actual asset graph instead of silently
   * reusing the local one and hoping the names line up. */
  async function pickRemoteAssetKey(target: Exclude<ReturnType<typeof activeTargetStore.get>, { kind: 'local' }>): Promise<string | undefined> {
    const endpoint = await resolveEndpoint(context, target, '');
    if (!endpoint) {
      vscode.window.showWarningMessage('Dagster: no Dagster+ credentials connected for this target.');
      return undefined;
    }
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Dagster: loading remote asset graph...' },
      () => fetchAssetGraph(endpoint.url, endpoint.headers)
    );
    const keys = [...new Set(summary.nodes.map((n) => n.assetKey))];
    return vscode.window.showQuickPick(keys, {
      title: `Materialize which asset? (${target.kind === 'remote' ? target.url : `Dagster+: ${target.deployment}`})`,
    });
  }

  async function pickRemoteJobName(target: Exclude<ReturnType<typeof activeTargetStore.get>, { kind: 'local' }>): Promise<string | undefined> {
    const endpoint = await resolveEndpoint(context, target, '');
    if (!endpoint) {
      vscode.window.showWarningMessage('Dagster: no Dagster+ credentials connected for this target.');
      return undefined;
    }
    const jobs = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Dagster: loading remote jobs...' },
      () => fetchPrimitives(endpoint.url, new Set(), endpoint.headers)
    );
    const names = jobs.filter((p) => p.kind === 'job').map((p) => p.name);
    return vscode.window.showQuickPick(names, { title: `Launch which job? (${target.kind === 'remote' ? target.url : `Dagster+: ${target.deployment}`})` });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.materializeAssetSearch', async () => {
      const target = activeTargetStore.get();
      const project = getPrimaryProject();
      if (target.kind === 'local' && !project) {
        vscode.window.showWarningMessage('Dagster: no dg-detected project to materialize against.');
        return;
      }
      let picked: string | undefined;
      if (target.kind === 'local') {
        const seen = new Set<string>();
        const keys = [...assetIndexStore.getIndex().values()].map((i) => i.key).filter((k) => !seen.has(k) && seen.add(k));
        picked = await vscode.window.showQuickPick(keys, { title: 'Materialize which asset?' });
      } else {
        try {
          picked = await pickRemoteAssetKey(target);
        } catch (e) {
          vscode.window.showErrorMessage(`Dagster: couldn't load remote assets (${e instanceof Error ? e.message : String(e)}).`);
          return;
        }
      }
      if (picked) void materializeAsset(picked, project, context, target, devServerStatus.getGraphqlUrl());
    }),
    vscode.commands.registerCommand('dagsterPowerUser.launchJobSearch', async () => {
      const target = activeTargetStore.get();
      const project = getPrimaryProject();
      if (target.kind === 'local' && !project) {
        vscode.window.showWarningMessage('Dagster: no dg-detected project to launch against.');
        return;
      }
      let picked: string | undefined;
      if (target.kind === 'local') {
        const jobs = [...primitiveIndexStore.getIndex().values()].filter((p) => p.kind === 'job').map((p) => p.name);
        picked = await vscode.window.showQuickPick(jobs, { title: 'Launch which job?' });
      } else {
        try {
          picked = await pickRemoteJobName(target);
        } catch (e) {
          vscode.window.showErrorMessage(`Dagster: couldn't load remote jobs (${e instanceof Error ? e.message : String(e)}).`);
          return;
        }
      }
      if (picked) void launchJob(picked, project, context, target, devServerStatus.getGraphqlUrl());
    })
  );

  // Fire-and-forget: `activate()` must return quickly so VS Code doesn't
  // consider the extension unresponsive. `dg` subprocess probing (and
  // waiting on the Python extension's own activation, if installed) can
  // legitimately take many seconds across a multi-root workspace --
  // running it inline here previously blocked activation long enough to
  // look like a hang/crash.
  void runDetection();
}

export function deactivate() {
  // Nothing to tear down yet -- status bar item / output channel are
  // disposed automatically via context.subscriptions.
}

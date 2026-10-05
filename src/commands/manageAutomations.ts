import * as vscode from 'vscode';
import {
  fetchAutomations,
  startSchedule,
  startSensor,
  stopSchedule,
  stopSensor,
  type AutomationItem,
} from '../data/graphqlClient';
import {
  getDagsterPlusCredentials,
  hasDagsterPlusCredentials,
  listDagsterPlusDeployments,
  fetchDagsterPlusAutomations,
  startDagsterPlusSchedule,
  startDagsterPlusSensor,
  stopDagsterPlusSchedule,
  stopDagsterPlusSensor,
  type DagsterPlusCredentials,
} from '../data/dagsterPlusClient';

/** Either "the local dev server at this URL" or "this Dagster+
 * deployment" -- same AutomationItem shape either way, only the
 * start/stop calls differ, so the QuickPick logic below doesn't need to
 * know which one it's looking at beyond this. */
type Target =
  | { kind: 'local'; graphqlUrl: string }
  | { kind: 'plus'; creds: DagsterPlusCredentials; deployment: string };

async function fetchItems(target: Target): Promise<AutomationItem[]> {
  return target.kind === 'local'
    ? fetchAutomations(target.graphqlUrl)
    : fetchDagsterPlusAutomations(target.creds, target.deployment);
}

async function start(target: Target, item: AutomationItem): Promise<void> {
  const selector = { repositoryName: item.repositoryName, repositoryLocationName: item.repositoryLocationName, name: item.name };
  if (item.kind === 'schedule') {
    await (target.kind === 'local' ? startSchedule(target.graphqlUrl, selector) : startDagsterPlusSchedule(target.creds, target.deployment, selector));
  } else {
    await (target.kind === 'local' ? startSensor(target.graphqlUrl, selector) : startDagsterPlusSensor(target.creds, target.deployment, selector));
  }
}

async function stop(target: Target, item: AutomationItem): Promise<void> {
  if (item.kind === 'schedule') {
    await (target.kind === 'local' ? stopSchedule(target.graphqlUrl, item.id) : stopDagsterPlusSchedule(target.creds, target.deployment, item.id));
  } else {
    await (target.kind === 'local' ? stopSensor(target.graphqlUrl, item.id) : stopDagsterPlusSensor(target.creds, target.deployment, item.id));
  }
}

interface AutomationQuickPickItem extends vscode.QuickPickItem {
  item: AutomationItem;
}

const RUN_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('debug-start'), tooltip: 'Start' };
const STOP_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('debug-pause'), tooltip: 'Stop' };
const START_ALL_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('run-all'), tooltip: 'Start All Stopped' };
const REFRESH_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh' };

function buildItems(items: AutomationItem[]): AutomationQuickPickItem[] {
  const result: AutomationQuickPickItem[] = [];
  let lastKind: string | undefined;
  for (const item of [...items].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
    if (item.kind !== lastKind) {
      result.push({ label: item.kind === 'schedule' ? 'Schedules' : 'Sensors', kind: vscode.QuickPickItemKind.Separator, item });
      lastKind = item.kind;
    }
    const statusDot = item.status === 'RUNNING' ? '●' : '○';
    result.push({
      label: `${statusDot} ${item.name}`,
      description: item.cronSchedule ?? undefined,
      detail: item.description ?? undefined,
      buttons: [item.status === 'RUNNING' ? STOP_BUTTON : RUN_BUTTON],
      item,
    });
  }
  return result;
}

async function pickTarget(context: vscode.ExtensionContext, localGraphqlUrl: string | undefined): Promise<Target | undefined> {
  const connected = await hasDagsterPlusCredentials(context);
  if (!connected) {
    if (!localGraphqlUrl) {
      vscode.window.showWarningMessage('Dagster: no dg-detected project and no Dagster+ connection to manage automations against.');
      return undefined;
    }
    return { kind: 'local', graphqlUrl: localGraphqlUrl };
  }

  const creds = (await getDagsterPlusCredentials(context))!;
  let deployments: Array<{ name: string; type: string }>;
  try {
    deployments = await listDagsterPlusDeployments(creds);
  } catch (e) {
    vscode.window.showErrorMessage(`Dagster: couldn't list Dagster+ deployments (${e instanceof Error ? e.message : String(e)}).`);
    deployments = [];
  }

  const options: Array<vscode.QuickPickItem & { target: Target }> = [];
  if (localGraphqlUrl) {
    options.push({ label: '$(server-process) Local dev server', target: { kind: 'local', graphqlUrl: localGraphqlUrl } });
  }
  for (const d of deployments) {
    options.push({
      label: `$(cloud) Dagster+: ${d.name}`,
      description: d.type === 'BRANCH' ? 'branch deployment' : undefined,
      target: { kind: 'plus', creds, deployment: d.name },
    });
  }
  if (options.length === 1) return options[0].target;

  const picked = await vscode.window.showQuickPick(options, { title: 'Manage Automations -- Where?' });
  return picked?.target;
}

async function runManageAutomations(context: vscode.ExtensionContext, localGraphqlUrl: string | undefined): Promise<void> {
  const target = await pickTarget(context, localGraphqlUrl);
  if (!target) return;

  const qp = vscode.window.createQuickPick<AutomationQuickPickItem>();
  qp.title = 'Dagster: Manage Schedules & Sensors';
  qp.placeholder = 'Click the play/pause icon to start or stop -- selecting an item does nothing';
  qp.buttons = [START_ALL_BUTTON, REFRESH_BUTTON];
  qp.busy = true;
  qp.show();

  let items: AutomationItem[] = [];
  const reload = async () => {
    qp.busy = true;
    try {
      items = await fetchItems(target);
      qp.items = buildItems(items);
      if (items.length === 0) qp.placeholder = 'No schedules or sensors found here.';
    } catch (e) {
      vscode.window.showErrorMessage(`Dagster: couldn't load automations (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      qp.busy = false;
    }
  };

  qp.onDidTriggerButton(async (button) => {
    if (button === REFRESH_BUTTON) {
      await reload();
      return;
    }
    if (button === START_ALL_BUTTON) {
      const stopped = items.filter((i) => i.status === 'STOPPED');
      if (stopped.length === 0) return;
      qp.busy = true;
      let failures = 0;
      for (const item of stopped) {
        try {
          await start(target, item);
        } catch {
          failures += 1;
        }
      }
      vscode.window.showInformationMessage(
        failures === 0
          ? `Dagster: started ${stopped.length} stopped schedule(s)/sensor(s).`
          : `Dagster: started ${stopped.length - failures}/${stopped.length} (${failures} failed).`
      );
      await reload();
    }
  });

  qp.onDidTriggerItemButton(async (e) => {
    qp.busy = true;
    try {
      if (e.button === RUN_BUTTON) {
        await start(target, e.item.item);
      } else {
        await stop(target, e.item.item);
      }
      await reload();
    } catch (err) {
      vscode.window.showErrorMessage(`Dagster: ${err instanceof Error ? err.message : String(err)}`);
      qp.busy = false;
    }
  });

  qp.onDidHide(() => qp.dispose());
  await reload();
}

export function registerManageAutomationsCommand(
  context: vscode.ExtensionContext,
  getLocalGraphqlUrl: () => string | undefined
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.manageAutomations', () =>
      runManageAutomations(context, getLocalGraphqlUrl())
    )
  );
}

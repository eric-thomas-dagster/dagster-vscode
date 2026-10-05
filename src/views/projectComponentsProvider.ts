import * as vscode from 'vscode';
import type { AssetIndexStore, AssetRefInfo } from '../data/assetIndex';
import type { PrimitiveIndexStore, PrimitiveRefInfo } from '../data/primitiveIndex';
import type { AssetDefinitionResolver } from '../language/definitionProvider';
import { deriveWebBaseUrl } from '../data/graphqlClient';

/**
 * Sidebar tree of everything the current dev server knows about --
 * assets, jobs, schedules, sensors, and ops, grouped under one category
 * node each. The Activity Bar home for this extension, same idea as
 * Claude Code's own docked panel. Built on the same AssetIndexStore/
 * PrimitiveIndexStore the hover/diagnostics/go-to-def providers already
 * share, so it's never a second source of truth.
 */
type CategoryKind = 'assets' | 'jobs' | 'schedules' | 'sensors' | 'ops' | 'resources' | 'ioManagers';

const CATEGORY_LABEL: Record<CategoryKind, string> = {
  assets: 'Assets',
  jobs: 'Jobs',
  schedules: 'Schedules',
  sensors: 'Sensors',
  ops: 'Ops',
  resources: 'Resources',
  ioManagers: 'IO Managers',
};
const CATEGORY_ICON: Record<CategoryKind, string> = {
  assets: 'layers',
  jobs: 'play',
  schedules: 'clock',
  sensors: 'radio-tower',
  ops: 'gear',
  resources: 'plug',
  ioManagers: 'database',
};
const PRIMITIVE_KIND_FOR_CATEGORY: Partial<Record<CategoryKind, PrimitiveRefInfo['kind']>> = {
  jobs: 'job',
  schedules: 'schedule',
  sensors: 'sensor',
  ops: 'op',
  resources: 'resource',
  ioManagers: 'ioManager',
};

class CategoryTreeItem extends vscode.TreeItem {
  readonly isCategory = true as const;
  constructor(public readonly kind: CategoryKind, count: number) {
    super(
      `${CATEGORY_LABEL[kind]} (${count})`,
      count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    this.iconPath = new vscode.ThemeIcon(CATEGORY_ICON[kind]);
    this.contextValue = 'dagsterCategory';
  }
}

class AssetTreeItem extends vscode.TreeItem {
  constructor(public readonly info: AssetRefInfo) {
    super(info.key, vscode.TreeItemCollapsibleState.None);
    const parts: string[] = [];
    if (info.group) parts.push(info.group);
    if (info.kinds.length) parts.push(info.kinds.join(', '));
    this.description = parts.join(' · ');
    this.tooltip = info.description ?? info.key;
    this.iconPath = new vscode.ThemeIcon('layers');
    this.contextValue = 'dagsterAsset';
    this.command = { command: 'dagsterPowerUser.openAssetFromTree', title: 'Open Definition', arguments: [info.key] };
  }
}

class PrimitiveTreeItem extends vscode.TreeItem {
  constructor(public readonly info: PrimitiveRefInfo) {
    super(info.name, vscode.TreeItemCollapsibleState.None);
    this.description = info.cronSchedule ?? info.resourceType ?? undefined;
    this.tooltip = info.description ?? info.name;
    this.iconPath = new vscode.ThemeIcon(CATEGORY_ICON[(Object.keys(PRIMITIVE_KIND_FOR_CATEGORY) as CategoryKind[]).find((c) => PRIMITIVE_KIND_FOR_CATEGORY[c] === info.kind)!]);
    // Schedules/sensors get a status-suffixed context value (e.g.
    // "dagsterscheduleRunning") so package.json's view/item/context menu
    // can show a start OR a stop inline button depending on which one
    // currently applies, instead of one icon that's wrong half the time.
    this.contextValue =
      info.status === 'RUNNING' ? `dagster${info.kind}Running` : info.status === 'STOPPED' ? `dagster${info.kind}Stopped` : `dagster${info.kind}`;
    this.command = { command: 'dagsterPowerUser.openAssetFromTree', title: 'Open Definition', arguments: [info.name] };
  }
}

/** Shown instead of (or above) the usual empty categories when the last
 * refresh actually failed -- e.g. a real ImportError loading the
 * project's definitions -- rather than silently rendering "0" the way
 * this used to. */
class LoadErrorTreeItem extends vscode.TreeItem {
  readonly isLoadError = true as const;
  constructor(public readonly errorText: string) {
    super('Failed to load definitions', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    this.tooltip = errorText;
    this.description = errorText.split('\n')[0]?.slice(0, 80);
    this.contextValue = 'dagsterLoadError';
    this.command = { command: 'dagsterPowerUser.showLoadError', title: 'Show Error', arguments: [errorText] };
  }
}

type TreeNode = CategoryTreeItem | AssetTreeItem | PrimitiveTreeItem | LoadErrorTreeItem;

export class ProjectComponentsProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly assets: AssetIndexStore,
    private readonly primitives: PrimitiveIndexStore
  ) {
    assets.onDidChange(() => this.emitter.fire());
    primitives.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  private uniqueAssets(): AssetRefInfo[] {
    const seen = new Set<AssetRefInfo>();
    const unique: AssetRefInfo[] = [];
    for (const info of this.assets.getIndex().values()) {
      if (seen.has(info)) continue;
      seen.add(info);
      unique.push(info);
    }
    unique.sort((a, b) => a.key.localeCompare(b.key));
    return unique;
  }

  private primitivesOfKind(kind: PrimitiveRefInfo['kind']): PrimitiveRefInfo[] {
    return [...this.primitives.getIndex().values()]
      .filter((p) => p.kind === kind)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const categories: CategoryKind[] = ['assets', 'jobs', 'schedules', 'sensors', 'ops', 'resources', 'ioManagers'];
      const nodes: TreeNode[] = categories.map((kind) => {
        const count =
          kind === 'assets' ? this.uniqueAssets().length : this.primitivesOfKind(PRIMITIVE_KIND_FOR_CATEGORY[kind]!).length;
        return new CategoryTreeItem(kind, count);
      });
      // Both stores keep serving last-known-good data on a failed
      // refresh (so a transient blip doesn't flash everything to empty),
      // but that means the categories above alone can't tell "genuinely
      // empty" apart from "broken, showing stale/no data" -- surface
      // whichever one actually errored, once, at the top.
      const errorText = this.primitives.getLastError() ?? this.assets.getLastError();
      if (errorText) nodes.unshift(new LoadErrorTreeItem(errorText));
      return nodes;
    }
    if (element instanceof CategoryTreeItem) {
      if (element.kind === 'assets') return this.uniqueAssets().map((info) => new AssetTreeItem(info));
      return this.primitivesOfKind(PRIMITIVE_KIND_FOR_CATEGORY[element.kind]!).map((info) => new PrimitiveTreeItem(info));
    }
    return [];
  }
}

export function registerProjectComponentsView(
  context: vscode.ExtensionContext,
  assets: AssetIndexStore,
  primitives: PrimitiveIndexStore,
  resolver: AssetDefinitionResolver,
  getActiveGraphqlUrl: () => Promise<string | undefined>
): void {
  const provider = new ProjectComponentsProvider(assets, primitives);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dagsterPowerUser.projectComponents', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.openAssetFromTree', async (key: string) => {
      const location = await resolver.resolve(key);
      if (!location) {
        vscode.window.showInformationMessage(`Dagster: couldn't find a source location for "${key}" in this workspace.`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(location.uri);
      await vscode.window.showTextDocument(doc, { selection: location.range });
    }),
    vscode.commands.registerCommand('dagsterPowerUser.openAssetInDagster', async (arg: unknown) => {
      const key = typeof arg === 'string' ? arg : (arg as AssetTreeItem | undefined)?.info?.key;
      if (!key) return;
      const graphqlUrl = await getActiveGraphqlUrl();
      if (!graphqlUrl) {
        vscode.window.showWarningMessage('Dagster: no target currently connected.');
        return;
      }
      const url = `${deriveWebBaseUrl(graphqlUrl)}/assets/${key}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    // Covers job/schedule/sensor -- each has its own real overview page in
    // the Dagster UI at /<plural-kind>/<name>. Ops/resources/IO managers
    // don't get one: they don't have a standalone page the same way (ops
    // only show up inside a job's graph), so no entry for those rather
    // than guessing a route.
    vscode.commands.registerCommand('dagsterPowerUser.openPrimitiveInDagster', async (arg: unknown) => {
      const info = (arg as { info?: PrimitiveRefInfo } | undefined)?.info;
      if (!info) return;
      const pathByKind: Partial<Record<PrimitiveRefInfo['kind'], string>> = {
        job: 'jobs',
        schedule: 'schedules',
        sensor: 'sensors',
      };
      const segment = pathByKind[info.kind];
      if (!segment) return;
      const graphqlUrl = await getActiveGraphqlUrl();
      if (!graphqlUrl) {
        vscode.window.showWarningMessage('Dagster: no target currently connected.');
        return;
      }
      const url = `${deriveWebBaseUrl(graphqlUrl)}/${segment}/${info.name}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('dagsterPowerUser.addAssetDependency', async (arg: unknown) => {
      const downstreamKey = typeof arg === 'string' ? arg : (arg as AssetTreeItem | undefined)?.info?.key;
      if (!downstreamKey) return;

      const seen = new Set<string>();
      const keys = [...assets.getIndex().values()]
        .map((i) => i.key)
        .filter((k) => k !== downstreamKey && !seen.has(k) && seen.add(k));
      if (keys.length === 0) {
        vscode.window.showWarningMessage('Dagster: no other assets loaded to depend on.');
        return;
      }
      const upstreamKey = await vscode.window.showQuickPick(keys, {
        title: `Make "${downstreamKey}" depend on which asset?`,
      });
      if (!upstreamKey) return;

      const location = await resolver.resolve(downstreamKey);
      if (!location) {
        vscode.window.showWarningMessage(`Dagster: couldn't find "${downstreamKey}" in your local source to edit.`);
        return;
      }

      // Plain Python assets get their decorator edited directly; anything
      // else (a component's defs.yaml) goes through the SAME
      // post_processing mechanism as "Add Dependency to Folder...", just
      // scoped to this one asset via a real `key:"..."` selector
      // (confirmed live: AssetSelection.from_string parses this exact
      // syntax) instead of "*".
      const isPython = location.uri.fsPath.toLowerCase().endsWith('.py');
      const instruction = new vscode.Diagnostic(
        location.range,
        isPython
          ? `Add "${upstreamKey}" as a dependency of this asset (the @asset(...) decorator for asset key "${downstreamKey}") -- e.g. deps=["${upstreamKey}"], or extend an existing deps list. Keep every other argument exactly as-is, and don't duplicate an existing entry.`
          : `This file configures asset "${downstreamKey}" via a Dagster component. Add a dependency on "${upstreamKey}": add a post_processing.assets entry with target: 'key:"${downstreamKey}"', operation: merge, attributes.deps including "${upstreamKey}" -- create that structure (and the DefsFolderComponent type header, if this is a folder-level defs.yaml) if it doesn't exist, without removing or duplicating any existing post_processing entries.`,
        vscode.DiagnosticSeverity.Hint
      );
      await vscode.commands.executeCommand('dagsterPowerUser.fixDiagnosticWithAi', location.uri, instruction);
    }),
    vscode.commands.registerCommand('dagsterPowerUser.setAssetGroup', async (arg: unknown) => {
      const key = typeof arg === 'string' ? arg : (arg as AssetTreeItem | undefined)?.info?.key;
      if (!key) return;
      const groupName = await vscode.window.showInputBox({
        title: `Set group for "${key}"`,
        prompt: 'Group name',
        placeHolder: 'e.g. staging',
      });
      if (!groupName) return;

      const location = await resolver.resolve(key);
      if (!location) {
        vscode.window.showWarningMessage(`Dagster: couldn't find "${key}" in your local source to edit.`);
        return;
      }
      const isPython = location.uri.fsPath.toLowerCase().endsWith('.py');
      const instruction = new vscode.Diagnostic(
        location.range,
        isPython
          ? `Set group_name="${groupName}" on this asset (the @asset(...) decorator for asset key "${key}"). Keep every other argument exactly as-is.`
          : `This file configures asset "${key}" via a Dagster component. Set its group: add a post_processing.assets entry with target: 'key:"${key}"', operation: merge, attributes.group_name: "${groupName}" -- create that structure (and the DefsFolderComponent type header, if this is a folder-level defs.yaml) if it doesn't exist, without removing or duplicating any existing post_processing entries.`,
        vscode.DiagnosticSeverity.Hint
      );
      await vscode.commands.executeCommand('dagsterPowerUser.fixDiagnosticWithAi', location.uri, instruction);
    }),
    vscode.commands.registerCommand('dagsterPowerUser.addAssetToJob', async (arg: unknown) => {
      const assetKey = typeof arg === 'string' ? arg : (arg as AssetTreeItem | undefined)?.info?.key;
      if (!assetKey) return;

      const jobs = [...primitives.getIndex().values()].filter((p) => p.kind === 'job').map((p) => p.name);
      if (jobs.length === 0) {
        vscode.window.showWarningMessage('Dagster: no jobs loaded to add this asset to.');
        return;
      }
      const jobName = await vscode.window.showQuickPick(jobs, { title: `Add "${assetKey}" to which job?` });
      if (!jobName) return;

      const location = await resolver.resolve(jobName);
      if (!location) {
        vscode.window.showWarningMessage(`Dagster: couldn't find job "${jobName}" in your local source to edit.`);
        return;
      }
      const instruction = new vscode.Diagnostic(
        location.range,
        `Add asset "${assetKey}" to this job's selection (the define_asset_job(...) call defining job "${jobName}"). Extend the existing selection however it's currently expressed (a list of strings, a selection DSL string, or an AssetSelection expression) to include this asset, without removing any assets it already selects. If there's no selection argument yet, add one containing just this asset.`,
        vscode.DiagnosticSeverity.Hint
      );
      await vscode.commands.executeCommand('dagsterPowerUser.fixDiagnosticWithAi', location.uri, instruction);
    }),
    vscode.commands.registerCommand('dagsterPowerUser.addAssetCheck', async (arg: unknown) => {
      const assetKey = typeof arg === 'string' ? arg : (arg as AssetTreeItem | undefined)?.info?.key;
      if (!assetKey) return;

      const description = await vscode.window.showInputBox({
        title: `Add a check for "${assetKey}"`,
        prompt: 'Describe the check in plain language',
        placeHolder: 'e.g. the row count is greater than zero',
      });
      if (!description) return;

      const location = await resolver.resolve(assetKey);
      if (!location) {
        vscode.window.showWarningMessage(`Dagster: couldn't find "${assetKey}" in your local source to edit.`);
        return;
      }
      const instruction = new vscode.Diagnostic(
        location.range,
        `Add a new @asset_check(asset=..., name="...") function in this file for asset "${assetKey}" that checks: ${description}. It should return an AssetCheckResult(passed=...). Give the check function a short, descriptive name distinct from the asset's own name. If this file has a Definitions(...) or Definitions.merge(...) call with an asset_checks=[...] list, add the new check function to it; if there's no such list in this file, just add the function.`,
        vscode.DiagnosticSeverity.Hint
      );
      await vscode.commands.executeCommand('dagsterPowerUser.fixDiagnosticWithAi', location.uri, instruction, true);
    }),
    vscode.commands.registerCommand('dagsterPowerUser.addScheduleForJob', async (arg: unknown) => {
      const jobName = typeof arg === 'string' ? arg : (arg as { info?: PrimitiveRefInfo } | undefined)?.info?.name;
      if (!jobName) return;
      await promptAndScaffoldSchedule(resolver, jobName, `job=${jobName}`);
    }),
    // @schedule's real `target` parameter (confirmed via inspect.signature
    // against the installed dagster package) is a CoercibleToAssetSelection
    // -- the same type define_asset_job's `selection` uses -- so a
    // schedule can target assets directly, no job required. This is the
    // asset-side twin of addScheduleForJob above, sharing the cron prompt
    // + scaffold logic via promptAndScaffoldSchedule.
    vscode.commands.registerCommand('dagsterPowerUser.addScheduleForAsset', async (arg: unknown) => {
      const assetKey = typeof arg === 'string' ? arg : (arg as AssetTreeItem | undefined)?.info?.key;
      if (!assetKey) return;
      await promptAndScaffoldSchedule(resolver, assetKey, `target=["${assetKey}"]`, true);
    })
  );

  async function promptAndScaffoldSchedule(
    resolver: AssetDefinitionResolver,
    name: string,
    targetArg: string,
    isAsset = false
  ): Promise<void> {
    const cron = await vscode.window.showInputBox({
      title: `Add a schedule for ${isAsset ? 'asset' : 'job'} "${name}"`,
      prompt: 'Cron expression',
      placeHolder: '0 6 * * *',
      value: '0 0 * * *',
    });
    if (!cron) return;

    const location = await resolver.resolve(name);
    if (!location) {
      vscode.window.showWarningMessage(`Dagster: couldn't find "${name}" in your local source to edit.`);
      return;
    }
    const instruction = new vscode.Diagnostic(
      location.range,
      `Add a new @schedule(${targetArg}, cron_schedule="${cron}") function in this file that returns {} (an empty run config). Give the schedule function a short, descriptive name. If this file has a Definitions(...) or Definitions.merge(...) call with a schedules=[...] list, add the new schedule function to it; if there's no such list in this file, just add the function.`,
      vscode.DiagnosticSeverity.Hint
    );
    await vscode.commands.executeCommand('dagsterPowerUser.fixDiagnosticWithAi', location.uri, instruction, true);
  }
}

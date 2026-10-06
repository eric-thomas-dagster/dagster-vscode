import * as vscode from 'vscode';
import type { AssetIndexStore, AssetRefInfo } from '../data/assetIndex';
import type { PrimitiveIndexStore, PrimitiveRefInfo } from '../data/primitiveIndex';
import type { AssetDefinitionResolver } from '../language/definitionProvider';
import { deriveWebBaseUrl } from '../data/graphqlClient';
import type { DagsterProject } from '../projectDetection';
import { fetchComponentCatalog } from '../data/componentCatalog';
import { installComponent, extractClassName } from '../commands/installComponent';

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
  getActiveGraphqlUrl: () => Promise<string | undefined>,
  getPrimaryProject: () => DagsterProject | undefined
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
      if (!info.repositoryLocationName) {
        vscode.window.showWarningMessage(`Dagster: no code location known for "${info.name}" -- try refreshing the index.`);
        return;
      }
      const graphqlUrl = await getActiveGraphqlUrl();
      if (!graphqlUrl) {
        vscode.window.showWarningMessage('Dagster: no target currently connected.');
        return;
      }
      // Confirmed live (and corrected after a real test): jobs/schedules/
      // sensors are scoped under their code location in the Dagster UI --
      // a bare /jobs/<name> is NOT the real route, unlike /runs/<id> and
      // /assets/<path> which aren't location-scoped.
      const url = `${deriveWebBaseUrl(graphqlUrl)}/locations/${info.repositoryLocationName}/${segment}/${info.name}`;
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

      // A data-quality-check component (if this project has one configured
      // anywhere) can check ANY asset regardless of how that asset itself
      // is defined -- confirmed live against the real
      // dagster_component_templates.EnhancedDataQualityChecks component's
      // schema.json/example.yaml (fetched from the same GitHub repo the
      // Component Catalog already indexes). Prefer it over scaffolding a
      // raw @asset_check Python function whenever it's actually present.
      const eqcFile = await findExistingComponentFile('EnhancedDataQualityChecks');
      if (eqcFile) {
        const instruction = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          `Add a new data-quality check for asset "${assetKey}" to this Enhanced Data Quality Checks component config (type: dagster_component_templates.EnhancedDataQualityChecks). The check should verify: ${description}. Add it under attributes.assets["${assetKey}"] (create that key if it doesn't exist yet), picking whichever check type best fits the description -- available types in this component include row_count_check, null_check, data_type_check, range_check, static_threshold, anomaly_detection, percent_delta, uniqueness_check, custom_sql_check, pattern_matching, value_set_validation, entropy_analysis, correlation_check, each taking a list of named check configs. Follow the exact shape of whichever type you pick from the other entries already in this file. Don't remove or duplicate any existing checks or assets in this file.`,
          vscode.DiagnosticSeverity.Hint
        );
        await vscode.commands.executeCommand('dagsterPowerUser.fixDiagnosticWithAi', eqcFile, instruction, true);
        return;
      }

      // Not installed yet -- it's a real, installable catalog component
      // (same one the Component Catalog view already lists), so offer
      // that instead of silently defaulting to the harder raw-Python path.
      const project = getPrimaryProject();
      if (project) {
        const choice = await vscode.window.showInformationMessage(
          'Dagster: no data-quality-check component installed in this project yet.',
          'Install Enhanced Data Quality Checks',
          'Just Write Python'
        );
        if (choice === 'Install Enhanced Data Quality Checks') {
          const installedFile = await installCatalogComponentAndLocate(context, project, 'enhanced_data_quality_checks');
          if (installedFile) {
            const instruction = new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 0),
              `This file was just installed from a template and still has its EXAMPLE attributes.assets entries (placeholder asset keys that don't exist in this project, e.g. RAW_DATA.users). Remove those example entries, then add a new data-quality check for the real asset "${assetKey}" under attributes.assets["${assetKey}"], verifying: ${description}. Pick whichever check type best fits -- available types include row_count_check, null_check, data_type_check, range_check, static_threshold, anomaly_detection, percent_delta, uniqueness_check, custom_sql_check, pattern_matching, value_set_validation, entropy_analysis, correlation_check, each taking a list of named check configs (see the example entries you're removing for the exact shape before you remove them).`,
              vscode.DiagnosticSeverity.Hint
            );
            await vscode.commands.executeCommand('dagsterPowerUser.fixDiagnosticWithAi', installedFile, instruction, true);
            return;
          }
        } else if (choice !== 'Just Write Python') {
          return; // dismissed
        }
      }

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

  /** Cheap, bounded scan for a `defs.yaml` already configuring a component
   * by CLASS NAME (not the manifest's original `dagster_component_
   * templates.X` module path) -- installComponent() rewrites `type:` to
   * the target project's own module path when it copies a catalog
   * component in (confirmed in its own source: `${rootModule}.components.
   * ${component.id}.${className}`), so an already-installed instance
   * never literally contains the original path, only the class name as
   * the type's last dotted segment. Same scan technique
   * AssetDefinitionResolver already uses for its own YAML fallback. */
  async function findExistingComponentFile(className: string): Promise<vscode.Uri | undefined> {
    const typeRe = new RegExp(`^type:\\s*\\S*\\.${className}\\s*$`, 'm');
    const yamlFiles = await vscode.workspace.findFiles(
      '**/defs.yaml',
      '**/{node_modules,.venv,venv,__pycache__,.git,dbt_packages,target}/**',
      500
    );
    for (const file of yamlFiles) {
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
        if (typeRe.test(text)) return file;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /** Installs a catalog component by id (reusing the exact same
   * installComponent() flow the Community Components view uses --
   * same collision checks, same dependency-install prompt), then
   * re-scans to find the file it just wrote. installComponent() doesn't
   * return the written path itself, but re-scanning is simplest and
   * avoids changing its signature/risking its already-tested behavior. */
  async function installCatalogComponentAndLocate(
    ctx: vscode.ExtensionContext,
    project: DagsterProject,
    componentId: string
  ): Promise<vscode.Uri | undefined> {
    const catalog = await fetchComponentCatalog(ctx);
    const component = catalog.find((c) => c.id === componentId);
    if (!component) {
      vscode.window.showErrorMessage(`Dagster: "${componentId}" isn't in the component catalog.`);
      return undefined;
    }
    let exampleYaml: string;
    try {
      exampleYaml = await (await fetch(component.exampleUrl)).text();
    } catch (e) {
      vscode.window.showErrorMessage(`Dagster: couldn't fetch "${component.name}": ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
    const className = extractClassName(exampleYaml);
    if (!className) return undefined;

    await installComponent(component, project);
    return findExistingComponentFile(className);
  }

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

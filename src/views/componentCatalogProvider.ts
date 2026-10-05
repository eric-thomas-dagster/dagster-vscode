import * as vscode from 'vscode';
import { fetchComponentCatalog, type CatalogComponent } from '../data/componentCatalog';
import { installComponent } from '../commands/installComponent';
import type { DagsterProject } from '../projectDetection';

class CategoryTreeItem extends vscode.TreeItem {
  constructor(public readonly category: string, count: number) {
    super(`${category} (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'dagsterCatalogCategory';
  }
}

class ComponentTreeItem extends vscode.TreeItem {
  constructor(public readonly component: CatalogComponent) {
    super(component.name, vscode.TreeItemCollapsibleState.None);
    this.description = component.tags.slice(0, 3).join(', ');
    this.tooltip = component.description;
    this.iconPath = new vscode.ThemeIcon('package');
    this.contextValue = 'dagsterCatalogComponent';
    this.command = {
      command: 'dagsterPowerUser.installCatalogComponent',
      title: 'Install Component',
      arguments: [component],
    };
  }
}

type TreeNode = CategoryTreeItem | ComponentTreeItem;

export class ComponentCatalogProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private components: CatalogComponent[] = [];
  private loaded = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      this.components = await fetchComponentCatalog(this.context);
      this.loaded = true;
      this.emitter.fire();
    } catch (e) {
      vscode.window.showWarningMessage(
        `Dagster: couldn't load the community component catalog: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  getComponents(): CatalogComponent[] {
    return this.components;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!this.loaded) {
      void this.ensureLoaded();
      return [];
    }
    if (!element) {
      const byCategory = new Map<string, number>();
      for (const c of this.components) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + 1);
      return [...byCategory.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([category, count]) => new CategoryTreeItem(category, count));
    }
    if (element instanceof CategoryTreeItem) {
      return this.components
        .filter((c) => c.category === element.category)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => new ComponentTreeItem(c));
    }
    return [];
  }
}

/** QuickPick-based search is the PRIMARY way to find something among
 * 1296 components -- native fuzzy filtering as you type beats browsing
 * a 2-level tree for anything you don't already know the category of.
 * This is the exact gap dagster-power-user-vscode's own catalog left
 * unfilled (its README: "no built-in search/filter of its own"). */
async function searchCatalog(provider: ComponentCatalogProvider): Promise<void> {
  await provider.ensureLoaded();
  const components = provider.getComponents();
  if (components.length === 0) {
    vscode.window.showWarningMessage('Dagster: component catalog is empty or failed to load.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    components.map((c) => ({
      label: c.name,
      description: c.category,
      detail: c.description,
      component: c,
    })),
    { title: `Search ${components.length} community components`, matchOnDescription: true, matchOnDetail: true }
  );
  if (!picked) return;
  await vscode.commands.executeCommand('dagsterPowerUser.installCatalogComponent', picked.component);
}

export function registerComponentCatalogView(
  context: vscode.ExtensionContext,
  getPrimaryProject: () => DagsterProject | undefined,
  onInstalled: () => Promise<void>
): void {
  const provider = new ComponentCatalogProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dagsterPowerUser.componentCatalog', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.searchComponentCatalog', () => searchCatalog(provider))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.installCatalogComponent', async (component: CatalogComponent) => {
      const project = getPrimaryProject();
      if (!project) {
        vscode.window.showWarningMessage('Dagster: no dg-detected project to install into.');
        return;
      }
      await installComponent(component, project);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Dagster: reloading code location...' },
        () => onInstalled()
      );
    })
  );
}

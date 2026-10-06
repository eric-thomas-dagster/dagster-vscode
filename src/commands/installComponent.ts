import * as vscode from 'vscode';
import type { CatalogComponent } from '../data/componentCatalog';
import type { DagsterProject } from '../projectDetection';
import { runInTerminal } from '../util/terminalRun';

/** The example.yaml's `type:` value is `<original_module_path>.<ClassName>`
 * (confirmed live against a real sample) -- the class name is always its
 * last dotted segment. */
export function extractClassName(exampleYaml: string): string | null {
  const match = exampleYaml.match(/^type:\s*(\S+)/m);
  if (!match) return null;
  const parts = match[1].split('.');
  return parts[parts.length - 1];
}

function extractAttributesBlock(exampleYaml: string): string {
  const idx = exampleYaml.indexOf('attributes:');
  return idx === -1 ? '' : exampleYaml.slice(idx);
}

/** `[tool.dg.project] root_module = "..."` -- same field our own project
 * detection already knows to look for; read directly here rather than
 * threading it through since this is the only place that needs it. */
async function readRootModule(pyprojectUri: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(pyprojectUri);
    const text = Buffer.from(bytes).toString('utf8');
    const match = text.match(/root_module\s*=\s*["']([^"']+)["']/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/**
 * Copies the community component's real `component.py` into the target
 * project's own `components/` package, and writes a new `defs.yaml`
 * instance referencing it -- adapted from `example.yaml`'s template
 * rather than left pointing at the original `dagster_component_templates`
 * module path (confirmed live: the manifest's own module path isn't
 * importable from inside a different project at all).
 */
export async function installComponent(component: CatalogComponent, project: DagsterProject): Promise<void> {
  const rootModule =
    (await readRootModule(vscode.Uri.joinPath(project.folder.uri, 'pyproject.toml'))) ?? project.folder.name;

  const instanceName = await vscode.window.showInputBox({
    title: `Install "${component.name}" as...`,
    value: component.id,
    prompt: 'Name for this component instance (used as the defs/ subfolder name).',
    validateInput: (v) => (/^[a-z][a-z0-9_]*$/.test(v) ? null : 'Use lowercase letters, numbers, underscores.'),
  });
  if (!instanceName) return;

  let componentPy: string;
  let exampleYaml: string;
  try {
    [componentPy, exampleYaml] = await Promise.all([
      fetchText(component.componentUrl),
      fetchText(component.exampleUrl),
    ]);
  } catch (e) {
    vscode.window.showErrorMessage(`Dagster: couldn't download "${component.name}": ${e instanceof Error ? e.message : e}`);
    return;
  }

  const className = extractClassName(exampleYaml);
  if (!className) {
    vscode.window.showErrorMessage(`Dagster: couldn't determine the component class name from ${component.exampleUrl}.`);
    return;
  }

  const srcRoot = vscode.Uri.joinPath(project.folder.uri, 'src', rootModule);
  const componentFileUri = vscode.Uri.joinPath(srcRoot, 'components', `${component.id}.py`);
  const defsDirUri = vscode.Uri.joinPath(srcRoot, 'defs', instanceName);
  const defsFileUri = vscode.Uri.joinPath(defsDirUri, 'defs.yaml');

  // Collision check -- never silently clobber an existing instance or
  // component file (the exact gap the AI planner in dagster-power-user-
  // vscode's installer left: it overwrote silently).
  for (const uri of [componentFileUri, defsFileUri]) {
    try {
      await vscode.workspace.fs.stat(uri);
      const choice = await vscode.window.showWarningMessage(
        `${vscode.workspace.asRelativePath(uri)} already exists. Overwrite?`,
        { modal: true },
        'Overwrite'
      );
      if (choice !== 'Overwrite') return;
    } catch {
      // Doesn't exist -- fine, proceed.
    }
  }

  const attributesBlock = extractAttributesBlock(exampleYaml);
  const defsYaml = `type: ${rootModule}.components.${component.id}.${className}\n${attributesBlock}`;

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(srcRoot, 'components'));
  await vscode.workspace.fs.createDirectory(defsDirUri);
  await vscode.workspace.fs.writeFile(componentFileUri, Buffer.from(componentPy, 'utf8'));
  await vscode.workspace.fs.writeFile(defsFileUri, Buffer.from(defsYaml, 'utf8'));

  const doc = await vscode.workspace.openTextDocument(defsFileUri);
  await vscode.window.showTextDocument(doc);

  // Catalog components ship with EXAMPLE attribute values (confirmed live:
  // an installed component's `upstream_asset_key: customer_metrics`
  // pointed at an asset that doesn't exist in the target project at all,
  // and broke the WHOLE code location, not just that instance, until
  // fixed) -- any `*_asset_key:` field (besides `asset_name:`, the
  // component's own OUTPUT name) is exactly this kind of placeholder and
  // needs to point at a real asset in this project before it'll validate.
  const placeholderRefs = [...attributesBlock.matchAll(/^\s*(\w*asset_key\w*):\s*(\S+)/gm)].map(
    (m) => `${m[1]}: ${m[2]}`
  );
  const placeholderWarning = placeholderRefs.length
    ? ` This references ${placeholderRefs.join(', ')} -- replace with a real asset key from this project (Dagster Definitions) before it'll validate.`
    : '';

  if (component.pipDependencies.length > 0) {
    const choice = await vscode.window.showInformationMessage(
      `Dagster: "${component.name}" needs these packages: ${component.pipDependencies.join(', ')}.${placeholderWarning}`,
      'Install Dependencies'
    );
    if (choice === 'Install Dependencies') {
      // Visible terminal, not a hidden subprocess -- same reasoning as
      // "Start dg dev"/scaffold-new-project: the user sees exactly what
      // runs against their own environment and can cancel it.
      runInTerminal(
        'Install Dependencies',
        project.folder.uri.fsPath,
        `uv add ${component.pipDependencies.map((p) => JSON.stringify(p)).join(' ')}`
      );
    }
  } else {
    vscode.window.showInformationMessage(
      `Dagster: installed "${component.name}" -- edit the attributes above, then run "Dagster: Run dg check defs" to validate.${placeholderWarning}`
    );
  }
}

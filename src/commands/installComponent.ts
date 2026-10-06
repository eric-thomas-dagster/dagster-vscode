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
export async function readRootModule(pyprojectUri: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(pyprojectUri);
    const text = Buffer.from(bytes).toString('utf8');
    const match = text.match(/root_module\s*=\s*["']([^"']+)["']/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/**
 * Downloads a catalog component's real `component.py` into the target
 * project's own `components/` package and writes a new `defs.yaml`
 * instance with the GIVEN attributes YAML (not necessarily the catalog's
 * own example -- the form-driven flows generate their own, built
 * deterministically from real user input instead of an AI-guessed or
 * placeholder-filled block). Shared by installComponent() (which prompts
 * for the instance name and uses the example attributes verbatim) and
 * anything else that already knows exactly what it wants to write.
 * Returns the written defs.yaml's Uri, or undefined if the user declined
 * an overwrite or a download failed.
 */
export async function writeComponentInstance(
  component: CatalogComponent,
  project: DagsterProject,
  instanceName: string,
  attributesYaml: string
): Promise<vscode.Uri | undefined> {
  const rootModule =
    (await readRootModule(vscode.Uri.joinPath(project.folder.uri, 'pyproject.toml'))) ?? project.folder.name;

  let componentPy: string;
  try {
    componentPy = await fetchText(component.componentUrl);
  } catch (e) {
    vscode.window.showErrorMessage(`Dagster: couldn't download "${component.name}": ${e instanceof Error ? e.message : e}`);
    return undefined;
  }

  const exampleYaml = await fetchText(component.exampleUrl).catch(() => '');
  const className = extractClassName(exampleYaml) ?? component.id.replace(/(^|_)([a-z])/g, (_m, _p, c) => c.toUpperCase());

  const srcRoot = vscode.Uri.joinPath(project.folder.uri, 'src', rootModule);
  const componentFileUri = vscode.Uri.joinPath(srcRoot, 'components', `${component.id}.py`);
  const defsDirUri = vscode.Uri.joinPath(srcRoot, 'defs', instanceName);
  const defsFileUri = vscode.Uri.joinPath(defsDirUri, 'defs.yaml');

  // Collision check -- never silently clobber an existing instance or
  // component file (the exact gap the AI planner in dagster-power-user-
  // vscode's installer left: it overwrote silently). The component.py
  // file itself is fine to skip re-downloading/re-confirming if it's
  // already there (same code every time) -- only the defs.yaml instance
  // is actually new, user-authored content worth protecting.
  try {
    await vscode.workspace.fs.stat(defsFileUri);
    const choice = await vscode.window.showWarningMessage(
      `${vscode.workspace.asRelativePath(defsFileUri)} already exists. Overwrite?`,
      { modal: true },
      'Overwrite'
    );
    if (choice !== 'Overwrite') return undefined;
  } catch {
    // Doesn't exist -- fine, proceed.
  }

  const defsYaml = `type: ${rootModule}.components.${component.id}.${className}\n${attributesYaml}`;

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(srcRoot, 'components'));
  await vscode.workspace.fs.createDirectory(defsDirUri);
  await vscode.workspace.fs.writeFile(componentFileUri, Buffer.from(componentPy, 'utf8'));
  await vscode.workspace.fs.writeFile(defsFileUri, Buffer.from(defsYaml, 'utf8'));

  if (component.pipDependencies.length > 0) {
    const choice = await vscode.window.showInformationMessage(
      `Dagster: "${component.name}" needs these packages: ${component.pipDependencies.join(', ')}.`,
      'Install Dependencies'
    );
    if (choice === 'Install Dependencies') {
      runInTerminal(
        'Install Dependencies',
        project.folder.uri.fsPath,
        `uv add ${component.pipDependencies.map((p) => JSON.stringify(p)).join(' ')}`
      );
    }
  }

  return defsFileUri;
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
  const instanceName = await vscode.window.showInputBox({
    title: `Install "${component.name}" as...`,
    value: component.id,
    prompt: 'Name for this component instance (used as the defs/ subfolder name).',
    validateInput: (v) => (/^[a-z][a-z0-9_]*$/.test(v) ? null : 'Use lowercase letters, numbers, underscores.'),
  });
  if (!instanceName) return;

  let exampleYaml: string;
  try {
    exampleYaml = await fetchText(component.exampleUrl);
  } catch (e) {
    vscode.window.showErrorMessage(`Dagster: couldn't download "${component.name}": ${e instanceof Error ? e.message : e}`);
    return;
  }
  const attributesBlock = extractAttributesBlock(exampleYaml);

  const defsFileUri = await writeComponentInstance(component, project, instanceName, attributesBlock);
  if (!defsFileUri) return;

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
  vscode.window.showInformationMessage(
    `Dagster: installed "${component.name}" -- edit the attributes above, then run "Dagster: Run dg check defs" to validate.${placeholderWarning}`
  );
}

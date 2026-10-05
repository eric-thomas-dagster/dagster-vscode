import * as vscode from 'vscode';
import type { DagsterProject } from '../projectDetection';
import { runInTerminal } from '../util/terminalRun';
import { type ActiveTarget, resolveEndpoint } from '../data/activeTarget';
import { fetchRepositorySelectors, launchAssetRun, launchJobRun, type RepositorySelectorInfo } from '../data/graphqlClient';

/** Verified live against a real project: `dg launch --assets <key>`
 * materializes an asset, `dg launch --job <name>` runs a job. Visible
 * terminal, not a hidden subprocess -- same reasoning as every other
 * "runs something real against your environment" action in this
 * extension: you see the output and can Ctrl+C it. Only used for the
 * LOCAL target -- remote/Dagster+ targets have no local terminal to run
 * `dg` in, so they go through the GraphQL `launchRun` mutation instead
 * (see launchViaGraphQL below). */
function launchInTerminal(name: string, project: DagsterProject, args: string): void {
  if (!project.dgPath) {
    vscode.window.showWarningMessage('Dagster: no dg-detected project to run against.');
    return;
  }
  runInTerminal(name, project.folder.uri.fsPath, `${JSON.stringify(project.dgPath)} launch ${args}`, (exitCode) => {
    if (exitCode === 0) {
      vscode.window.showInformationMessage(`Dagster: ${name} succeeded.`);
    } else {
      vscode.window.showErrorMessage(`Dagster: ${name} failed (exit code ${exitCode}) -- see terminal output.`);
    }
  });
}

async function pickRepositorySelector(selectors: RepositorySelectorInfo[]): Promise<RepositorySelectorInfo | undefined> {
  if (selectors.length === 0) {
    vscode.window.showErrorMessage('Dagster: no code locations found at this target.');
    return undefined;
  }
  if (selectors.length === 1) return selectors[0];
  const picked = await vscode.window.showQuickPick(
    selectors.map((s) => ({ label: s.repositoryLocationName, description: s.repositoryName, selector: s })),
    { title: 'Which code location?' }
  );
  return picked?.selector;
}

async function launchViaGraphQL(
  name: string,
  context: vscode.ExtensionContext,
  target: ActiveTarget,
  localGraphqlUrl: string,
  run: (endpoint: { url: string; headers?: Record<string, string> }, selector: RepositorySelectorInfo) => ReturnType<typeof launchAssetRun>
): Promise<void> {
  const endpoint = await resolveEndpoint(context, target, localGraphqlUrl);
  if (!endpoint) {
    vscode.window.showWarningMessage('Dagster: no Dagster+ credentials connected for this target.');
    return;
  }
  try {
    const selectors = await fetchRepositorySelectors(endpoint);
    const selector = await pickRepositorySelector(selectors);
    if (!selector) return;
    const outcome = await run(endpoint, selector);
    if (outcome.success) {
      vscode.window.showInformationMessage(`Dagster: ${name} -- ${outcome.message}`);
    } else {
      vscode.window.showErrorMessage(`Dagster: ${name} failed -- ${outcome.message}`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Dagster: ${name} failed -- ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function materializeAsset(
  assetKey: string,
  project: DagsterProject | undefined,
  context: vscode.ExtensionContext,
  target: ActiveTarget,
  localGraphqlUrl: string
): Promise<void> {
  if (target.kind === 'local') {
    if (!project) {
      vscode.window.showWarningMessage('Dagster: no dg-detected project to materialize against.');
      return;
    }
    launchInTerminal(`Materialize: ${assetKey}`, project, `--assets ${JSON.stringify(assetKey)}`);
    return;
  }
  await launchViaGraphQL(`Materialize ${assetKey}`, context, target, localGraphqlUrl, (endpoint, selector) =>
    launchAssetRun(endpoint, selector, [assetKey.split('/')])
  );
}

export async function launchJob(
  jobName: string,
  project: DagsterProject | undefined,
  context: vscode.ExtensionContext,
  target: ActiveTarget,
  localGraphqlUrl: string
): Promise<void> {
  if (target.kind === 'local') {
    if (!project) {
      vscode.window.showWarningMessage('Dagster: no dg-detected project to launch against.');
      return;
    }
    launchInTerminal(`Launch job: ${jobName}`, project, `--job ${JSON.stringify(jobName)}`);
    return;
  }
  await launchViaGraphQL(`Launch job ${jobName}`, context, target, localGraphqlUrl, (endpoint, selector) =>
    launchJobRun(endpoint, selector, jobName)
  );
}

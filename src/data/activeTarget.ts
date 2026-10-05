import * as vscode from 'vscode';
import {
  getDagsterPlusCredentials,
  hasDagsterPlusCredentials,
  listDagsterPlusDeployments,
  setDagsterPlusCredentials,
} from './dagsterPlusClient';
import type { GraphQLEndpoint } from './graphqlClient';

/**
 * Where actions (Materialize, Launch Job) run and where reads come from.
 * Confirmed live: `launchRun` is the exact same mutation shape whether
 * the target is a local `dg dev`, a self-hosted Dagster OSS webserver, or
 * Dagster+ -- only the URL/auth differ, so one Target type covers all
 * three rather than three separate code paths.
 */
export type ActiveTarget =
  | { kind: 'local' }
  | { kind: 'remote'; url: string }
  | { kind: 'plus'; deployment: string };

const STORAGE_KEY = 'dagsterPowerUser.activeTarget';

export class ActiveTargetStore implements vscode.Disposable {
  private target: ActiveTarget;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.target = context.workspaceState.get<ActiveTarget>(STORAGE_KEY, { kind: 'local' });
  }

  get(): ActiveTarget {
    return this.target;
  }

  async set(target: ActiveTarget): Promise<void> {
    this.target = target;
    await this.context.workspaceState.update(STORAGE_KEY, target);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export function describeTarget(target: ActiveTarget): string {
  if (target.kind === 'local') return 'Local';
  if (target.kind === 'remote') return `Remote (${target.url})`;
  return `Dagster+: ${target.deployment}`;
}

/** Resolves a Target into an actual URL + auth headers any GraphQL call
 * can use -- the one place that knows how each target kind is reached. */
export async function resolveEndpoint(
  context: vscode.ExtensionContext,
  target: ActiveTarget,
  localGraphqlUrl: string
): Promise<GraphQLEndpoint | undefined> {
  if (target.kind === 'local') return { url: localGraphqlUrl };
  if (target.kind === 'remote') return { url: target.url };
  const creds = await getDagsterPlusCredentials(context);
  if (!creds) return undefined;
  return {
    url: `https://${creds.org}.dagster.cloud/${target.deployment}/graphql`,
    headers: { 'Dagster-Cloud-Api-Token': creds.token },
  };
}

interface PickableTarget {
  label: string;
  description?: string;
  target?: ActiveTarget;
  /** Not a real target -- runs the Dagster+ connect flow, then re-shows
   * this same picker so the deployments that unlocks actually show up,
   * instead of the Dagster+ option just silently not existing. */
  isConnectAction?: true;
}

/** Shared QuickPick listing every target the user could plausibly pick
 * right now -- Local (if a project's detected), a free-typed remote OSS
 * URL, and every Dagster+ deployment (if connected). Used by both the
 * tab-like control in the chat sidebar and anything else that needs a
 * one-off target choice (e.g. Manage Automations). */
export async function pickTarget(
  context: vscode.ExtensionContext,
  hasLocalProject: boolean
): Promise<ActiveTarget | undefined> {
  const options: PickableTarget[] = [];
  if (hasLocalProject) {
    options.push({ label: '$(server-process) Local dev server', target: { kind: 'local' } });
  }
  options.push({ label: '$(radio-tower) Dagster OSS (remote URL)...', target: { kind: 'remote', url: '' } });

  if (await hasDagsterPlusCredentials(context)) {
    const creds = (await getDagsterPlusCredentials(context))!;
    try {
      const deployments = await listDagsterPlusDeployments(creds);
      for (const d of deployments) {
        options.push({
          label: `$(cloud) Dagster+: ${d.name}`,
          description: d.type === 'BRANCH' ? 'branch deployment' : undefined,
          target: { kind: 'plus', deployment: d.name },
        });
      }
    } catch {
      // Listing failed -- still offer Local/remote above rather than
      // blocking the whole picker on a Dagster+ hiccup.
    }
  } else {
    // Not connected yet -- say so and offer to connect right here,
    // rather than just leaving Dagster+ out with no explanation.
    options.push({ label: '$(plug) Connect Dagster+...', description: 'not connected yet', isConnectAction: true });
  }

  const picked = await vscode.window.showQuickPick(options, { title: 'Dagster: Switch Target' });
  if (!picked) return undefined;

  if (picked.isConnectAction) {
    await setDagsterPlusCredentials(context);
    if (await hasDagsterPlusCredentials(context)) {
      return pickTarget(context, hasLocalProject);
    }
    return undefined;
  }

  if (!picked.target) return undefined;

  if (picked.target.kind === 'remote') {
    const url = await vscode.window.showInputBox({
      title: 'Dagster OSS GraphQL URL',
      prompt: 'e.g. https://my-dagster-server.example.com/graphql',
      placeHolder: 'https://.../graphql',
    });
    if (!url) return undefined;
    return { kind: 'remote', url: url.trim() };
  }
  return picked.target;
}

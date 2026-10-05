import * as vscode from 'vscode';
import { type ActiveTargetStore, resolveEndpoint } from '../data/activeTarget';
import {
  type GraphQLEndpoint,
  fetchAssetGraph,
  fetchRuns,
  fetchRunLogs,
  fetchAutomations,
  fetchRepositorySelectors,
  launchAssetRun,
  launchJobRun,
  terminateRunById,
  retryRun,
  startSchedule,
  stopSchedule,
  startSensor,
  stopSensor,
  type RepositorySelectorInfo,
} from '../data/graphqlClient';

/**
 * VS Code Language Model Tools -- these make Dagster actions callable by
 * GitHub Copilot Chat's own agent mode directly (no @-mention needed),
 * the same role the Airflow extension's 24 LM tools play. Confirmed real
 * against the installed @types/vscode (1.140.0): `vscode.lm.registerTool`,
 * `LanguageModelTool<T>`, `LanguageModelToolResult`, `LanguageModelTextPart`
 * are all present and stable, not guessed/experimental API.
 *
 * Every tool resolves the CURRENTLY ACTIVE target (Local/Remote/Dagster+)
 * itself, same as every other target-aware command in this extension --
 * a tool call from chat acts on whatever the user has selected in the
 * sidebar's Local/Remote tabs.
 *
 * Side-effecting tools (materialize, launch, terminate, retry, toggle
 * automations) declare `prepareInvocation` with `confirmationMessages`,
 * so VS Code asks the user to confirm before running them -- same
 * "confirm risky actions" principle as everywhere else in this
 * extension, just expressed through the chat UI's own confirmation
 * mechanism instead of a QuickPick/showWarningMessage.
 */

function textResult(data: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data, null, 2))]);
}

export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  activeTargetStore: ActiveTargetStore,
  getLocalGraphqlUrl: () => string | undefined
): void {
  async function endpointOrThrow(): Promise<GraphQLEndpoint> {
    const target = activeTargetStore.get();
    const endpoint = await resolveEndpoint(context, target, getLocalGraphqlUrl() ?? '');
    if (!endpoint) {
      throw new Error(
        'No Dagster target is currently connected. Ask the user to run "Dagster: Switch Target" or "Dagster: Connect Dagster+..." first.'
      );
    }
    return endpoint;
  }

  /** Multiple code locations at one target isn't handled interactively
   * here (a headless tool call can't show a QuickPick) -- picks the
   * first one, a reasonable default for the overwhelmingly common
   * single-code-location project. */
  async function firstSelector(endpoint: GraphQLEndpoint): Promise<RepositorySelectorInfo> {
    const selectors = await fetchRepositorySelectors(endpoint);
    if (selectors.length === 0) throw new Error('No code locations found at the current Dagster target.');
    return selectors[0];
  }

  context.subscriptions.push(
    vscode.lm.registerTool('dagster_list_assets', {
      invoke: async () => {
        const endpoint = await endpointOrThrow();
        const graph = await fetchAssetGraph(endpoint.url, endpoint.headers);
        return textResult(
          graph.nodes.map((n) => ({
            assetKey: n.assetKey,
            group: n.groupName,
            kinds: n.kinds,
            description: n.description,
            dependsOn: n.dependencyAssetKeys,
          }))
        );
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool<{ limit?: number; jobName?: string }>('dagster_list_runs', {
      invoke: async (options) => {
        const endpoint = await endpointOrThrow();
        const runs = await fetchRuns(endpoint, options.input.limit ?? 20, options.input.jobName);
        return textResult(runs);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool<{ runId: string }>('dagster_get_run_logs', {
      invoke: async (options) => {
        const endpoint = await endpointOrThrow();
        const logs = await fetchRunLogs(endpoint, options.input.runId, 200);
        return textResult(logs);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool('dagster_list_schedules_and_sensors', {
      invoke: async () => {
        const endpoint = await endpointOrThrow();
        const items = await fetchAutomations(endpoint.url, endpoint.headers);
        return textResult(items.map((i) => ({ kind: i.kind, name: i.name, status: i.status, cronSchedule: i.cronSchedule })));
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool<{ assetKey: string }>('dagster_materialize_asset', {
      prepareInvocation: (options) => ({
        invocationMessage: `Materializing asset "${options.input.assetKey}"...`,
        confirmationMessages: {
          title: 'Materialize asset?',
          message: `This launches a real Dagster run to materialize "${options.input.assetKey}" against the currently active target.`,
        },
      }),
      invoke: async (options) => {
        const endpoint = await endpointOrThrow();
        const selector = await firstSelector(endpoint);
        const outcome = await launchAssetRun(endpoint, selector, [options.input.assetKey.split('/')]);
        return textResult(outcome);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool<{ jobName: string }>('dagster_launch_job', {
      prepareInvocation: (options) => ({
        invocationMessage: `Launching job "${options.input.jobName}"...`,
        confirmationMessages: {
          title: 'Launch job?',
          message: `This launches a real Dagster run for job "${options.input.jobName}" against the currently active target.`,
        },
      }),
      invoke: async (options) => {
        const endpoint = await endpointOrThrow();
        const selector = await firstSelector(endpoint);
        const outcome = await launchJobRun(endpoint, selector, options.input.jobName);
        return textResult(outcome);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool<{ runId: string }>('dagster_terminate_run', {
      prepareInvocation: (options) => ({
        confirmationMessages: {
          title: 'Terminate run?',
          message: `This terminates run ${options.input.runId}. This cannot be undone.`,
        },
      }),
      invoke: async (options) => {
        const endpoint = await endpointOrThrow();
        const outcome = await terminateRunById(endpoint, options.input.runId);
        return textResult(outcome);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool<{ runId: string }>('dagster_retry_run', {
      prepareInvocation: (options) => ({
        confirmationMessages: {
          title: 'Retry run?',
          message: `This re-executes run ${options.input.runId} as a new run.`,
        },
      }),
      invoke: async (options) => {
        const endpoint = await endpointOrThrow();
        const outcome = await retryRun(endpoint, options.input.runId);
        return textResult(outcome);
      },
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool<{ name: string; kind: 'schedule' | 'sensor'; action: 'start' | 'stop' }>(
      'dagster_toggle_automation',
      {
        prepareInvocation: (options) => ({
          confirmationMessages: {
            title: `${options.input.action === 'start' ? 'Start' : 'Stop'} ${options.input.kind}?`,
            message: `This will ${options.input.action} the ${options.input.kind} "${options.input.name}" at the currently active target.`,
          },
        }),
        invoke: async (options) => {
          const endpoint = await endpointOrThrow();
          const { name, kind, action } = options.input;
          if (action === 'start') {
            const selector = await firstSelector(endpoint);
            const sel = { repositoryName: selector.repositoryName, repositoryLocationName: selector.repositoryLocationName, name };
            await (kind === 'schedule' ? startSchedule(endpoint.url, sel, endpoint.headers) : startSensor(endpoint.url, sel, endpoint.headers));
          } else {
            // Stopping needs the item's opaque id, not a name-based
            // selector -- same asymmetry confirmed via introspection
            // when this was first built for the tree's inline buttons.
            const items = await fetchAutomations(endpoint.url, endpoint.headers);
            const found = items.find((i) => i.kind === kind && i.name === name);
            if (!found) throw new Error(`${kind} "${name}" not found at the current target.`);
            await (kind === 'schedule' ? stopSchedule(endpoint.url, found.id, endpoint.headers) : stopSensor(endpoint.url, found.id, endpoint.headers));
          }
          return textResult({ success: true, name, kind, action });
        },
      }
    )
  );
}

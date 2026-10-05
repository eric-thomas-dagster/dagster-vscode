/**
 * Thin GraphQL client against a running `dg dev`/`dagster dev` webserver.
 * Deliberately not using a library (graphql-request, apollo, etc.) --
 * Node 18+ ships a global `fetch`, and the query surface here is small
 * enough that a dependency buys nothing yet. Revisit if the query surface
 * grows large enough that hand-written strings become error-prone.
 *
 * Query shapes below are verified against a real, running `dagster dev`
 * GraphQL schema (not guessed/ported blind from dg-vs-code's queries).
 */

export interface AssetCheckSummary {
  name: string;
  description: string | null;
}

export interface AssetNodeSummary {
  assetKey: string;
  groupName: string | null;
  description: string | null;
  kinds: string[];
  staleStatus: string | null;
  dependencyAssetKeys: string[];
  checks: AssetCheckSummary[];
}

export interface AssetGraphSummary {
  nodes: AssetNodeSummary[];
}

const ASSET_GRAPH_QUERY = `
  query DagsterPowerUserAssetGraph {
    assetNodes {
      assetKey { path }
      groupName
      description
      kinds
      staleStatus
      dependencies {
        asset { assetKey { path } }
      }
      assetChecksOrError {
        __typename
        ... on AssetChecks {
          checks { name description }
        }
      }
    }
  }
`;

async function postGraphQL<T>(
  url: string,
  query: string,
  timeoutMs = 10000,
  headers?: Record<string, string>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GraphQL request failed: HTTP ${res.status}`);
    }
    const body = await res.json() as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!body.data) {
      throw new Error('GraphQL response had no data.');
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

/** Cheap reachability probe -- a running dev server answers any valid
 * GraphQL query almost instantly; this is used purely to flip the status
 * bar between "not running"/"running", not to validate the schema. */
export async function checkServerHealth(graphqlUrl: string): Promise<boolean> {
  try {
    await postGraphQL(graphqlUrl, `query { __typename }`, 2000);
    return true;
  } catch {
    return false;
  }
}

export async function fetchAssetGraph(graphqlUrl: string, headers?: Record<string, string>): Promise<AssetGraphSummary> {
  interface RawAssetNode {
    assetKey: { path: string[] };
    groupName: string | null;
    description: string | null;
    kinds: string[];
    staleStatus: string | null;
    dependencies: Array<{ asset: { assetKey: { path: string[] } } }>;
    assetChecksOrError: { __typename: string; checks?: Array<{ name: string; description: string | null }> };
  }
  const data = await postGraphQL<{ assetNodes: RawAssetNode[] }>(graphqlUrl, ASSET_GRAPH_QUERY, 10000, headers);
  const nodes: AssetNodeSummary[] = data.assetNodes.map((n) => ({
    assetKey: n.assetKey.path.join('/'),
    groupName: n.groupName,
    description: n.description,
    kinds: n.kinds ?? [],
    staleStatus: n.staleStatus,
    dependencyAssetKeys: n.dependencies.map((d) => d.asset.assetKey.path.join('/')),
    checks: n.assetChecksOrError.__typename === 'AssetChecks' ? (n.assetChecksOrError.checks ?? []) : [],
  }));
  return { nodes };
}

/** `dg dev` doesn't always pick up a newly-written component/defs.yaml on
 * its own -- confirmed live, `reloadRepositoryLocation` is the real
 * mutation for forcing it (verified against a live schema, args =
 * `repositoryLocationName`, and the actual location name comes from
 * `repositoriesOrError[].location.name`, which matched the project's
 * folder name in testing but isn't assumed to always equal it). */
export async function fetchRepositoryLocationNames(graphqlUrl: string): Promise<string[]> {
  const data = await postGraphQL<{
    repositoriesOrError: { __typename: string; nodes?: Array<{ location: { name: string } }> };
  }>(graphqlUrl, `query { repositoriesOrError { __typename ... on RepositoryConnection { nodes { location { name } } } } }`);
  if (data.repositoriesOrError.__typename !== 'RepositoryConnection') return [];
  return [...new Set((data.repositoriesOrError.nodes ?? []).map((n) => n.location.name))];
}

export async function reloadRepositoryLocation(graphqlUrl: string, locationName: string): Promise<void> {
  await postGraphQL(
    graphqlUrl,
    `mutation { reloadRepositoryLocation(repositoryLocationName: ${JSON.stringify(locationName)}) { __typename } }`,
    15000
  );
}

export async function reloadAllRepositoryLocations(graphqlUrl: string): Promise<void> {
  const names = await fetchRepositoryLocationNames(graphqlUrl);
  for (const name of names) {
    try {
      await reloadRepositoryLocation(graphqlUrl, name);
    } catch {
      // Best-effort -- a stale location name or a location that's
      // already reloading shouldn't block the rest.
    }
  }
}

export type PrimitiveKind = 'job' | 'schedule' | 'sensor' | 'op' | 'resource' | 'ioManager';

export interface PrimitiveSummary {
  kind: PrimitiveKind;
  name: string;
  description: string | null;
  /** Schedule-only: its cron expression, shown in hover. */
  cronSchedule?: string | null;
  /** Schedule/sensor only -- needed to start/stop it from the tree. */
  id?: string;
  status?: InstigationStatus;
  repositoryName?: string;
  repositoryLocationName?: string;
  /** Resource/ioManager only -- the fully-qualified Python class name,
   * e.g. "dagster_duckdb.DuckDBResource". `kind` is already split into
   * 'resource' vs 'ioManager' at fetch time by checking this string, so
   * nothing downstream has to re-derive it. */
  resourceType?: string;
}

// Field names verified live against a real `dg dev` schema via
// introspection (Repository.{jobs,schedules,sensors,usedSolids}) before
// writing this -- "jobs" and "usedSolids" (ops) are Dagster's own
// internal names for these concepts (Pipeline/Solid historically), not a
// guess. `id`/`scheduleState`/`sensorState` added for start/stop
// (ScheduleSelector/SensorSelector need repositoryName +
// repositoryLocationName, confirmed live via introspection).
const PRIMITIVES_QUERY = `
  query DagsterPowerUserPrimitives {
    repositoriesOrError {
      __typename
      ... on RepositoryConnection {
        nodes {
          name
          location { name }
          jobs { name description }
          schedules { id name description cronSchedule scheduleState { status } }
          sensors { id name description sensorState { status } }
          usedSolids { definition { name description } }
        }
      }
      ... on PythonError {
        message
      }
    }
  }
`;

/** Resources (and IO managers, which the API treats as plain resources --
 * there's no separate concept) live behind a SEPARATE query that takes an
 * explicit repositorySelector, unlike jobs/schedules/sensors which are
 * fields on the Repository type itself -- confirmed live via
 * introspection, so this is a second round trip per repository found
 * above, not something that can be folded into PRIMITIVES_QUERY. Also
 * confirmed live: this returns an EMPTY list for component-based
 * projects (e.g. ones using `dg scaffold`'s component YAML) since
 * `isTopLevel`/this API only sees resources bound the classic
 * `Definitions(resources={...})` way -- an expected gap in the API
 * itself, not a bug here.
 */
async function fetchResourcesForRepo(
  graphqlUrl: string,
  repositoryName: string,
  repositoryLocationName: string,
  headers?: Record<string, string>
): Promise<PrimitiveSummary[]> {
  const query = `
    query DagsterPowerUserResources {
      allTopLevelResourceDetailsOrError(
        repositorySelector: {
          repositoryName: ${JSON.stringify(repositoryName)}
          repositoryLocationName: ${JSON.stringify(repositoryLocationName)}
        }
      ) {
        __typename
        ... on ResourceDetailsList {
          results { name description resourceType }
        }
      }
    }
  `;
  try {
    const data = await postGraphQL<{
      allTopLevelResourceDetailsOrError: {
        __typename: string;
        results?: Array<{ name: string; description: string | null; resourceType: string }>;
      };
    }>(graphqlUrl, query, 10000, headers);
    if (data.allTopLevelResourceDetailsOrError.__typename !== 'ResourceDetailsList') return [];
    return (data.allTopLevelResourceDetailsOrError.results ?? []).map((r) => ({
      kind: (r.resourceType.includes('IOManager') ? 'ioManager' : 'resource') as PrimitiveKind,
      name: r.name,
      description: r.description,
      resourceType: r.resourceType,
    }));
  } catch {
    return [];
  }
}

/** `usedSolids` has no `name` field of its own -- confirmed live via
 * introspection: it's `{ definition: ISolidDefinition, invocations }`,
 * and `ISolidDefinition` is where `name`/`description` actually live. */
export async function fetchPrimitives(
  graphqlUrl: string,
  knownAssetKeys: ReadonlySet<string>,
  headers?: Record<string, string>
): Promise<PrimitiveSummary[]> {
  interface RawRepo {
    name: string;
    location: { name: string };
    jobs: Array<{ name: string; description: string | null }>;
    schedules: Array<{
      id: string;
      name: string;
      description: string | null;
      cronSchedule: string | null;
      scheduleState: { status: InstigationStatus };
    }>;
    sensors: Array<{ id: string; name: string; description: string | null; sensorState: { status: InstigationStatus } }>;
    usedSolids: Array<{ definition: { name: string; description: string | null } }>;
  }
  const data = await postGraphQL<{
    repositoriesOrError: { __typename: string; nodes?: RawRepo[]; message?: string };
  }>(graphqlUrl, PRIMITIVES_QUERY, 10000, headers);

  // Confirmed live: a real import/definition error comes back as a
  // well-formed HTTP 200 with `repositoriesOrError.__typename ===
  // "PythonError"` -- NOT a top-level GraphQL `errors[]` entry, so
  // postGraphQL's own error handling never sees it. Silently returning []
  // here (the previous behavior) is exactly why the extension used to
  // show "0 definitions" with no indication anything was wrong.
  if (data.repositoriesOrError.__typename === 'PythonError') {
    throw new Error(data.repositoriesOrError.message ?? 'Dagster: failed to load repository definitions.');
  }
  if (data.repositoriesOrError.__typename !== 'RepositoryConnection') return [];
  const primitives: PrimitiveSummary[] = [];
  for (const repo of data.repositoriesOrError.nodes ?? []) {
    for (const j of repo.jobs) {
      // `__ASSET_JOB` is Dagster's own implicit job wrapping every asset
      // with no explicit job -- confirmed live, not a real user-defined
      // job, so showing it as one would just be confusing noise.
      if (j.name === '__ASSET_JOB') continue;
      primitives.push({ kind: 'job', name: j.name, description: j.description });
    }
    for (const s of repo.schedules) {
      primitives.push({
        kind: 'schedule',
        name: s.name,
        description: s.description,
        cronSchedule: s.cronSchedule,
        id: s.id,
        status: s.scheduleState.status,
        repositoryName: repo.name,
        repositoryLocationName: repo.location.name,
      });
    }
    for (const s of repo.sensors) {
      primitives.push({
        kind: 'sensor',
        name: s.name,
        description: s.description,
        id: s.id,
        status: s.sensorState.status,
        repositoryName: repo.name,
        repositoryLocationName: repo.location.name,
      });
    }
    for (const op of repo.usedSolids) {
      // Every asset has its own auto-generated backing op of the same
      // name (confirmed live: raw_customers/stg_customers/customer_ltv
      // all appeared here too), and every asset CHECK gets one named
      // "<asset_key>_<check_name>" (confirmed live: customer_ltv's
      // ltv_non_negative check backed an op literally named
      // "customer_ltv_ltv_non_negative" -- not a real function anywhere,
      // go-to-definition correctly can't find it). Filtering both leaves
      // only ops someone actually wrote with `@op`.
      const name = op.definition.name;
      if (knownAssetKeys.has(name)) continue;
      const isCheckBackingOp = [...knownAssetKeys].some((key) => name.startsWith(`${key}_`));
      if (isCheckBackingOp) continue;
      primitives.push({ kind: 'op', name, description: op.definition.description });
    }
    primitives.push(...(await fetchResourcesForRepo(graphqlUrl, repo.name, repo.location.name, headers)));
  }
  return primitives;
}

// ---- Schedule/sensor control (separate from the hover/go-to-def index
// above -- this is live status + start/stop, fetched fresh on demand
// rather than riding the cached PrimitiveIndexStore). Shared between the
// local dev server (this file) and Dagster+ (dagsterPlusClient.ts, which
// posts this exact same query/mutation strings to a deployment-scoped
// URL with its own auth header) -- confirmed live that Dagster+ exposes
// the identical mutations, so the query text itself is exported for
// reuse rather than duplicated.
export type InstigationStatus = 'RUNNING' | 'STOPPED';

export interface AutomationItem {
  kind: 'schedule' | 'sensor';
  id: string;
  name: string;
  description: string | null;
  status: InstigationStatus;
  cronSchedule?: string | null;
  repositoryName: string;
  repositoryLocationName: string;
}

export const AUTOMATIONS_QUERY = `
  query DagsterPowerUserAutomations {
    repositoriesOrError {
      __typename
      ... on RepositoryConnection {
        nodes {
          name
          location { name }
          schedules { id name description cronSchedule scheduleState { status } }
          sensors { id name description sensorState { status } }
        }
      }
    }
  }
`;

export interface AutomationsRaw {
  repositoriesOrError: {
    __typename: string;
    nodes?: Array<{
      name: string;
      location: { name: string };
      schedules: Array<{
        id: string;
        name: string;
        description: string | null;
        cronSchedule: string | null;
        scheduleState: { status: InstigationStatus };
      }>;
      sensors: Array<{ id: string; name: string; description: string | null; sensorState: { status: InstigationStatus } }>;
    }>;
  };
}

export function parseAutomationsResult(data: AutomationsRaw): AutomationItem[] {
  if (data.repositoriesOrError.__typename !== 'RepositoryConnection') return [];
  const items: AutomationItem[] = [];
  for (const repo of data.repositoriesOrError.nodes ?? []) {
    for (const s of repo.schedules) {
      items.push({
        kind: 'schedule',
        id: s.id,
        name: s.name,
        description: s.description,
        cronSchedule: s.cronSchedule,
        status: s.scheduleState.status,
        repositoryName: repo.name,
        repositoryLocationName: repo.location.name,
      });
    }
    for (const s of repo.sensors) {
      items.push({
        kind: 'sensor',
        id: s.id,
        name: s.name,
        description: s.description,
        status: s.sensorState.status,
        repositoryName: repo.name,
        repositoryLocationName: repo.location.name,
      });
    }
  }
  return items;
}

export async function fetchAutomations(graphqlUrl: string, headers?: Record<string, string>): Promise<AutomationItem[]> {
  const data = await postGraphQL<AutomationsRaw>(graphqlUrl, AUTOMATIONS_QUERY, 10000, headers);
  return parseAutomationsResult(data);
}

export interface InstigatorSelector {
  repositoryName: string;
  repositoryLocationName: string;
  name: string;
}

/** Selector-based (start) vs id-based (stop) because that's what the
 * live schema actually requires -- confirmed via introspection, not
 * symmetric by choice. */
export async function startSchedule(
  graphqlUrl: string,
  selector: InstigatorSelector,
  headers?: Record<string, string>
): Promise<void> {
  await postGraphQL(
    graphqlUrl,
    `mutation {
      startSchedule(scheduleSelector: {
        repositoryName: ${JSON.stringify(selector.repositoryName)}
        repositoryLocationName: ${JSON.stringify(selector.repositoryLocationName)}
        scheduleName: ${JSON.stringify(selector.name)}
      }) { __typename }
    }`,
    10000,
    headers
  );
}

export async function stopSchedule(graphqlUrl: string, scheduleId: string, headers?: Record<string, string>): Promise<void> {
  await postGraphQL(graphqlUrl, `mutation { stopRunningSchedule(id: ${JSON.stringify(scheduleId)}) { __typename } }`, 10000, headers);
}

export async function startSensor(
  graphqlUrl: string,
  selector: InstigatorSelector,
  headers?: Record<string, string>
): Promise<void> {
  await postGraphQL(
    graphqlUrl,
    `mutation {
      startSensor(sensorSelector: {
        repositoryName: ${JSON.stringify(selector.repositoryName)}
        repositoryLocationName: ${JSON.stringify(selector.repositoryLocationName)}
        sensorName: ${JSON.stringify(selector.name)}
      }) { __typename }
    }`,
    10000,
    headers
  );
}

export async function stopSensor(graphqlUrl: string, sensorId: string, headers?: Record<string, string>): Promise<void> {
  await postGraphQL(graphqlUrl, `mutation { stopSensor(id: ${JSON.stringify(sensorId)}) { __typename } }`, 10000, headers);
}

// ---- Target-aware run launching (Local / Dagster OSS remote / Dagster+
// all speak the exact same `launchRun` mutation -- confirmed live against
// both a local `dg dev` and the user's real Dagster+ org -- so one
// implementation covers all three; only the endpoint's URL/headers
// differ, which is what GraphQLEndpoint carries.)

export interface GraphQLEndpoint {
  url: string;
  headers?: Record<string, string>;
}

export interface RepositorySelectorInfo {
  repositoryName: string;
  repositoryLocationName: string;
}

export async function fetchRepositorySelectors(endpoint: GraphQLEndpoint): Promise<RepositorySelectorInfo[]> {
  const data = await postGraphQL<{
    repositoriesOrError: {
      __typename: string;
      nodes?: Array<{ name: string; location: { name: string } }>;
      message?: string;
    };
  }>(
    endpoint.url,
    `{ repositoriesOrError { __typename ... on RepositoryConnection { nodes { name location { name } } } ... on PythonError { message } } }`,
    10000,
    endpoint.headers
  );
  if (data.repositoriesOrError.__typename === 'PythonError') {
    throw new Error(data.repositoriesOrError.message ?? 'Dagster: failed to list repositories.');
  }
  if (data.repositoriesOrError.__typename !== 'RepositoryConnection') return [];
  return (data.repositoriesOrError.nodes ?? []).map((n) => ({
    repositoryName: n.name,
    repositoryLocationName: n.location.name,
  }));
}

export interface LaunchRunOutcome {
  success: boolean;
  runId?: string;
  message: string;
}

/** `__ASSET_JOB` (materializing assets) vs a real job name both go
 * through the same `launchRun` mutation -- confirmed live, a real run
 * queued with a real runId for both shapes -- only `assetSelection` vs a
 * bare jobName differs in the selector. */
async function runLaunchRunMutation(endpoint: GraphQLEndpoint, selectorFields: string): Promise<LaunchRunOutcome> {
  const query = `mutation {
    launchRun(executionParams: { selector: { ${selectorFields} } }) {
      __typename
      ... on LaunchRunSuccess { run { runId status } }
      ... on PythonError { message }
      ... on RunConfigValidationInvalid { errors { message } }
      ... on PipelineNotFoundError { message }
      ... on RunConflict { message }
      ... on UnauthorizedError { message }
      ... on InvalidSubsetError { message }
    }
  }`;
  const data = await postGraphQL<{
    launchRun: {
      __typename: string;
      run?: { runId: string; status: string };
      message?: string;
      errors?: Array<{ message: string }>;
    };
  }>(endpoint.url, query, 15000, endpoint.headers);
  const result = data.launchRun;
  if (result.__typename === 'LaunchRunSuccess' && result.run) {
    return { success: true, runId: result.run.runId, message: `Run ${result.run.runId} queued (${result.run.status}).` };
  }
  const message = result.message ?? result.errors?.map((e) => e.message).join('; ') ?? `Launch failed (${result.__typename}).`;
  return { success: false, message };
}

export async function launchAssetRun(
  endpoint: GraphQLEndpoint,
  selector: RepositorySelectorInfo,
  assetKeyPaths: string[][]
): Promise<LaunchRunOutcome> {
  const assetSelectionGraphQL = assetKeyPaths.map((path) => `{ path: ${JSON.stringify(path)} }`).join(', ');
  return runLaunchRunMutation(
    endpoint,
    `jobName: "__ASSET_JOB", repositoryName: ${JSON.stringify(selector.repositoryName)}, repositoryLocationName: ${JSON.stringify(selector.repositoryLocationName)}, assetSelection: [${assetSelectionGraphQL}]`
  );
}

export async function launchJobRun(
  endpoint: GraphQLEndpoint,
  selector: RepositorySelectorInfo,
  jobName: string
): Promise<LaunchRunOutcome> {
  return runLaunchRunMutation(
    endpoint,
    `jobName: ${JSON.stringify(jobName)}, repositoryName: ${JSON.stringify(selector.repositoryName)}, repositoryLocationName: ${JSON.stringify(selector.repositoryLocationName)}`
  );
}

// ---- Run explorer: list/view/terminate/retry runs -- same target-aware
// endpoint concept as everything above. All fields/mutations verified
// live (real run data, a real retry that queued a genuinely new run,
// and real structured log events) before being written down.

export type RunStatus =
  | 'QUEUED'
  | 'NOT_STARTED'
  | 'MANAGED'
  | 'STARTING'
  | 'STARTED'
  | 'SUCCESS'
  | 'FAILURE'
  | 'CANCELING'
  | 'CANCELED';

export interface RunSummary {
  runId: string;
  status: RunStatus;
  jobName: string;
  creationTime: number;
  startTime: number | null;
  endTime: number | null;
  canTerminate: boolean;
  hasReExecutePermission: boolean;
  hasTerminatePermission: boolean;
}

export async function fetchRuns(endpoint: GraphQLEndpoint, limit = 30, jobName?: string): Promise<RunSummary[]> {
  // `pipelineName` is the real, confirmed-live RunsFilter field for this
  // -- Dagster kept the historical "pipeline" name in the filter even
  // though it filters by job.
  const filterArg = jobName ? `filter: { pipelineName: ${JSON.stringify(jobName)} }, ` : '';
  const query = `
    query DagsterPowerUserRuns {
      runsOrError(${filterArg}limit: ${limit}) {
        __typename
        ... on Runs {
          results {
            runId
            status
            jobName
            creationTime
            startTime
            endTime
            canTerminate
            hasReExecutePermission
            hasTerminatePermission
          }
        }
        ... on PythonError { message }
      }
    }
  `;
  const data = await postGraphQL<{
    runsOrError: { __typename: string; results?: RunSummary[]; message?: string };
  }>(endpoint.url, query, 10000, endpoint.headers);
  if (data.runsOrError.__typename === 'PythonError') {
    throw new Error(data.runsOrError.message ?? 'Dagster: failed to list runs.');
  }
  return data.runsOrError.results ?? [];
}

export interface RunLogEntry {
  message: string;
  /** Epoch milliseconds -- confirmed live the API returns this as a
   * numeric STRING, not a Float like the Run type's own timestamps. */
  timestamp: string;
  level: string;
  stepKey: string | null;
  eventType: string | null;
}

export async function fetchRunLogs(endpoint: GraphQLEndpoint, runId: string, limit = 200): Promise<RunLogEntry[]> {
  const query = `
    query DagsterPowerUserRunLogs {
      logsForRun(runId: ${JSON.stringify(runId)}, limit: ${limit}) {
        __typename
        ... on EventConnection {
          events { __typename ... on MessageEvent { message timestamp level stepKey eventType } }
        }
        ... on PythonError { message }
      }
    }
  `;
  const data = await postGraphQL<{
    logsForRun: { __typename: string; events?: RunLogEntry[]; message?: string };
  }>(endpoint.url, query, 10000, endpoint.headers);
  if (data.logsForRun.__typename === 'PythonError') {
    throw new Error(data.logsForRun.message ?? 'Dagster: failed to load run logs.');
  }
  return data.logsForRun.events ?? [];
}

export interface MutationOutcome {
  success: boolean;
  message: string;
}

export async function terminateRunById(endpoint: GraphQLEndpoint, runId: string): Promise<MutationOutcome> {
  const query = `mutation { terminateRun(runId: ${JSON.stringify(runId)}) { __typename ... on TerminateRunSuccess { run { runId } } ... on PythonError { message } ... on RunNotFoundError { message } ... on UnauthorizedError { message } } }`;
  const data = await postGraphQL<{ terminateRun: { __typename: string; message?: string } }>(
    endpoint.url,
    query,
    10000,
    endpoint.headers
  );
  if (data.terminateRun.__typename === 'TerminateRunSuccess') {
    return { success: true, message: 'Run terminated.' };
  }
  return { success: false, message: data.terminateRun.message ?? `Terminate failed (${data.terminateRun.__typename}).` };
}

export async function retryRun(endpoint: GraphQLEndpoint, parentRunId: string): Promise<LaunchRunOutcome> {
  const query = `mutation {
    launchRunReexecution(reexecutionParams: { parentRunId: ${JSON.stringify(parentRunId)}, strategy: ALL_STEPS }) {
      __typename
      ... on LaunchRunSuccess { run { runId status } }
      ... on PythonError { message }
      ... on RunConfigValidationInvalid { errors { message } }
      ... on UnauthorizedError { message }
      ... on ConflictingExecutionParamsError { message }
    }
  }`;
  const data = await postGraphQL<{
    launchRunReexecution: {
      __typename: string;
      run?: { runId: string; status: string };
      message?: string;
      errors?: Array<{ message: string }>;
    };
  }>(endpoint.url, query, 15000, endpoint.headers);
  const result = data.launchRunReexecution;
  if (result.__typename === 'LaunchRunSuccess' && result.run) {
    return { success: true, runId: result.run.runId, message: `Retried as ${result.run.runId} (${result.run.status}).` };
  }
  const message = result.message ?? result.errors?.map((e) => e.message).join('; ') ?? `Retry failed (${result.__typename}).`;
  return { success: false, message };
}

/** The webserver UI and the GraphQL API are served from the same host --
 * confirmed live (both `/graphql` and `/runs/<id>` respond on the same
 * port). Dagster's run/asset page routes (`/runs/<id>`, `/assets/<path>`)
 * are stable, long-standing conventions used identically by Dagster OSS
 * and Dagster+. */
export function deriveWebBaseUrl(graphqlUrl: string): string {
  return graphqlUrl.replace(/\/graphql\/?$/, '');
}

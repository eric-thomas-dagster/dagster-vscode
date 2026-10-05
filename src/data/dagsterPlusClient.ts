import * as vscode from 'vscode';
import {
  AUTOMATIONS_QUERY,
  parseAutomationsResult,
  type AutomationItem,
  type AutomationsRaw,
  type InstigatorSelector,
} from './graphqlClient';

/**
 * Thin GraphQL client against the real Dagster+ (Cloud) API -- same
 * "no library, hand-written queries" choice as graphqlClient.ts, and same
 * verified-live-against-a-real-schema discipline: every field here was
 * confirmed via introspection + a real populated query against a live org
 * before being written down, not guessed from docs.
 *
 * Endpoint shape: `https://{org}.dagster.cloud/graphql` 307-redirects to
 * `/{deployment}/graphql` -- querying the deployment-qualified URL
 * directly avoids following a redirect on every call. Auth is a single
 * `Dagster-Cloud-Api-Token` header, sent exactly as the user's token is
 * stored (including any `user:`/`agent:` prefix it already has).
 */

const TOKEN_SECRET = 'dagsterPowerUser.dagsterPlusApiToken';

export interface DagsterPlusCredentials {
  org: string;
  token: string;
  deployment: string;
}

export async function hasDagsterPlusCredentials(context: vscode.ExtensionContext): Promise<boolean> {
  const org = vscode.workspace.getConfiguration('dagsterPowerUser').get<string>('dagsterPlusOrg');
  const token = await context.secrets.get(TOKEN_SECRET);
  return !!org && !!token;
}

export async function getDagsterPlusCredentials(
  context: vscode.ExtensionContext
): Promise<DagsterPlusCredentials | undefined> {
  const config = vscode.workspace.getConfiguration('dagsterPowerUser');
  const org = config.get<string>('dagsterPlusOrg');
  const deployment = config.get<string>('dagsterPlusDeployment') || 'prod';
  const token = await context.secrets.get(TOKEN_SECRET);
  if (!org || !token) return undefined;
  return { org, token, deployment };
}

/** Org slug is not secret (it's visible in the org's own dashboard URL) --
 * a plain setting. The API token always goes through SecretStorage, never
 * settings.json, mirroring setApiKey()'s pattern in ai/llmClient.ts. */
export async function setDagsterPlusCredentials(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('dagsterPowerUser');
  const org = await vscode.window.showInputBox({
    title: 'Dagster+ Organization',
    prompt: 'Your Dagster+ org slug, e.g. "my-org" from my-org.dagster.cloud',
    value: config.get<string>('dagsterPlusOrg') ?? '',
    ignoreFocusOut: true,
  });
  if (org === undefined) return;
  await config.update('dagsterPlusOrg', org.trim(), vscode.ConfigurationTarget.Global);

  const token = await vscode.window.showInputBox({
    title: 'Dagster+ API Token',
    prompt: 'A user or agent token from Organization Settings > Tokens',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'user:... or agent:...',
  });
  if (!token) return;
  await context.secrets.store(TOKEN_SECRET, token.trim());
  vscode.window.showInformationMessage('Dagster: Dagster+ credentials saved.');
}

async function postGraphQL<T>(creds: DagsterPlusCredentials, query: string, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${creds.org}.dagster.cloud/${creds.deployment}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Dagster-Cloud-Api-Token': creds.token,
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Dagster+ request failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new Error(`Dagster+ GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!body.data) {
      throw new Error('Dagster+ response had no data.');
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

export interface CreditUsagePoint {
  /** Unix seconds */
  start: number;
  /** Unix seconds */
  end: number;
  value: number;
}

export interface CreditLimit {
  used: number;
  limit: number;
  /** Unix seconds, when available */
  periodStart?: number;
  periodEnd?: number;
  source: 'stripe' | 'enterprise';
}

export interface DagsterPlusUsage {
  planType: string | null;
  monthly: CreditUsagePoint[];
  /** Absent when the org has neither a Stripe subscription nor an
   * enterprise contract on file (observed live for an internal/demo org) --
   * the UI falls back to showing relative history with no hard cap line. */
  limit?: CreditLimit;
}

interface UsageQueryResult {
  planType: string | null;
  usageMetrics: {
    dagsterCredits: {
      unit: string;
      metrics: Array<{ startTimestamp: number; endTimestamp: number; value: number }>;
    };
  };
  customerInfo:
    | { __typename: 'CustomerInfo'; stripeSubscription: { creditUsage: number; creditLimit: number; billingPeriodStart: number; billingPeriodEnd: number } | null }
    | { __typename: string };
  enterpriseContractMetadata:
    | { __typename: 'EnterpriseContractMetadata'; creditsUsed: number; annualCredits: number | null; creditsContractedWithRollover: number | null; startDate: number; endDate: number }
    | { __typename: string };
}

const USAGE_QUERY = `
  query DagsterPowerUserUsage {
    planType
    usageMetrics {
      dagsterCredits(timeGranularity: MONTH) {
        unit
        metrics { startTimestamp endTimestamp value }
      }
    }
    customerInfo {
      __typename
      ... on CustomerInfo {
        stripeSubscription {
          creditUsage
          creditLimit
          billingPeriodStart
          billingPeriodEnd
        }
      }
    }
    enterpriseContractMetadata {
      __typename
      ... on EnterpriseContractMetadata {
        creditsUsed
        annualCredits
        creditsContractedWithRollover
        startDate
        endDate
      }
    }
  }
`;

export async function getDagsterPlusUsage(creds: DagsterPlusCredentials): Promise<DagsterPlusUsage> {
  const data = await postGraphQL<UsageQueryResult>(creds, USAGE_QUERY);

  const monthly = data.usageMetrics.dagsterCredits.metrics.map((m) => ({
    start: m.startTimestamp,
    end: m.endTimestamp,
    value: m.value,
  }));

  let limit: CreditLimit | undefined;
  if (data.customerInfo.__typename === 'CustomerInfo' && 'stripeSubscription' in data.customerInfo && data.customerInfo.stripeSubscription) {
    const sub = data.customerInfo.stripeSubscription;
    limit = {
      used: sub.creditUsage,
      limit: sub.creditLimit,
      periodStart: sub.billingPeriodStart,
      periodEnd: sub.billingPeriodEnd,
      source: 'stripe',
    };
  } else if (data.enterpriseContractMetadata.__typename === 'EnterpriseContractMetadata' && 'creditsUsed' in data.enterpriseContractMetadata) {
    const contract = data.enterpriseContractMetadata;
    const cap = contract.creditsContractedWithRollover ?? contract.annualCredits;
    if (cap != null) {
      limit = {
        used: contract.creditsUsed,
        limit: cap,
        periodStart: contract.startDate,
        periodEnd: contract.endDate,
        source: 'enterprise',
      };
    }
  }

  return { planType: data.planType, monthly, limit };
}

/** Lightweight shape for the chat sidebar's compact usage bar -- same
 * underlying query as getDagsterPlusUsage() (the payload is tiny either
 * way) but trimmed down to just what a one-line summary needs, so
 * call sites don't have to know about the full DagsterPlusUsage shape. */
export type DagsterPlusUsageSummary =
  | { state: 'disconnected' }
  | { state: 'no-limit'; planType: string | null }
  | { state: 'limit'; planType: string | null; used: number; limit: number }
  | { state: 'error' };

export async function getDagsterPlusUsageSummary(context: vscode.ExtensionContext): Promise<DagsterPlusUsageSummary> {
  const creds = await getDagsterPlusCredentials(context);
  if (!creds) return { state: 'disconnected' };
  try {
    const usage = await getDagsterPlusUsage(creds);
    if (!usage.limit) return { state: 'no-limit', planType: usage.planType };
    return { state: 'limit', planType: usage.planType, used: usage.limit.used, limit: usage.limit.limit };
  } catch {
    return { state: 'error' };
  }
}

// ---- Deployments + schedule/sensor control. An org can have several
// deployments (confirmed live: this one has "dev", "prod", and a branch
// deployment) -- a schedule lives in exactly one, so managing it has to
// start with picking which deployment, unlike the local dev-server case
// where there's only ever one.

export interface DagsterPlusDeployment {
  name: string;
  type: string;
}

export async function listDagsterPlusDeployments(creds: DagsterPlusCredentials): Promise<DagsterPlusDeployment[]> {
  const data = await postGraphQL<{ deployments: Array<{ deploymentName: string; deploymentType: string }> }>(
    creds,
    `{ deployments { deploymentName deploymentType } }`
  );
  return data.deployments.map((d) => ({ name: d.deploymentName, type: d.deploymentType }));
}

function withDeployment(creds: DagsterPlusCredentials, deployment: string): DagsterPlusCredentials {
  return { ...creds, deployment };
}

export async function fetchDagsterPlusAutomations(
  creds: DagsterPlusCredentials,
  deployment: string
): Promise<AutomationItem[]> {
  const data = await postGraphQL<AutomationsRaw>(withDeployment(creds, deployment), AUTOMATIONS_QUERY);
  return parseAutomationsResult(data);
}

export async function startDagsterPlusSchedule(
  creds: DagsterPlusCredentials,
  deployment: string,
  selector: InstigatorSelector
): Promise<void> {
  await postGraphQL(
    withDeployment(creds, deployment),
    `mutation { startSchedule(scheduleSelector: ${JSON.stringify({
      repositoryName: selector.repositoryName,
      repositoryLocationName: selector.repositoryLocationName,
      scheduleName: selector.name,
    })}) { __typename } }`
  );
}

export async function stopDagsterPlusSchedule(
  creds: DagsterPlusCredentials,
  deployment: string,
  scheduleId: string
): Promise<void> {
  await postGraphQL(
    withDeployment(creds, deployment),
    `mutation { stopRunningSchedule(id: ${JSON.stringify(scheduleId)}) { __typename } }`
  );
}

export async function startDagsterPlusSensor(
  creds: DagsterPlusCredentials,
  deployment: string,
  selector: InstigatorSelector
): Promise<void> {
  await postGraphQL(
    withDeployment(creds, deployment),
    `mutation { startSensor(sensorSelector: ${JSON.stringify({
      repositoryName: selector.repositoryName,
      repositoryLocationName: selector.repositoryLocationName,
      sensorName: selector.name,
    })}) { __typename } }`
  );
}

export async function stopDagsterPlusSensor(
  creds: DagsterPlusCredentials,
  deployment: string,
  sensorId: string
): Promise<void> {
  await postGraphQL(withDeployment(creds, deployment), `mutation { stopSensor(id: ${JSON.stringify(sensorId)}) { __typename } }`);
}

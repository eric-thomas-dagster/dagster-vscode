import * as vscode from 'vscode';

const STORAGE_KEY = 'dagsterPowerUser.usageTotals';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTotals extends TokenUsage {
  requestCount: number;
}

/** Module-level singleton (not a class instance threaded through every
 * call site) -- this is just an append-only counter against the user's
 * OWN API key, not billing/account infra of our own (we're standalone,
 * no backend to meter against). Persisted via globalState so it survives
 * reloads, same as chat sessions. */
let context: vscode.ExtensionContext | undefined;
const emitter = new vscode.EventEmitter<void>();
export const onDidChangeUsage = emitter.event;

export function initUsageTracker(ctx: vscode.ExtensionContext): void {
  context = ctx;
}

export function getUsageTotals(): UsageTotals {
  return context?.globalState.get<UsageTotals>(STORAGE_KEY, { inputTokens: 0, outputTokens: 0, requestCount: 0 }) ?? {
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
  };
}

export async function recordUsage(usage: TokenUsage): Promise<void> {
  if (!context) return;
  const totals = getUsageTotals();
  const next: UsageTotals = {
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    requestCount: totals.requestCount + 1,
  };
  await context.globalState.update(STORAGE_KEY, next);
  emitter.fire();
}

export async function resetUsage(): Promise<void> {
  if (!context) return;
  await context.globalState.update(STORAGE_KEY, { inputTokens: 0, outputTokens: 0, requestCount: 0 });
  emitter.fire();
}

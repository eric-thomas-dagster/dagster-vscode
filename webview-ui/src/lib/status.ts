// Real Dagster+ check-history events use "failed"/"succeeded"/"skipped"
// (not the shorter "fail"/"pass" narrow string-equality checks scattered
// across this codebase were originally written against locally) --
// classifying a status through one shared function instead of matching
// per call site avoids silently falling through to an "unknown" default
// for values a call site's author didn't happen to test against.
export type StatusBucket = 'success' | 'failure' | 'warning' | 'skipped' | 'unknown';

export function classifyStatus(status: string | null | undefined): StatusBucket {
  const s = (status || '').toLowerCase();
  if (s === 'pass' || s === 'success' || s === 'succeeded' || s === 'ok') return 'success';
  if (s === 'fail' || s === 'failed' || s === 'failure' || s === 'error' || s === 'runtime error') return 'failure';
  if (s === 'warn' || s === 'warning') return 'warning';
  if (s === 'skip' || s === 'skipped') return 'skipped';
  return 'unknown';
}

export function statusTextClass(status: string | null | undefined): string {
  const c = classifyStatus(status);
  if (c === 'success') return 'text-emerald-700';
  if (c === 'failure') return 'text-rose-700';
  if (c === 'warning') return 'text-amber-700';
  if (c === 'skipped') return 'text-gray-500';
  return 'text-gray-800';
}

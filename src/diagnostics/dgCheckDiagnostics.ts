import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DG_CHECK_TIMEOUT_MS = 30000;
const DEBOUNCE_MS = 1500;
const DIAGNOSTIC_OWNER = 'dg-check';

/**
 * Real `dg check defs` output, not a guess -- captured against a live
 * project with an actual ImportError injected:
 *
 *   dagster - ERROR - Validation failed for code location <name>:
 *
 *   dagster._core.errors.DagsterImportError: Encountered ImportError: ...
 *
 *   Stack Trace:
 *     [N dagster system frames hidden, run with --verbose ...]
 *
 *   The above exception was caused by the following exception:
 *   ModuleNotFoundError: No module named '...'
 *
 *   Stack Trace:
 *     [N dagster system frames hidden, ...]
 *     File "/abs/path/definitions.py", line 21, in <module>
 *       import this_module_does_not_exist_at_all
 *
 *   dagster - ERROR - Validation for 1 code locations failed.
 *
 * Dagster itself hides its own internal stack frames and only prints the
 * user's own file/line -- so the LAST "File ..., line N" in a block is
 * reliably the actual offending location, not implementation detail. A
 * block with no File line at all (a config/YAML-level error) still gets
 * surfaced via the output channel rather than silently dropped.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface DgCheckIssue {
  message: string;
  filePath: string | null;
  line: number | null;
}

export function parseDgCheckOutput(raw: string): DgCheckIssue[] {
  const text = stripAnsi(raw);
  const issues: DgCheckIssue[] = [];
  const blockRe = /Validation failed for code location [^\n:]+:\n([\s\S]*?)(?=\nValidation failed for code location|\n.*Validation for \d+ code locations|$)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    const block = m[1];
    const msgMatch = block.match(/^\s*([A-Za-z_.]*(?:Error|Exception)):\s*(.+)$/m);
    const message = msgMatch ? `${msgMatch[1]}: ${msgMatch[2]}`.trim() : block.trim().split('\n')[0]?.trim() || 'Validation failed.';
    const fileMatches = [...block.matchAll(/File "([^"]+)", line (\d+)/g)];
    const last = fileMatches[fileMatches.length - 1];
    issues.push({
      message,
      filePath: last ? last[1] : null,
      line: last ? parseInt(last[2], 10) : null,
    });
  }
  return issues;
}

async function runDgCheckDefs(dgPath: string, cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(dgPath, ['check', 'defs'], {
      cwd,
      timeout: DG_CHECK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch (e: any) {
    // dg exits 1 on validation failure -- execFile treats that as a
    // rejected promise, but its stdout/stderr are exactly what we want
    // to parse, not an error to swallow.
    return `${e?.stdout ?? ''}\n${e?.stderr ?? ''}`;
  }
}

export class DgCheckDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_OWNER);
  private debounceHandle: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastIssues: DgCheckIssue[] = [];

  constructor(
    private readonly getDgPath: () => string | null,
    private readonly getCwd: () => string | null,
    private readonly output: vscode.OutputChannel
  ) {}

  scheduleRun(): void {
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => void this.run(), DEBOUNCE_MS);
  }

  getLastIssues(): DgCheckIssue[] {
    return this.lastIssues;
  }

  async run(): Promise<DgCheckIssue[]> {
    const dgPath = this.getDgPath();
    const cwd = this.getCwd();
    if (!dgPath || !cwd || this.running) return this.lastIssues;
    this.running = true;
    try {
      this.output.appendLine(`[dg check] running "dg check defs" in ${cwd}...`);
      const raw = await runDgCheckDefs(dgPath, cwd);
      const issues = parseDgCheckOutput(raw);
      this.lastIssues = issues;

      const byUri = new Map<string, vscode.Diagnostic[]>();
      for (const issue of issues) {
        if (!issue.filePath) {
          this.output.appendLine(`[dg check] (no file location) ${issue.message}`);
          continue;
        }
        const uri = vscode.Uri.file(issue.filePath);
        const line = Math.max(0, (issue.line ?? 1) - 1);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, 1000),
          issue.message,
          vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'dg check';
        const list = byUri.get(uri.toString()) ?? [];
        list.push(diagnostic);
        byUri.set(uri.toString(), list);
      }

      this.collection.clear();
      for (const [uriStr, diagnostics] of byUri) {
        this.collection.set(vscode.Uri.parse(uriStr), diagnostics);
      }
      this.output.appendLine(
        issues.length === 0
          ? '[dg check] all definitions loaded successfully.'
          : `[dg check] ${issues.length} issue(s) found.`
      );
      return issues;
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.collection.dispose();
  }
}

export function registerDgCheckDiagnostics(
  context: vscode.ExtensionContext,
  getDgPath: () => string | null,
  getCwd: () => string | null,
  output: vscode.OutputChannel
): DgCheckDiagnostics {
  const diagnostics = new DgCheckDiagnostics(getDgPath, getCwd, output);
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'python' || doc.languageId === 'yaml') {
        diagnostics.scheduleRun();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.runDgCheck', () => diagnostics.run())
  );

  return diagnostics;
}

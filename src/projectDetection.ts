import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DETECTION_TIMEOUT_MS = 4000;
const PYTHON_EXT_ACTIVATE_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

export type DetectionMethod = 'dg-cli' | 'heuristic' | 'none';

export interface DagsterProject {
  folder: vscode.WorkspaceFolder;
  /** Resolved `dg` executable, or null if none could be found/run. */
  dgPath: string | null;
  dgVersion: string | null;
  detectionMethod: DetectionMethod;
  /** Absolute paths to directories containing a `dbt_project.yml`. */
  dbtProjectPaths: string[];
}

async function tryRun(cmd: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      timeout: DETECTION_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

interface DgCandidate {
  path: string;
  /** A candidate is "scoped" when its very path can only resolve to THIS
   * folder (the configured override, or `<folder>/.venv/bin/dg`) -- for
   * those, `--version` succeeding is already proof enough. The bare `dg`
   * on PATH is ambient/global and could spuriously match any folder, so
   * it additionally needs `list defs` to prove it's scoped here. */
  scoped: boolean;
}

/** Candidate `dg` invocations to try, in priority order: explicit setting
 * override, the FOLDER'S OWN `.venv/bin/dg` (the normal convention for a
 * real dg project -- `dagster-dg-cli` as a project-local dev dependency,
 * confirmed live: a project's own `.venv/bin/dg` resolves its code fine,
 * while the bare/global `dg` -- installed via `uv tool install` into its
 * own isolated environment -- cannot see the project's code at all and
 * fails with a plain `ModuleNotFoundError` for the project's own package),
 * THEN bare `dg` on PATH, then the active Python interpreter's own
 * environment. Best-effort -- failures just fall through. */
async function resolveDgCandidates(folder: vscode.WorkspaceFolder): Promise<DgCandidate[]> {
  const configured = vscode.workspace.getConfiguration('dagsterPowerUser').get<string>('dgPath');
  const candidates: DgCandidate[] = [];
  if (configured && configured.trim()) candidates.push({ path: configured.trim(), scoped: true });
  candidates.push({ path: path.join(folder.uri.fsPath, '.venv', 'bin', 'dg'), scoped: true });
  candidates.push({ path: 'dg', scoped: false });

  try {
    const pythonExt = vscode.extensions.getExtension('ms-python.python');
    if (pythonExt) {
      // Another extension's own activate() is out of our control and can
      // be slow (first-run environment discovery, etc.) -- bounded so it
      // can never make OUR detection hang indefinitely.
      const api = pythonExt.isActive
        ? pythonExt.exports
        : await withTimeout(Promise.resolve(pythonExt.activate()), PYTHON_EXT_ACTIVATE_TIMEOUT_MS);
      const activeEnvPath: string | undefined =
        api?.environments?.getActiveEnvironmentPath?.()?.path;
      if (activeEnvPath) {
        const dir = path.dirname(activeEnvPath);
        candidates.push({ path: path.join(dir, 'dg'), scoped: true });
      }
    }
  } catch {
    // Python extension not installed/active, or its API shape changed --
    // not fatal, bare `dg` / the configured override are still tried.
  }
  return candidates;
}

/** Real introspection, not guessing: `dg --version` succeeding only proves
 * dg is installed somewhere, not that this folder is a Dagster project --
 * so a SCOPED candidate (one whose path can only resolve to this folder)
 * needs nothing more, but the ambient bare-`dg`-on-PATH candidate also
 * needs `dg list defs` to succeed here as real per-folder proof.
 *
 * Deliberately NOT requiring `list defs` to succeed for scoped candidates:
 * a project with a genuine code error (the exact thing `dg check` exists
 * to catch) would otherwise get demoted out of 'dg-cli' detection the
 * moment its code breaks, disabling the one feature meant to help fix it. */
async function detectViaDgCli(folder: vscode.WorkspaceFolder): Promise<{ dgPath: string; dgVersion: string } | null> {
  const candidates = await resolveDgCandidates(folder);
  for (const candidate of candidates) {
    const version = await tryRun(candidate.path, ['--version'], folder.uri.fsPath);
    if (version === null) continue;
    if (!candidate.scoped) {
      const listDefs = await tryRun(candidate.path, ['list', 'defs'], folder.uri.fsPath);
      if (listDefs === null) continue;
    }
    // `dg --version` prints "dg, version X.Y.Z" -- keep just the number so
    // callers composing their own "dg <version>" strings don't double up.
    const versionNumber = version.trim().match(/[\d.]+$/)?.[0] ?? version.trim();
    return { dgPath: candidate.path, dgVersion: versionNumber };
  }
  return null;
}

/** Demoted fallback for when `dg` isn't resolvable at all -- the same
 * signals dg-vs-code used as its ONLY detection method, kept here only as
 * a secondary path so the extension still activates usefully without dg
 * installed (e.g. to offer "Add Dagster to this project" in the future). */
async function detectViaHeuristic(folder: vscode.WorkspaceFolder): Promise<boolean> {
  const pattern = new vscode.RelativePattern(folder, '{dagster.yaml,pyproject.toml,definitions.py,*/definitions.py}');
  const matches = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 5);
  if (matches.some((m) => /dagster\.yaml$|definitions\.py$/.test(m.fsPath))) return true;
  const pyproject = matches.find((m) => m.fsPath.endsWith('pyproject.toml'));
  if (pyproject) {
    try {
      const bytes = await vscode.workspace.fs.readFile(pyproject);
      const text = Buffer.from(bytes).toString('utf8');
      if (/\[tool\.dg\]/.test(text) || /\bdagster\b/.test(text)) return true;
    } catch {
      // unreadable -- ignore, falls through to false
    }
  }
  return false;
}

async function findDbtProjects(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const pattern = new vscode.RelativePattern(folder, '**/dbt_project.yml');
  const matches = await vscode.workspace.findFiles(pattern, '**/{node_modules,.venv,venv,target,dbt_packages}/**', 20);
  return matches.map((m) => path.dirname(m.fsPath));
}

export async function detectProject(folder: vscode.WorkspaceFolder): Promise<DagsterProject> {
  const dbtProjectPaths = await findDbtProjects(folder);

  // Hard ceiling well above the sum of per-candidate timeouts in the
  // normal case, purely as a backstop -- a single folder's detection must
  // never be able to hang the whole (now-backgrounded) scan indefinitely.
  const dgResult = await withTimeout(detectViaDgCli(folder), DETECTION_TIMEOUT_MS * 8);
  if (dgResult) {
    return {
      folder,
      dgPath: dgResult.dgPath,
      dgVersion: dgResult.dgVersion,
      detectionMethod: 'dg-cli',
      dbtProjectPaths,
    };
  }

  const heuristicMatch = await detectViaHeuristic(folder);
  return {
    folder,
    dgPath: null,
    dgVersion: null,
    detectionMethod: heuristicMatch ? 'heuristic' : 'none',
    dbtProjectPaths,
  };
}

/** Runs detection across every workspace folder in parallel, keyed by
 * folder so multi-root workspaces (several Dagster/dbt projects open at
 * once) each get independent results. */
export async function detectAllProjects(
  folders: readonly vscode.WorkspaceFolder[]
): Promise<Map<string, DagsterProject>> {
  const results = await Promise.all(folders.map((folder) => detectProject(folder)));
  const byFolderUri = new Map<string, DagsterProject>();
  for (const result of results) {
    byFolderUri.set(result.folder.uri.toString(), result);
  }
  return byFolderUri;
}

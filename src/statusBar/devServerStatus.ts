import * as vscode from 'vscode';
import { checkServerHealth } from '../data/graphqlClient';
import type { DagsterProject } from '../projectDetection';
import { runInTerminal } from '../util/terminalRun';

const POLL_INTERVAL_MS = 5000;

/**
 * Tracks reachability of ONE "primary" project's `dg dev`/`dagster dev`
 * webserver and offers to launch it. Deliberately a single status bar
 * item for now, not one per workspace folder -- true multi-root parity
 * (independent dev-server status per open Dagster project) is a known
 * simplification to revisit once there's more than one real project to
 * juggle; most sessions only actively work one project at a time anyway.
 */
export class DevServerStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly runningChangedEmitter = new vscode.EventEmitter<boolean>();
  /** Fires only on a running/not-running transition, not every poll. */
  readonly onDidChangeRunning = this.runningChangedEmitter.event;
  private pollHandle: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private dgPath: string | null = null;
  private cwd: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.item.command = 'dagsterPowerUser.devServerMenu';
    context.subscriptions.push(this.item);
    this.render();
  }

  private get graphqlUrl(): string {
    const configured = vscode.workspace.getConfiguration('dagsterPowerUser').get<string>('devServerUrl');
    return (configured && configured.trim()) || 'http://localhost:3000/graphql';
  }

  getGraphqlUrl(): string {
    return this.graphqlUrl;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Called whenever project detection (re)runs -- picks the first
   * dg-CLI-resolved project as "primary" for the purposes of this one
   * status item and the "Start dg dev" command. */
  setProjects(projects: Iterable<DagsterProject>): void {
    const primary = [...projects].find((p) => p.detectionMethod === 'dg-cli');
    this.dgPath = primary?.dgPath ?? null;
    this.cwd = primary?.folder.uri.fsPath ?? null;
    this.restartPolling();
  }

  private restartPolling(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    void this.poll();
    this.pollHandle = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    const wasRunning = this.running;
    this.running = await checkServerHealth(this.graphqlUrl);
    this.render();
    if (this.running !== wasRunning) {
      this.runningChangedEmitter.fire(this.running);
    }
  }

  private render(): void {
    if (!this.cwd) {
      this.item.text = '$(circle-slash) Dagster dev: no project';
      this.item.tooltip = 'No dg-detected Dagster project in this workspace yet.';
    } else if (this.running) {
      this.item.text = '$(pass-filled) Dagster dev: running';
      this.item.tooltip = `Reachable at ${this.graphqlUrl}`;
    } else {
      this.item.text = '$(debug-start) Dagster dev: not running';
      this.item.tooltip = 'Click to start `dg dev` in a terminal.';
    }
    this.item.show();
  }

  /** Launched in a visible, normal integrated Terminal -- never a hidden
   * child process -- so the user sees its output and can Ctrl+C it like
   * any dev server they started themselves. Never auto-launched; only
   * ever in response to an explicit click/command. */
  async startDgDev(): Promise<void> {
    if (!this.dgPath || !this.cwd) {
      vscode.window.showWarningMessage('Dagster: no dg-detected project to start. Open a folder with a Dagster project first.');
      return;
    }
    runInTerminal('dg dev', this.cwd, `${JSON.stringify(this.dgPath)} dev`);
    // Give the server a moment to come up, then poll sooner than the
    // normal interval so the status bar doesn't lag an obviously-running
    // process by a full POLL_INTERVAL_MS.
    setTimeout(() => void this.poll(), 3000);
  }

  dispose(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.item.dispose();
    this.runningChangedEmitter.dispose();
  }
}

export function registerDevServerCommands(context: vscode.ExtensionContext, status: DevServerStatus): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.devServerMenu', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: status.isRunning() ? '$(pass-filled) Dev server is running' : '$(debug-start) Start dg dev', action: 'start' as const },
          { label: '$(graph) Show Asset Lineage', action: 'lineage' as const },
        ],
        { title: 'Dagster Dev Server' }
      );
      if (picked?.action === 'start' && !status.isRunning()) {
        await status.startDgDev();
      } else if (picked?.action === 'lineage') {
        await vscode.commands.executeCommand('dagsterPowerUser.showAssetLineage');
      }
    })
  );
}

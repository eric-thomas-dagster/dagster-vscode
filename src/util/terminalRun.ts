import * as vscode from 'vscode';

const SHELL_INTEGRATION_TIMEOUT_MS = 3000;

/**
 * Creates a terminal and runs a command in it -- NOT via `createTerminal()`
 * + immediate `sendText()`, which races the shell's own startup (confirmed
 * live: every one of this extension's terminal-launching commands showed
 * the exact same symptom -- the sent command got cut off by a `^C` with
 * zero of its own output, immediately followed by what looks like VS
 * Code's Python extension auto-activating the venv in that same
 * terminal -- not the user pressing Ctrl+C themselves, confirmed by
 * asking). `shellIntegration.executeCommand()` is the real API for this:
 * it waits for the shell to actually be ready before injecting the
 * command, and (bonus) reports a real exit code instead of needing an
 * `&& echo` marker hack to tell success from failure.
 *
 * Falls back to plain `sendText()` if shell integration never activates
 * within a few seconds (some shells/remote setups don't support it) --
 * degrades to the old behavior rather than silently doing nothing.
 */
export function runInTerminal(
  name: string,
  cwd: string,
  command: string,
  onExit?: (exitCode: number | undefined) => void
): void {
  const terminal = vscode.window.createTerminal({ name, cwd });
  terminal.show();

  const execute = (shellIntegration: vscode.TerminalShellIntegration) => {
    shellIntegration.executeCommand(command);
    if (!onExit) return;
    const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.terminal === terminal) {
        sub.dispose();
        onExit(e.exitCode);
      }
    });
  };

  if (terminal.shellIntegration) {
    execute(terminal.shellIntegration);
    return;
  }

  const timeoutHandle = setTimeout(() => {
    changeSub.dispose();
    terminal.sendText(command);
  }, SHELL_INTEGRATION_TIMEOUT_MS);

  const changeSub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
    if (e.terminal === terminal) {
      clearTimeout(timeoutHandle);
      changeSub.dispose();
      execute(e.shellIntegration);
    }
  });
}

import * as vscode from 'vscode';
import type { SessionManager } from '../chat/sessionManager';

const ARCHIVE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('archive'), tooltip: 'Archive' };
const UNARCHIVE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('inbox'), tooltip: 'Unarchive' };
const DELETE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete' };

interface SessionQuickPickItem extends vscode.QuickPickItem {
  sessionId: string;
  archived: boolean;
}

/** Claude Code's own sessions list, scoped down to a QuickPick instead of
 * a dedicated tree view -- per-item archive/delete via QuickPick's
 * button API, switching via plain selection. A full tree view (grouping,
 * inline rename, etc.) is a reasonable follow-up if this isn't enough. */
export function registerChatHistoryCommands(context: vscode.ExtensionContext, sessions: SessionManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.newChatSession', async () => {
      await sessions.newSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dagsterPowerUser.showChatHistory', async () => {
      const buildItems = (): SessionQuickPickItem[] => {
        const active = sessions.getActiveSession();
        return [...sessions.listSessions()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((s) => ({
            label: `${s.id === active.id ? '$(check) ' : ''}${s.title}${s.archived ? ' (archived)' : ''}`,
            description: `${s.messages.length} message${s.messages.length === 1 ? '' : 's'}`,
            detail: new Date(s.updatedAt).toLocaleString(),
            sessionId: s.id,
            archived: s.archived,
            buttons: [s.archived ? UNARCHIVE_BUTTON : ARCHIVE_BUTTON, DELETE_BUTTON],
          }));
      };

      const qp = vscode.window.createQuickPick<SessionQuickPickItem>();
      qp.title = 'Dagster Expert -- Chat History';
      qp.placeholder = 'Select a session to switch to it';
      qp.items = buildItems();

      qp.onDidTriggerItemButton(async (e) => {
        if (e.button === DELETE_BUTTON) {
          const confirm = await vscode.window.showWarningMessage(
            `Delete "${e.item.label.replace('$(check) ', '')}"?`,
            { modal: true },
            'Delete'
          );
          if (confirm === 'Delete') await sessions.remove(e.item.sessionId);
        } else {
          await sessions.archive(e.item.sessionId, !e.item.archived);
        }
        qp.items = buildItems();
      });

      qp.onDidAccept(() => {
        const picked = qp.selectedItems[0];
        if (picked) void sessions.switchTo(picked.sessionId);
        qp.hide();
      });

      qp.onDidHide(() => qp.dispose());
      qp.show();
    })
  );
}

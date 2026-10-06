import * as vscode from 'vscode';
import type { ChatMessage } from '../ai/llmClient';

const STORAGE_KEY = 'dagsterPowerUser.chatSessions';
const ACTIVE_ID_KEY = 'dagsterPowerUser.activeChatSessionId';
const MAX_TITLE_LENGTH = 48;

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

/** The `sessionList` postMessage payload shared by both chat hosts (the
 * sidebar view and the editor-tab panel) -- summarized (no full message
 * bodies; the rail only ever needs title/count/recency) so switching
 * sessions doesn't ship every session's entire transcript on every sync. */
export function sessionListMessage(sessions: ChatSession[], activeId: string) {
  return {
    type: 'sessionList' as const,
    activeId,
    sessions: [...sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
        archived: s.archived,
      })),
  };
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveTitle(firstMessage: string): string {
  const oneLine = firstMessage.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TITLE_LENGTH ? oneLine.slice(0, MAX_TITLE_LENGTH - 1) + '…' : oneLine || 'New session';
}

/** Chat history persisted across reloads via globalState -- one pool of
 * sessions per VS Code profile (not scoped per-workspace; simplest useful
 * v1, matching "pull up old chats" regardless of which project happens
 * to be open right now). Named/archived/deleted like Claude Code's own
 * sessions list, surfaced here via a QuickPick rather than a dedicated
 * tree view to keep this a reasonable first cut. */
export class SessionManager implements vscode.Disposable {
  private sessions: ChatSession[];
  private activeId: string;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.sessions = context.globalState.get<ChatSession[]>(STORAGE_KEY, []);
    const storedActiveId = context.globalState.get<string>(ACTIVE_ID_KEY);
    const activeExists = storedActiveId && this.sessions.some((s) => s.id === storedActiveId);
    if (activeExists) {
      this.activeId = storedActiveId!;
    } else if (this.sessions.length > 0) {
      this.activeId = this.sessions[0].id;
    } else {
      this.activeId = this.createSessionInternal().id;
    }
  }

  private async persist(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, this.sessions);
    await this.context.globalState.update(ACTIVE_ID_KEY, this.activeId);
    this.emitter.fire();
  }

  private createSessionInternal(): ChatSession {
    const session: ChatSession = {
      id: makeId(),
      title: 'New session',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
    };
    this.sessions.unshift(session);
    return session;
  }

  getActiveSession(): ChatSession {
    return this.sessions.find((s) => s.id === this.activeId)!;
  }

  listSessions(): ChatSession[] {
    return this.sessions;
  }

  async newSession(): Promise<ChatSession> {
    const session = this.createSessionInternal();
    this.activeId = session.id;
    await this.persist();
    return session;
  }

  async switchTo(id: string): Promise<void> {
    if (!this.sessions.some((s) => s.id === id)) return;
    this.activeId = id;
    await this.persist();
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    const session = this.getActiveSession();
    session.messages.push(message);
    session.updatedAt = Date.now();
    if (session.title === 'New session' && message.role === 'user') {
      session.title = deriveTitle(message.content);
    }
    await this.persist();
  }

  async archive(id: string, archived: boolean): Promise<void> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    session.archived = archived;
    await this.persist();
  }

  async rename(id: string, title: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    session.title = title;
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeId === id) {
      this.activeId = this.sessions[0]?.id ?? this.createSessionInternal().id;
    }
    await this.persist();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

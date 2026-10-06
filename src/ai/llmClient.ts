import * as vscode from 'vscode';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

const ANTHROPIC_KEY_SECRET = 'dagsterPowerUser.anthropicApiKey';
const OPENAI_KEY_SECRET = 'dagsterPowerUser.openaiApiKey';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_RETRIES = 3;

export class MissingApiKeyError extends Error {
  constructor(public readonly provider: 'anthropic' | 'openai') {
    super(`No ${provider} API key set.`);
  }
}

function getProvider(): 'anthropic' | 'openai' {
  const configured = vscode.workspace.getConfiguration('dagsterPowerUser').get<string>('aiProvider');
  return configured === 'openai' ? 'openai' : 'anthropic';
}

function getModel(): string {
  const configured = vscode.workspace.getConfiguration('dagsterPowerUser').get<string>('aiModel');
  return (configured && configured.trim()) || DEFAULT_MODEL;
}

export async function hasApiKey(context: vscode.ExtensionContext): Promise<boolean> {
  const provider = getProvider();
  const key = await context.secrets.get(provider === 'openai' ? OPENAI_KEY_SECRET : ANTHROPIC_KEY_SECRET);
  return !!key;
}

export async function setApiKey(context: vscode.ExtensionContext, provider: 'anthropic' | 'openai'): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: `Set ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API Key`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: provider === 'anthropic' ? 'sk-ant-...' : 'sk-...',
  });
  if (!key) return;
  await context.secrets.store(provider === 'anthropic' ? ANTHROPIC_KEY_SECRET : OPENAI_KEY_SECRET, key.trim());
  vscode.window.showInformationMessage(`Dagster: ${provider} API key saved.`);
}

async function withRetry<T>(fn: () => Promise<T>, isRetryable: (e: any) => boolean): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isRetryable(e) || attempt === MAX_RETRIES - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function callAnthropic(apiKey: string, model: string, system: string, messages: ChatMessage[]): Promise<string> {
  return withRetry(
    async () => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          // 1024 was too tight even for a normal chat answer, and
          // actively broke whole-file edits (Add Check/Add Schedule
          // ask the model to echo back the ENTIRE file with a new
          // function spliced in -- anything past ~1024 tokens of
          // output got cut off mid-JSON, which read as "Dagster Expert
          // did not return a usable fix" with no indication it was
          // really a truncation problem).
          max_tokens: 8192,
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        const err: any = new Error(`Anthropic API error (${res.status}): ${body.slice(0, 500)}`);
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      return data.content.find((c) => c.type === 'text')?.text ?? '';
    },
    (e) => e?.status === 429 || e?.status >= 500
  );
}

async function callOpenAi(apiKey: string, model: string, system: string, messages: ChatMessage[]): Promise<string> {
  return withRetry(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        const err: any = new Error(`OpenAI API error (${res.status}): ${body.slice(0, 500)}`);
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message?.content ?? '';
    },
    (e) => e?.status === 429 || e?.status >= 500
  );
}

export async function sendChatMessage(
  context: vscode.ExtensionContext,
  system: string,
  messages: ChatMessage[]
): Promise<string> {
  const provider = getProvider();
  const model = getModel();
  const secretKey = provider === 'openai' ? OPENAI_KEY_SECRET : ANTHROPIC_KEY_SECRET;
  const apiKey = await context.secrets.get(secretKey);
  if (!apiKey) throw new MissingApiKeyError(provider);

  return provider === 'openai'
    ? callOpenAi(apiKey, model, system, messages)
    : callAnthropic(apiKey, model, system, messages);
}

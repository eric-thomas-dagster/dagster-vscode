import * as vscode from 'vscode';
import { sendChatMessage, type ChatMessage } from './llmClient';
import type { AssetIndexStore, AssetRefInfo } from '../data/assetIndex';
import type { PrimitiveIndexStore, PrimitiveRefInfo } from '../data/primitiveIndex';
import { searchDagsterDocs } from '../data/docsSearch';

/**
 * The "dagster-expert" persona's shared core -- grounds every answer in
 * the CURRENT project's real asset graph AND jobs/schedules/sensors/ops
 * (the same AssetIndexStore/PrimitiveIndexStore hover/diagnostics/
 * go-to-def already use) rather than answering from Dagster knowledge
 * alone. No MCP tool access yet (that's the next layer); this is the
 * assistant's baseline, usable the moment an API key is set.
 */
/** This Algolia index is confirmed live to be surprisingly sensitive to
 * query wording -- "freshness policy" alone surfaces the exact right
 * guide, but the full natural-language question it came from (or even
 * that phrase plus one extra word like "project") drowns it out with
 * generic API-reference pages. A real user question is never going to
 * arrive pre-phrased as 2-3 search keywords, so extract some cheaply
 * (a short, low-token LLM call, not brittle stopword-stripping -- tried
 * that against the real index first and it wasn't reliable either). */
async function extractDocsSearchQuery(context: vscode.ExtensionContext, question: string): Promise<string> {
  try {
    const query = await sendChatMessage(
      context,
      'Extract a short Dagster documentation search query (2-5 keywords, no punctuation, no explanation) from the user\'s question. Reply with ONLY the search terms.',
      [{ role: 'user', content: question }]
    );
    const cleaned = query.trim().replace(/^["']|["']$/g, '');
    return cleaned || question;
  } catch {
    return question;
  }
}

/** Best-effort grounding from Dagster's real public docs (Algolia
 * DocSearch, same free/public index the docs site's own search box
 * uses -- confirmed live, see data/docsSearch.ts). A docs-search failure
 * (offline, Algolia down) must never block an otherwise-answerable
 * question, so this swallows errors and just omits the section. */
async function buildDocsContext(context: vscode.ExtensionContext, question: string): Promise<string> {
  try {
    const searchQuery = await extractDocsSearchQuery(context, question);
    const hits = await searchDagsterDocs(searchQuery, 4);
    if (!hits.length) return '';
    return [
      '',
      'Relevant Dagster documentation (from docs.dagster.io -- cite these URLs when they directly answer the question):',
      ...hits.map((h) => `- ${h.title}${h.breadcrumb ? ` (${h.breadcrumb})` : ''}: ${h.url}\n  ${h.snippet}`),
    ].join('\n');
  } catch {
    return '';
  }
}

function buildSystemPrompt(store: AssetIndexStore, primitives: PrimitiveIndexStore): string {
  const seen = new Set<AssetRefInfo>();
  const assets: AssetRefInfo[] = [];
  for (const info of store.getIndex().values()) {
    if (seen.has(info)) continue;
    seen.add(info);
    assets.push(info);
  }

  const assetSummary = assets.length
    ? assets
        .map((a) => `- ${a.key}${a.group ? ` (group: ${a.group})` : ''}${a.kinds.length ? ` [${a.kinds.join(', ')}]` : ''}`)
        .join('\n')
    : '(No assets loaded yet -- the dev server may not be running, or the asset index hasn\'t refreshed.)';

  const prims = [...primitives.getIndex().values()];
  const byKind = (kind: PrimitiveRefInfo['kind']) => prims.filter((p) => p.kind === kind);
  const primitiveSection = (kind: PrimitiveRefInfo['kind'], label: string) => {
    const items = byKind(kind);
    if (!items.length) return `${label}: none`;
    return `${label}: ${items.map((p) => p.name + (p.cronSchedule ? ` (${p.cronSchedule})` : '')).join(', ')}`;
  };

  return [
    'You are "Dagster Expert", an assistant embedded in a VS Code extension for Dagster development.',
    'Answer concisely and concretely. Prefer referencing real names from the project below over generic Dagster advice.',
    'If a question needs information you don\'t have (e.g. live run history, logs), say so plainly rather than guessing.',
    '',
    'Assets currently known in this project:',
    assetSummary,
    '',
    primitiveSection('job', 'Jobs'),
    primitiveSection('schedule', 'Schedules'),
    primitiveSection('sensor', 'Sensors'),
    primitiveSection('op', 'Ops'),
  ].join('\n');
}

export async function askDagsterExpert(
  context: vscode.ExtensionContext,
  store: AssetIndexStore,
  primitives: PrimitiveIndexStore,
  question: string,
  history: ChatMessage[]
): Promise<string> {
  const [projectContext, docsContext] = await Promise.all([
    Promise.resolve(buildSystemPrompt(store, primitives)),
    buildDocsContext(context, question),
  ]);
  const system = projectContext + docsContext;
  const messages: ChatMessage[] = [...history, { role: 'user', content: question }];
  return sendChatMessage(context, system, messages);
}

import * as vscode from 'vscode';
import type { AssetIndexStore } from '../data/assetIndex';
import type { PrimitiveIndexStore } from '../data/primitiveIndex';

const ASSET_WORD_PATTERN = /[A-Za-z0-9_][A-Za-z0-9_\-./]*/;

const PRIMITIVE_LABEL: Record<string, string> = {
  job: 'Job',
  schedule: 'Schedule',
  sensor: 'Sensor',
  op: 'Op',
};

/** Covers assets AND jobs/schedules/sensors/ops -- same word-at-cursor →
 * index lookup → markdown pattern either way, just two source indexes. */
export function registerAssetHoverProvider(
  context: vscode.ExtensionContext,
  store: AssetIndexStore,
  primitives: PrimitiveIndexStore
): void {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(['python', 'yaml'], {
      provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position, ASSET_WORD_PATTERN);
        if (!range) return null;
        const word = document.getText(range);

        const info = store.getIndex().get(word);
        if (info) {
          const lines = [`**Asset:** \`${info.key}\``];
          const facts: string[] = [];
          if (info.group) facts.push(`group: ${info.group}`);
          if (info.kinds.length) facts.push(`kinds: ${info.kinds.join(', ')}`);
          if (info.staleStatus) facts.push(`staleness: ${info.staleStatus}`);
          if (facts.length) lines.push(facts.join(' · '));
          if (info.description) lines.push('', info.description);
          return new vscode.Hover(new vscode.MarkdownString(lines.join('\n\n')), range);
        }

        const prim = primitives.getIndex().get(word);
        if (prim) {
          const lines = [`**${PRIMITIVE_LABEL[prim.kind] ?? prim.kind}:** \`${prim.name}\``];
          if (prim.cronSchedule) lines.push(`cron: \`${prim.cronSchedule}\``);
          if (prim.description) lines.push('', prim.description);
          return new vscode.Hover(new vscode.MarkdownString(lines.join('\n\n')), range);
        }

        return null;
      },
    })
  );
}

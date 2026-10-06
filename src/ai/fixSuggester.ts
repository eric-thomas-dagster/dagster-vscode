import * as vscode from 'vscode';
import { sendChatMessage } from './llmClient';

/**
 * Backs the "Ask Dagster Expert to fix this" Quick Fix (see
 * diagnostics/fixCodeActionProvider.ts + commands/fixDiagnostic.ts). Only
 * a bounded snippet around the diagnostic -- not the whole file -- is
 * sent and expected back: smaller, cheaper, and the model can't
 * accidentally reformat unrelated parts of a large file.
 */

const CONTEXT_LINES = 12;

export interface FixSuggestion {
  explanation: string;
  fixedSnippet: string;
}

export interface SnippetRange {
  /** 0-indexed, inclusive */
  startLine: number;
  /** 0-indexed, inclusive */
  endLine: number;
}

export function computeSnippetRange(document: vscode.TextDocument, anchorLine: number): SnippetRange {
  const startLine = Math.max(0, anchorLine - CONTEXT_LINES);
  const endLine = Math.min(document.lineCount - 1, anchorLine + CONTEXT_LINES);
  return { startLine, endLine };
}

export function snippetToRange(document: vscode.TextDocument, snippet: SnippetRange): vscode.Range {
  return new vscode.Range(snippet.startLine, 0, snippet.endLine, document.lineAt(snippet.endLine).text.length);
}

/** The model is asked for strict JSON but models routinely wrap it in a
 * markdown fence anyway (confirmed with both Anthropic and OpenAI during
 * manual testing of this exact prompt) -- strip a fence if present, then
 * take the outermost {...} rather than trusting the whole reply is JSON. */
function extractJson(raw: string): FixSuggestion | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (typeof parsed.explanation === 'string' && typeof parsed.fixedSnippet === 'string') {
      return parsed;
    }
  } catch {
    // fall through to undefined below
  }
  return undefined;
}

export async function suggestFix(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  diagnosticMessage: string,
  snippet: SnippetRange
): Promise<FixSuggestion> {
  const snippetText = document.getText(snippetToRange(document, snippet));

  const system = [
    'You are fixing a real, reported error in a Dagster project file.',
    'You will be given a SNIPPET of the file (not the whole file), the error that was reported, and the line number where the snippet starts.',
    'Reply with ONLY a single JSON object and nothing else -- no markdown fences, no commentary outside the JSON:',
    '{"explanation": "one or two sentences on what was wrong and what you changed", "fixedSnippet": "the full corrected replacement for this exact snippet"}',
    '"fixedSnippet" REPLACES THE ENTIRE SNIPPET verbatim: keep every unrelated line exactly as given (same indentation, same content), do not add placeholders or ellipses, and do not add lines outside what was asked for.',
  ].join('\n');

  const prompt = [
    `File: ${vscode.workspace.asRelativePath(document.uri)}`,
    `Error: ${diagnosticMessage}`,
    `Snippet starts at line ${snippet.startLine + 1}:`,
    '```',
    snippetText,
    '```',
  ].join('\n');

  const raw = await sendChatMessage(context, system, [{ role: 'user', content: prompt }]);
  const parsed = extractJson(raw);
  if (!parsed) {
    // A generic "did not return a usable fix" with no context was a dead
    // end to debug -- most real cases of this are the response getting
    // cut off mid-JSON (large file + a low max_tokens cap), which looks
    // identical to the model just refusing. Showing what it actually said
    // makes that diagnosable instead of a guess.
    const preview = raw.trim().slice(0, 300);
    throw new Error(
      `Dagster Expert did not return a usable fix.${preview ? ` Its response started with: ${preview}${raw.length > 300 ? '...' : ''}` : ' (empty response)'}`
    );
  }
  return parsed;
}

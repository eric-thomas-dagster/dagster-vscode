/**
 * Regex-based asset-reference extraction -- ported logic (not code) from
 * Dagster Designer's CodeEditor.tsx (`extractYamlAssetRefs`/
 * `extractPythonAssetRefs`), which that file's own comments confirm are
 * pure string/regex transforms with zero editor dependency. Re-verified
 * here against this extension's own data shape, not blindly copied.
 *
 * Scoped to STRUCTURED, unambiguous references only (`deps:`/`asset_key:`
 * in YAML component defs, `deps=[...]`/`non_argument_deps=[...]` in
 * Python) -- deliberately not flagging bare `@asset` function parameter
 * names as "unknown" even though that's Dagster's other, implicit way of
 * declaring a dependency: a parameter can legitimately be `context`,
 * `config`, or a resource, and guessing wrong would be a false-positive
 * squiggle on ordinary code. Hover still resolves those via plain
 * word-at-cursor lookup, independent of this extraction.
 */

export interface AssetRefMatch {
  name: string;
  start: number;
  end: number;
}

export function extractYamlAssetRefs(text: string): AssetRefMatch[] {
  const refs: AssetRefMatch[] = [];

  const blockRe = /\bdeps:[ \t]*\n((?:[ \t]*-[ \t]*[^\n#]+\n?)+)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    const block = m[1];
    const blockStart = m.index + m[0].indexOf(block);
    const itemRe = /-[ \t]*["']?([A-Za-z0-9_][A-Za-z0-9_\-./]*)["']?/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(block))) {
      const name = im[1];
      const localStart = im.index + im[0].lastIndexOf(name);
      refs.push({ name, start: blockStart + localStart, end: blockStart + localStart + name.length });
    }
  }

  const inlineRe = /\bdeps:[ \t]*\[([^\]]*)\]/g;
  while ((m = inlineRe.exec(text))) {
    const list = m[1];
    const listStart = m.index + m[0].indexOf(list);
    const itemRe = /["']?([A-Za-z0-9_][A-Za-z0-9_\-./]*)["']?/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(list))) {
      const name = im[1];
      const localStart = im.index + im[0].lastIndexOf(name);
      refs.push({ name, start: listStart + localStart, end: listStart + localStart + name.length });
    }
  }

  // Deliberately not bare "key:" -- far too generic a YAML field name
  // across component attributes to treat every value as an asset ref.
  const scalarRe = /\basset_key:[ \t]*["']?([A-Za-z0-9_][A-Za-z0-9_\-./]*)["']?/g;
  while ((m = scalarRe.exec(text))) {
    const name = m[1];
    const localStart = m.index + m[0].lastIndexOf(name);
    refs.push({ name, start: localStart, end: localStart + name.length });
  }

  return refs;
}

export function extractPythonAssetRefs(text: string): AssetRefMatch[] {
  const refs: AssetRefMatch[] = [];
  const depsRe = /\b(?:deps|non_argument_deps)\s*=\s*[\[{]([^\]}]*)[\]}]/g;
  let m: RegExpExecArray | null;
  while ((m = depsRe.exec(text))) {
    const list = m[1];
    const listStart = m.index + m[0].indexOf(list);
    const itemRe = /AssetKey\(\s*\[?["']([A-Za-z0-9_][A-Za-z0-9_\-./]*)["']\]?\s*\)|["']([A-Za-z0-9_][A-Za-z0-9_\-./]*)["']/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(list))) {
      const name = im[1] || im[2];
      if (!name) continue;
      const localStart = im.index + im[0].lastIndexOf(name);
      refs.push({ name, start: listStart + localStart, end: listStart + localStart + name.length });
    }
  }
  return refs;
}

export function extractAssetRefs(languageId: string, text: string): AssetRefMatch[] {
  if (languageId === 'yaml') return extractYamlAssetRefs(text);
  if (languageId === 'python') return extractPythonAssetRefs(text);
  return [];
}

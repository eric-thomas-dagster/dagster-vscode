import * as vscode from 'vscode';
import type { AssetIndexStore } from '../data/assetIndex';
import type { PrimitiveIndexStore } from '../data/primitiveIndex';

const ASSET_WORD_PATTERN = /[A-Za-z0-9_][A-Za-z0-9_\-./]*/;

/**
 * Dagster's GraphQL schema has no source-file/line field anywhere on
 * AssetNode, op, or Repository for a plain Python asset (checked directly
 * against a live `dagster dev` instance before writing this -- not
 * assumed). So, unlike hover/diagnostics, there's no clean API path here:
 * this falls back to a bounded workspace text scan for the asset's
 * `def <name>(` or an explicit `name="<key>"` override. Same class of
 * approach dg-vs-code used for its own go-to-definition, just with a real
 * cache (cleared whenever the asset index refreshes) instead of
 * re-scanning on every jump.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class AssetDefinitionResolver implements vscode.Disposable {
  private readonly cache = new Map<string, vscode.Location | null>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(store: AssetIndexStore, primitives: PrimitiveIndexStore) {
    this.subscriptions = [
      store.onDidChange(() => this.cache.clear()),
      primitives.onDidChange(() => this.cache.clear()),
    ];
  }

  async resolve(assetKey: string): Promise<vscode.Location | null> {
    if (this.cache.has(assetKey)) return this.cache.get(assetKey) ?? null;

    const identifier = (assetKey.split('/').pop() ?? assetKey).replace(/-/g, '_');
    const defRe = new RegExp(`\\bdef\\s+${escapeRegExp(identifier)}\\s*\\(`);
    const nameOverrideRe = new RegExp(`name\\s*=\\s*["']${escapeRegExp(assetKey)}["']`);

    const pyFiles = await vscode.workspace.findFiles(
      '**/*.py',
      '**/{node_modules,.venv,venv,__pycache__,.git,dbt_packages,target}/**',
      500
    );

    let found: vscode.Location | null = null;
    for (const file of pyFiles) {
      let text: string;
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
      } catch {
        continue;
      }
      const match = defRe.exec(text) ?? nameOverrideRe.exec(text);
      if (match) {
        const doc = await vscode.workspace.openTextDocument(file);
        found = new vscode.Location(file, doc.positionAt(match.index));
        break;
      }
    }

    // Community/custom-Component-generated assets have no `def <name>(`
    // anywhere -- their name is a configured attribute (e.g. `asset_name:
    // customer_addresses_parsed`) read by the component's own build_defs,
    // confirmed live after a real install produced exactly this gap. The
    // defs.yaml instance IS the real "definition" for these, so that's
    // the fallback target rather than failing outright.
    if (!found) {
      const assetNameRe = new RegExp(`asset_name:\\s*["']?${escapeRegExp(identifier)}["']?`);
      const yamlFiles = await vscode.workspace.findFiles(
        '**/defs.yaml',
        '**/{node_modules,.venv,venv,__pycache__,.git,dbt_packages,target}/**',
        500
      );
      for (const file of yamlFiles) {
        let text: string;
        try {
          text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
        } catch {
          continue;
        }
        const match = assetNameRe.exec(text);
        if (match) {
          const doc = await vscode.workspace.openTextDocument(file);
          found = new vscode.Location(file, doc.positionAt(match.index));
          break;
        }
      }
    }

    this.cache.set(assetKey, found);
    return found;
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }
}

export function registerAssetDefinitionProvider(
  context: vscode.ExtensionContext,
  store: AssetIndexStore,
  primitives: PrimitiveIndexStore
): AssetDefinitionResolver {
  const resolver = new AssetDefinitionResolver(store, primitives);
  context.subscriptions.push(resolver);

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(['python', 'yaml'], {
      async provideDefinition(document, position) {
        const range = document.getWordRangeAtPosition(position, ASSET_WORD_PATTERN);
        if (!range) return null;
        const word = document.getText(range);
        const info = store.getIndex().get(word);
        if (info) return resolver.resolve(info.key);
        const prim = primitives.getIndex().get(word);
        if (prim) return resolver.resolve(prim.name);
        return null;
      },
    })
  );

  return resolver;
}

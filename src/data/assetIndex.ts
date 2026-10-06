import * as vscode from 'vscode';
import { fetchAssetGraph, type AssetCheckSummary } from './graphqlClient';

export interface AssetRefInfo {
  key: string;
  description: string | null;
  group: string | null;
  kinds: string[];
  staleStatus: string | null;
  checks: AssetCheckSummary[];
}

/**
 * Live-ish index of every asset in the currently reachable dev server,
 * keyed by every plausible spelling (full key, `/`-joined path's last
 * segment, and the underscore/identifier form Python code uses) --
 * mirrors Dagster Designer's CodeEditor.tsx `assetIndex` construction.
 * Backs both the hover provider (any matching token, anywhere) and the
 * "unknown asset" diagnostics (structured refs only).
 */
export class AssetIndexStore implements vscode.Disposable {
  private index = new Map<string, AssetRefInfo>();
  private lastError: string | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  getIndex(): ReadonlyMap<string, AssetRefInfo> {
    return this.index;
  }

  /** See PrimitiveIndexStore.getLastError() -- same idea, same reason. */
  getLastError(): string | undefined {
    return this.lastError;
  }

  async refresh(graphqlUrl: string, headers?: Record<string, string>): Promise<void> {
    try {
      const summary = await fetchAssetGraph(graphqlUrl, headers);
      const next = new Map<string, AssetRefInfo>();
      for (const n of summary.nodes) {
        const info: AssetRefInfo = {
          key: n.assetKey,
          description: n.description,
          group: n.groupName,
          kinds: n.kinds,
          staleStatus: n.staleStatus,
          checks: n.checks,
        };
        const variants = new Set<string>([n.assetKey, n.assetKey.replace(/\//g, '_')]);
        const lastSeg = n.assetKey.split('/').pop();
        if (lastSeg) {
          variants.add(lastSeg);
          variants.add(lastSeg.replace(/-/g, '_'));
        }
        for (const v of variants) next.set(v, info);
      }
      this.index = next;
      this.lastError = undefined;
      this.emitter.fire();
    } catch (e) {
      // Keep the last-known-good index on a transient failure (e.g. dev
      // server briefly restarting) rather than flashing every hover/
      // diagnostic to empty -- but remember what went wrong and fire the
      // change event anyway, so the tree view can surface it instead of
      // silently showing "0 assets" forever.
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

import * as vscode from 'vscode';
import { fetchPrimitives, type InstigationStatus, type PrimitiveKind } from './graphqlClient';

export interface PrimitiveRefInfo {
  kind: PrimitiveKind;
  name: string;
  description: string | null;
  cronSchedule?: string | null;
  /** Schedule/sensor only -- needed to start/stop from the tree. */
  id?: string;
  status?: InstigationStatus;
  repositoryName?: string;
  repositoryLocationName?: string;
  /** Resource/ioManager only. */
  resourceType?: string;
}

/** Same role as AssetIndexStore, for jobs/schedules/sensors/ops -- kept
 * as a separate store rather than merged into AssetIndexStore since the
 * info shape genuinely differs (no group/kinds/staleness concept here),
 * but hover/go-to-definition consult both. */
export class PrimitiveIndexStore implements vscode.Disposable {
  private index = new Map<string, PrimitiveRefInfo>();
  private lastError: string | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  getIndex(): ReadonlyMap<string, PrimitiveRefInfo> {
    return this.index;
  }

  /** Set when the last refresh failed -- e.g. a real ImportError loading
   * the project's definitions, not a cosmetic "0 results". Kept even
   * though the index itself still holds the last-known-good data, so
   * callers (the tree view) can tell "genuinely empty" apart from
   * "broken, showing stale data". Cleared on the next successful refresh. */
  getLastError(): string | undefined {
    return this.lastError;
  }

  async refresh(graphqlUrl: string, knownAssetKeys: ReadonlySet<string>, headers?: Record<string, string>): Promise<void> {
    try {
      const primitives = await fetchPrimitives(graphqlUrl, knownAssetKeys, headers);
      const next = new Map<string, PrimitiveRefInfo>();
      for (const p of primitives) {
        next.set(p.name, {
          kind: p.kind,
          name: p.name,
          description: p.description,
          cronSchedule: p.cronSchedule,
          id: p.id,
          status: p.status,
          repositoryName: p.repositoryName,
          repositoryLocationName: p.repositoryLocationName,
          resourceType: p.resourceType,
        });
      }
      this.index = next;
      this.lastError = undefined;
      this.emitter.fire();
    } catch (e) {
      // Keep the last-known-good index on failure (still don't want to
      // flash every hover/diagnostic to empty on a transient blip) --
      // but DO remember what went wrong and fire the change event
      // anyway, so something can tell the user rather than silently
      // showing "0" forever.
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

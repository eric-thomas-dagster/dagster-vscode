import type { AssetGraphSummary, AssetNodeSummary } from './graphqlClient';

export interface GraphNodeOut {
  id: string;
  type: 'asset';
  position: { x: number; y: number };
  data: {
    asset_key: string;
    group_name: string | null;
    description: string | null;
    kinds: string[];
    stale_status: string | null;
    checks: Array<{ name: string; description: string | null }>;
  };
}

export interface GraphEdgeOut {
  id: string;
  source: string;
  target: string;
}

const X_SPACING = 280;
const Y_SPACING = 110;

/** Simple longest-path layering: each node's column is 1 + the deepest of
 * its upstream dependencies' columns (0 for roots), same core idea as
 * Dagster Designer's GraphEditor layering -- written fresh here rather
 * than porting that file's full ~300-line version (which also handles
 * group-collapse and incremental re-layout on expand/collapse, not
 * needed yet since there's no grouping UI in this extension's graph
 * view). Good enough for a real, correctly-ordered DAG layout; revisit
 * if/when group-collapse is ported too. */
function computeColumns(nodes: AssetNodeSummary[]): Map<string, number> {
  const byKey = new Map(nodes.map((n) => [n.assetKey, n]));
  const columns = new Map<string, number>();
  const visiting = new Set<string>();

  function columnOf(key: string): number {
    const cached = columns.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return 0; // cycle guard -- shouldn't happen in a real DAG
    visiting.add(key);
    const node = byKey.get(key);
    const deps = node?.dependencyAssetKeys ?? [];
    const col = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => columnOf(d)));
    visiting.delete(key);
    columns.set(key, col);
    return col;
  }

  for (const n of nodes) columnOf(n.assetKey);
  return columns;
}

export function toGraphElements(summary: AssetGraphSummary): { nodes: GraphNodeOut[]; edges: GraphEdgeOut[] } {
  const columns = computeColumns(summary.nodes);
  const countPerColumn = new Map<number, number>();

  const nodes: GraphNodeOut[] = summary.nodes.map((n) => {
    const col = columns.get(n.assetKey) ?? 0;
    const row = countPerColumn.get(col) ?? 0;
    countPerColumn.set(col, row + 1);
    return {
      id: n.assetKey,
      type: 'asset',
      position: { x: col * X_SPACING, y: row * Y_SPACING },
      data: {
        asset_key: n.assetKey,
        group_name: n.groupName,
        description: n.description,
        kinds: n.kinds,
        stale_status: n.staleStatus,
        checks: n.checks,
      },
    };
  });

  const edges: GraphEdgeOut[] = summary.nodes.flatMap((n) =>
    n.dependencyAssetKeys.map((dep) => ({
      id: `${dep}->${n.assetKey}`,
      source: dep,
      target: n.assetKey,
    }))
  );

  return { nodes, edges };
}

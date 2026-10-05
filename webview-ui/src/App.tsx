import { useEffect, useState } from 'react';
import ReactFlow, { Background, Controls, type Edge, type Node } from 'reactflow';
import 'reactflow/dist/style.css';
import { AssetNode, ASSET_LENS_OPTIONS, AssetLensLegend, type AssetLens } from './components/nodes/AssetNode';
import { vscodeApi } from './vscodeApi';

interface ValidationIssue {
  message: string;
  filePath: string | null;
  line: number | null;
}

// Hand-authored demo graph -- stands in for live GraphQL data until the
// extension host's data layer exists. Shape matches exactly what AssetNode
// expects (asset_key, group_name, checks, last_run_status, stale_status,
// freshness_status, kinds), so swapping this for real data later is a
// pure data-source change, not a rendering change.
const nodeTypes = { asset: AssetNode };

const DEMO_NODES: Node[] = [
  {
    id: 'raw_customers',
    type: 'asset',
    position: { x: 0, y: 80 },
    data: {
      asset_key: 'raw_customers',
      group_name: 'staging',
      kinds: ['python'],
      last_run_status: 'success',
      stale_status: 'FRESH',
      freshness_status: null,
      checks: [],
    },
  },
  {
    id: 'stg_customers',
    type: 'asset',
    position: { x: 280, y: 0 },
    data: {
      asset_key: 'stg_customers',
      group_name: 'staging',
      kinds: ['dbt', 'duckdb'],
      last_run_status: 'success',
      stale_status: 'FRESH',
      freshness_status: 'HEALTHY',
      checks: [{ name: 'not_null_customer_id', last_status: 'success' }],
      description: 'Deduplicated, typed customer records.',
    },
  },
  {
    id: 'customer_ltv',
    type: 'asset',
    position: { x: 560, y: 80 },
    data: {
      asset_key: 'customer_ltv',
      group_name: 'marts',
      kinds: ['dbt', 'duckdb'],
      last_run_status: 'failure',
      stale_status: 'STALE',
      freshness_status: 'DEGRADED',
      checks: [
        { name: 'not_null_ltv', last_status: 'success' },
        { name: 'ltv_non_negative', last_status: 'failure' },
      ],
      owners: ['data-eng@example.com'],
      description: 'Lifetime value per customer, used by the marketing dashboard.',
    },
  },
];

const DEMO_EDGES: Edge[] = [
  { id: 'e1', source: 'raw_customers', target: 'stg_customers' },
  { id: 'e2', source: 'stg_customers', target: 'customer_ltv' },
];

/** Real data arrives (or doesn't) via `postMessage` from the extension
 * host -- the webview sandbox can't reach a GraphQL endpoint directly
 * under VS Code's default CSP, so all network/CLI access happens
 * host-side (see src/webviews/lineagePanel.ts) and is relayed in. Starts
 * on the hardcoded demo graph so the panel never looks broken/empty
 * while that message is in flight (or never arrives, e.g. no dev server
 * running yet). */
function useGraphData(): {
  nodes: Node[];
  edges: Edge[];
  isLive: boolean;
  validationIssues: ValidationIssue[] | null;
} {
  const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[]; isLive: boolean }>({
    nodes: DEMO_NODES,
    edges: DEMO_EDGES,
    isLive: false,
  });
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[] | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === 'graph' && Array.isArray(message.nodes) && Array.isArray(message.edges)) {
        setGraph({ nodes: message.nodes, edges: message.edges, isLive: true });
        setValidationIssues(null);
      } else if (message?.type === 'validationError' && Array.isArray(message.issues)) {
        setValidationIssues(message.issues);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return { ...graph, validationIssues };
}

/** When the project doesn't currently validate, the GraphQL fetch that
 * would normally populate this graph fails outright -- rather than just
 * silently falling back to demo data with a toast, show the REAL `dg
 * check` error(s) with a one-click jump to the offending file/line, same
 * data the Problems-panel diagnostics already surface, just actionable
 * from inside the graph view itself instead of requiring a context
 * switch to go find it. */
function ValidationErrorBanner({ issues }: { issues: ValidationIssue[] }) {
  return (
    <div className="flex-shrink-0 border-b border-rose-200 bg-rose-50 px-4 py-3 space-y-2">
      <div className="text-sm font-semibold text-rose-800">
        This project doesn't currently validate -- showing the last known graph below.
      </div>
      {issues.map((issue, i) => (
        <div key={i} className="flex items-start gap-2 text-xs text-rose-700">
          <span className="flex-1 whitespace-pre-wrap font-mono">{issue.message}</span>
          {issue.filePath && (
            <button
              onClick={() =>
                vscodeApi.postMessage({ type: 'openIssueLocation', filePath: issue.filePath, line: issue.line })
              }
              className="flex-shrink-0 px-2 py-0.5 rounded bg-rose-600 text-white hover:bg-rose-700"
            >
              Open {issue.filePath.split('/').pop()}
              {issue.line ? `:${issue.line}` : ''}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [lens, setLens] = useState<AssetLens>('last_run');
  const { nodes: baseNodes, edges, isLive, validationIssues } = useGraphData();

  const nodes = baseNodes.map((n) => ({ ...n, data: { ...n.data, lens } }));

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      <div className="flex-shrink-0 flex items-center gap-3 px-3 py-2 border-b border-gray-200">
        <span className="text-sm font-semibold">
          Dagster Power User — Asset Lineage {isLive ? '' : '(demo data — no dev server reached)'}
        </span>
        <select
          value={lens}
          onChange={(e) => setLens(e.target.value as AssetLens)}
          className="text-xs px-2 py-1 border border-gray-300 rounded bg-white"
        >
          {ASSET_LENS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>Color: {o.label}</option>
          ))}
        </select>
        <AssetLensLegend lens={lens} />
      </div>
      {validationIssues && validationIssues.length > 0 && <ValidationErrorBanner issues={validationIssues} />}
      <div className="flex-1">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

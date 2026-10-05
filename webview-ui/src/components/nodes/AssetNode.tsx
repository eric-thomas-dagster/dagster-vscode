import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Layers, Database, Users, CheckCircle, X, Wand2, Search, Package, AlertTriangle, Zap, Clock, Play, Radar, Loader2 } from 'lucide-react';
import { classifyStatus } from '@/lib/status';

// Icon mapping for component icons
const componentIconMap: Record<string, any> = {
  'Wand2': Wand2,
  'Database': Database,
  'Search': Search,
  'Package': Package,
};

/** Asset Graph's lens feature -- colors come from real, non-fabricated
 *  signals: `stale_status` (Dagster's built-in FRESH/STALE/MISSING
 *  concept, no FreshnessPolicy needed), `freshness_status` (HEALTHY/
 *  WARNING/DEGRADED, only populated when a FreshnessPolicy is actually
 *  attached -- null otherwise, which the dot correctly renders as
 *  "nothing to show" rather than a fake value), and `last_run_status`
 *  (success/failure of the most recent run that targeted this asset --
 *  distinct from staleness: an asset can be STALE but its last attempt
 *  still succeeded, or FRESH from an old run after a newer one failed
 *  and got retried). Ported from Dagster Designer's AssetNode.tsx --
 *  see that repo's GraphEditor.tsx for how these fields get merged into
 *  node data; this extension's own data layer is responsible for the
 *  equivalent merge against a live `dg dev` GraphQL endpoint. */
export type AssetLens = 'staleness' | 'freshness' | 'checks' | 'last_run';

// Threaded through each node's `data.lens`, not a React Context -- a
// context was tried first in Designer to avoid touching the graph-load
// effect, but confirmed live that switching lenses stopped recoloring
// nodes with that approach (React Flow's own internal node-rendering
// optimizations don't reliably propagate context updates to node
// components the way plain React reconciliation would). `data` changes
// are exactly what React Flow already knows how to react to.

const STALE_STATUS_COLOR: Record<string, string> = {
  FRESH: '#10b981',
  STALE: '#f59e0b',
  MISSING: '#9ca3af',
};
const FRESHNESS_STATUS_COLOR: Record<string, string> = {
  HEALTHY: '#10b981',
  WARNING: '#f59e0b',
  DEGRADED: '#f43f5e',
  UNKNOWN: '#9ca3af',
};

function assetLensDot(lens: AssetLens, data: any): { color: string; title: string } | null {
  if (lens === 'last_run') {
    const status = data.last_run_status as string | undefined;
    if (!status) return null;
    const c = classifyStatus(status);
    const color = c === 'success' ? '#10b981' : c === 'failure' ? '#f43f5e' : c === 'warning' ? '#f59e0b' : '#94a3b8';
    return { color, title: `Last run: ${status}` };
  }
  if (lens === 'freshness') {
    const fs = data.freshness_status as string | undefined;
    if (!fs || !FRESHNESS_STATUS_COLOR[fs]) return null;
    return { color: FRESHNESS_STATUS_COLOR[fs], title: `Freshness: ${fs}` };
  }
  if (lens === 'checks') {
    const checks = (data.checks || []) as Array<{ last_status?: string | null }>;
    if (checks.length === 0) return null;
    const buckets = checks.map((c) => classifyStatus(c.last_status));
    const worst = (['failure', 'warning', 'skipped', 'success'] as const).find((p) => buckets.includes(p));
    if (!worst) return null;
    const color = worst === 'success' ? '#10b981' : worst === 'failure' ? '#f43f5e' : worst === 'warning' ? '#f59e0b' : '#94a3b8';
    return { color, title: `Worst check status: ${worst}` };
  }
  // 'staleness' (default)
  const ss = data.stale_status as string | undefined;
  if (!ss || !STALE_STATUS_COLOR[ss]) return null;
  return { color: STALE_STATUS_COLOR[ss], title: `Staleness: ${ss}` };
}

export const ASSET_LENS_OPTIONS: { value: AssetLens; label: string }[] = [
  { value: 'last_run', label: 'Last run status' },
  { value: 'staleness', label: 'Staleness' },
  { value: 'freshness', label: 'Freshness' },
  { value: 'checks', label: 'Checks' },
];

export function AssetLensLegend({ lens }: { lens: AssetLens }) {
  const entries: { color: string; label: string }[] =
    lens === 'staleness'
      ? Object.entries(STALE_STATUS_COLOR).map(([label, color]) => ({ color, label }))
      : lens === 'freshness'
      ? Object.entries(FRESHNESS_STATUS_COLOR).map(([label, color]) => ({ color, label }))
      : [
          { color: '#10b981', label: lens === 'checks' ? 'all passing' : 'success' },
          { color: '#f43f5e', label: lens === 'checks' ? 'any failing' : 'failure' },
          { color: '#f59e0b', label: lens === 'checks' ? 'any warning' : 'warning' },
          { color: '#94a3b8', label: lens === 'checks' ? 'any skipped' : 'skipped' },
        ];
  return (
    <div className="flex items-center gap-2.5 text-[10px] text-gray-500">
      {entries.map((e) => (
        <span key={e.label} className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: e.color }} />
          {e.label}
        </span>
      ))}
    </div>
  );
}

export const AssetNode = memo(({ data, selected, id }: NodeProps) => {
  // Dagster uses a purple/blue color scheme for assets
  const hasGroup = data.group_name;
  const hasOwners = data.owners && data.owners.length > 0;
  const hasDescription = data.description && data.description.length > 0;
  const hasChecks = data.checks && data.checks.length > 0;
  const isSelected = selected;

  // Detect incomplete config -- the AI (or a user) may have left TODO_*
  // placeholders for fields it couldn't infer (file_path, connection_string,
  // etc.). Flag these so the graph shows them clearly rather than silently
  // failing at Dagster load.
  const incompleteFields: string[] = [];
  const attrs = data.component_attributes;
  if (attrs && typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === 'string' && v.startsWith('TODO_')) {
        incompleteFields.push(k);
      }
    }
  }
  const isIncomplete = incompleteFields.length > 0;

  // Detect if we're in pipeline-builder mode (vertical layout with delete button)
  const isPipelineBuilder = !!data.onDelete;

  // Lens dot -- only in the (non-pipeline-builder) graph view; set by the
  // caller via a shared `lens` value passed into every node's data.
  const lens: AssetLens = (data.lens as AssetLens) || 'last_run';
  const lensDot = isPipelineBuilder ? null : assetLensDot(lens, data);

  // Check if this asset has IO types
  const outputType = data.io_output_type;
  const inputType = data.io_input_type;
  const inputRequired = data.io_input_required;

  // Truncate description to 60 characters for display
  const truncatedDescription = hasDescription
    ? data.description.length > 60
      ? data.description.substring(0, 60) + '...'
      : data.description
    : '';

  // Handle styles -- make them visible and connectable always
  const handleStyle = {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    border: '1.5px solid #6366f1',
    background: '#ffffff',
    cursor: 'crosshair',
    opacity: data.onDelete ? 0 : 1, // Hidden visually in pipeline builder but still connectable
  };

  return (
    <div
      className={`relative shadow-sm rounded-md bg-white min-w-[160px] max-w-[220px] transition-shadow hover:shadow-md ${
        isSelected
          ? 'border-2 border-primary ring-2 ring-primary/20'
          : isIncomplete
          ? 'border-2 border-amber-500 ring-1 ring-amber-200'
          : 'border border-gray-200'
      }`}
      title={
        isIncomplete
          ? `Needs config: ${incompleteFields.join(', ')}`
          : hasDescription
          ? data.description
          : ''
      }
    >
      {/* Delete button */}
      {data.onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            data.onDelete(id);
          }}
          className="absolute -top-1.5 -right-1.5 z-10 w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center shadow-md transition-colors"
          title="Remove asset from pipeline"
        >
          <X className="w-3 h-3 text-white" />
        </button>
      )}

      {/* Input handles - top/bottom for pipeline builder, left for lineage */}
      {isPipelineBuilder ? (
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          style={handleStyle}
        />
      ) : (
        <Handle
          type="target"
          position={Position.Left}
          id="left"
          style={handleStyle}
        />
      )}

      {/* Header with asset icon and key */}
      <div
        className={`group/header px-2 py-1.5 rounded-t-md ${isIncomplete ? 'bg-amber-500' : lensDot ? '' : 'bg-primary'}`}
        style={!isIncomplete && lensDot ? { backgroundColor: lensDot.color } : undefined}
        title={!isIncomplete && lensDot ? lensDot.title : undefined}
      >
        <div className="flex items-center space-x-1.5">
          <div className="flex-shrink-0">
            <Layers className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-white truncate">
              {data.asset_key || data.label}
            </div>
          </div>
          {isIncomplete && (
            <div
              className="flex-shrink-0"
              title={`Needs config: ${incompleteFields.join(', ')}`}
            >
              <AlertTriangle className="w-3.5 h-3.5 text-white" />
            </div>
          )}
          {/* Run to here -- materializes this asset + all upstream, then opens
              the data preview. Only shown in the graph view (not pipeline
              builder), and only when the parent wires up the callback. */}
          {!isPipelineBuilder && data.onRunToHere && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                data.onRunToHere(data.asset_key || data.label);
              }}
              disabled={data.isRunningToHere}
              className="flex-shrink-0 opacity-0 group-hover/header:opacity-100 focus:opacity-100 data-[running=true]:opacity-100 w-5 h-5 rounded flex items-center justify-center bg-white/20 hover:bg-white/30 disabled:cursor-wait transition-opacity"
              data-running={data.isRunningToHere ? 'true' : 'false'}
              title="Run to here — materialize this asset + upstream, then preview the output"
            >
              {data.isRunningToHere ? (
                <Loader2 className="w-3 h-3 text-white animate-spin" />
              ) : (
                <Play className="w-3 h-3 text-white fill-white" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Body with metadata facets */}
      <div className="px-2 py-1.5 space-y-1">
        {/* Label if different from asset key */}
        {data.label && data.label !== data.asset_key && (
          <div className="text-[10px] text-gray-700 font-medium truncate leading-tight">
            {data.label}
          </div>
        )}

        {/* Description - truncated with tooltip on hover */}
        {hasDescription && (
          <div
            className="text-[10px] text-gray-600 line-clamp-1 cursor-help leading-tight"
            title={data.description}
          >
            {truncatedDescription}
          </div>
        )}

        {/* Metadata badges (facets) */}
        <div className="flex flex-wrap gap-1 pt-0.5">
          {isIncomplete && (
            <div
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 border border-amber-300"
              title={`Missing required config: ${incompleteFields.join(', ')}`}
            >
              <AlertTriangle className="w-2.5 h-2.5" />
              <span>Needs config</span>
            </div>
          )}
          {/* Group badge - only show if not "default", UNLESS it's also the
              "collapse this group" control (data.onCollapseGroup). */}
          {hasGroup && (data.group_name !== 'default' || data.onCollapseGroup) && (
            <button
              type="button"
              onClick={(e) => {
                if (!data.onCollapseGroup) return;
                e.stopPropagation();
                data.onCollapseGroup();
              }}
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 border border-blue-300 ${data.onCollapseGroup ? 'cursor-pointer hover:bg-blue-200' : ''}`}
              title={data.onCollapseGroup ? `Collapse ${data.group_name} back to a group card` : `Group: ${data.group_name}`}
            >
              <Database className="w-2.5 h-2.5" />
              <span className="truncate max-w-[80px]">{data.group_name}</span>
              {data.onCollapseGroup && <span className="ml-0.5 text-blue-500">×</span>}
            </button>
          )}

          {/* Owners badge */}
          {hasOwners && (
            <div
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 border border-purple-300"
              title={`Owners: ${data.owners.join(', ')}`}
            >
              <Users className="w-2.5 h-2.5" />
              <span>{data.owners.length}</span>
            </div>
          )}

          {/* Source component badge with icon */}
          {data.source_component && (() => {
            const componentIconName = data.component_icon;
            const ComponentIcon = componentIconName ? componentIconMap[componentIconName] || Package : Package;
            const componentName = data.source_component.replace('community_', '').replace(/_/g, ' ');

            return (
              <div
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 border border-purple-300"
                title={`Generated by: ${componentName}`}
              >
                <ComponentIcon className="w-2.5 h-2.5" />
                <span className="truncate max-w-[80px]">{componentName}</span>
              </div>
            );
          })()}

          {/* Asset checks badge — clickable */}
          {hasChecks && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const firstCheck = data.checks[0];
                const name = typeof firstCheck === 'string' ? firstCheck : firstCheck?.name;
                if (name) data.onPrimitiveClick?.('asset_check', name);
              }}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-700 border border-orange-300 cursor-pointer hover:bg-orange-200"
              title={`${data.checks.length} check${data.checks.length !== 1 ? 's' : ''}`}
            >
              <CheckCircle className="w-2.5 h-2.5" />
              <span>{data.checks.length}</span>
            </button>
          )}

          {/* Jobs badge — clickable */}
          {data.jobs && data.jobs.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                data.onPrimitiveClick?.('job', data.jobs![0]);
              }}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-700 border border-indigo-300 hover:bg-indigo-200 cursor-pointer"
              title={data.jobs.length === 1 ? `Job: ${data.jobs[0]}` : `Jobs: ${data.jobs.join(', ')}`}
            >
              <Play className="w-2.5 h-2.5" />
              <span>{data.jobs.length}</span>
            </button>
          )}

          {/* Schedules badge — clickable */}
          {data.schedules && data.schedules.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                data.onPrimitiveClick?.('schedule', data.schedules![0]);
              }}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-100 text-sky-700 border border-sky-300 hover:bg-sky-200 cursor-pointer"
              title={data.schedules.length === 1 ? `Schedule: ${data.schedules[0]}` : `Schedules: ${data.schedules.join(', ')}`}
            >
              <Clock className="w-2.5 h-2.5" />
              <span>{data.schedules.length}</span>
            </button>
          )}

          {/* Sensors badge — clickable */}
          {data.sensors && data.sensors.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                data.onPrimitiveClick?.('sensor', data.sensors![0]);
              }}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-300 hover:bg-fuchsia-200 cursor-pointer"
              title={data.sensors.length === 1 ? `Sensor: ${data.sensors[0]}` : `Sensors: ${data.sensors.join(', ')}`}
            >
              <Radar className="w-2.5 h-2.5" />
              <span>{data.sensors.length}</span>
            </button>
          )}

          {/* Kinds — small tech tags (dbt, duckdb, python, etc.) */}
          {(data.kinds || []).slice(0, 3).map((kind: string) => (
            <div
              key={kind}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-700 border border-slate-300"
              title={`Kind: ${kind}`}
            >
              {kind}
            </div>
          ))}
          {(data.kinds || []).length > 3 && (
            <div
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-300"
              title={data.kinds.slice(3).join(', ')}
            >
              +{data.kinds.length - 3}
            </div>
          )}

          {/* Automation condition badge */}
          {data.automation_condition && (
            <div
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 border border-emerald-300"
              title={typeof data.automation_condition === 'string' ? data.automation_condition : JSON.stringify(data.automation_condition)}
            >
              <Zap className="w-2.5 h-2.5" />
              <span>auto</span>
            </div>
          )}

          {/* Input type badge */}
          {inputType && (
            <div
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                inputRequired
                  ? 'bg-amber-100 text-amber-700 border border-amber-300'
                  : 'bg-gray-100 text-gray-700 border border-gray-300'
              }`}
              title={inputRequired ? `Requires ${inputType} input` : `Accepts ${inputType} input (optional)`}
            >
              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.707-10.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L9.414 11H13a1 1 0 100-2H9.414l1.293-1.293z" clipRule="evenodd" />
              </svg>
              <span>{inputType}</span>
              {inputRequired && <span className="ml-0.5">*</span>}
            </div>
          )}

          {/* Output type badge */}
          {outputType && (
            <div
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-100 text-cyan-700 border border-cyan-300"
              title={`Produces ${outputType} output`}
            >
              <span>{outputType}</span>
              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clipRule="evenodd" />
              </svg>
            </div>
          )}
        </div>
      </div>

      {/* Output handles - bottom for pipeline builder, right for lineage */}
      {isPipelineBuilder ? (
        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          style={handleStyle}
        />
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          id="right"
          style={handleStyle}
        />
      )}
    </div>
  );
});

AssetNode.displayName = 'AssetNode';

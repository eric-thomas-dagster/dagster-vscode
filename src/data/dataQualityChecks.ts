import type { FormField, FormSpec } from '../webviews/componentFormPanel';

/**
 * Real, confirmed field shapes for the 19 documented check types of the
 * `EnhancedDataQualityChecks` catalog component (dagster_component_templates
 * .EnhancedDataQualityChecks), captured directly from its README.md's own
 * numbered, worked YAML examples -- not guessed, and not from schema.json
 * (whose `attributes.<check_type>` entries are opaque `{type: array, items:
 * {type: string}}` with no nested field breakdown, confirmed by inspecting
 * the fetched JSON directly). `dataframe_query_check` is the one entry
 * schema.json lists that has no worked example anywhere in the README, so
 * it's deliberately left out here -- the free-text AI-description path is
 * still available as a fallback for it.
 *
 * This exists so "Add Check" can show a real FORM (deterministically
 * correct field names/types) instead of asking the model to invent a
 * check's structure from a one-line description, which is what made the
 * component "hard to set up in YAML" and "take a while" in the first
 * place.
 */

/** How a submitted form value gets turned into YAML lines for one field.
 * Most fields are a plain scalar; a handful of real checks nest a small
 * list of objects (data_type_check's columns, range_check's columns,
 * uniqueness_check's single composite-key group) that a flat form field
 * can't represent directly -- those are entered as one line per entry in a
 * textarea and parsed here into the real nested shape. */
export type DQYamlKind =
  | 'string'
  | 'number'
  | 'bool'
  | 'string-list' // textarea/text, one item per line or comma -> ["a", "b"]
  | 'col-type-pairs' // textarea "column: type" per line -> [{column, expected_type}]
  | 'col-range-triples' // textarea "column: min, max" per line -> [{column, min_value, max_value}]
  | 'uniqueness-group'; // textarea, one composite key (comma/newline separated columns) -> [{columns: [...]}]

export interface DQField extends FormField {
  yamlKey: string;
  yamlKind: DQYamlKind;
}

export interface DQCheckTypeSpec {
  id: string;
  label: string;
  description: string;
  fields: DQField[];
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const COMMON_FIELDS: DQField[] = [
  { name: 'name', yamlKey: 'name', label: 'Check Name', type: 'text', required: true, yamlKind: 'string' },
];

const COMMON_TRAILING_FIELDS: DQField[] = [
  { name: 'blocking', yamlKey: 'blocking', label: 'Blocking', type: 'checkbox', default: true, yamlKind: 'bool' },
  {
    name: 'group_by',
    yamlKey: 'group_by',
    label: 'Group By (optional)',
    type: 'text',
    description: 'Check each group separately, e.g. a column name',
    yamlKind: 'string',
  },
  {
    name: 'allowed_failures',
    yamlKey: 'allowed_failures',
    label: 'Allowed Failures (optional)',
    type: 'number',
    description: 'How many groups/items are allowed to fail before the check fails',
    yamlKind: 'number',
  },
  {
    name: 'severity',
    yamlKey: 'severity',
    label: 'Severity (optional)',
    type: 'select',
    options: ['', 'WARN', 'ERROR'],
    yamlKind: 'string',
  },
];

export const DQ_CHECK_TYPES: DQCheckTypeSpec[] = [
  {
    id: 'row_count_check',
    label: 'Row Count Check',
    description: 'Validates the number of rows falls within expected bounds.',
    fields: [
      { name: 'min_rows', yamlKey: 'min_rows', label: 'Min Rows', type: 'number', yamlKind: 'number' },
      { name: 'max_rows', yamlKey: 'max_rows', label: 'Max Rows', type: 'number', yamlKind: 'number' },
    ],
  },
  {
    id: 'null_check',
    label: 'Null Check',
    description: 'Checks for null values in specified columns.',
    fields: [
      {
        name: 'columns',
        yamlKey: 'columns',
        label: 'Columns',
        type: 'textarea',
        required: true,
        placeholder: 'one per line, e.g. user_id',
        yamlKind: 'string-list',
      },
    ],
  },
  {
    id: 'data_type_check',
    label: 'Data Type Check',
    description: 'Validates columns have the expected data types.',
    fields: [
      {
        name: 'columns',
        yamlKey: 'columns',
        label: 'Columns',
        type: 'textarea',
        required: true,
        placeholder: 'one per line: column: expected_type\ne.g. user_id: int',
        description: 'One per line: "column: expected_type"',
        yamlKind: 'col-type-pairs',
      },
    ],
  },
  {
    id: 'range_check',
    label: 'Range Check',
    description: 'Validates numeric values fall within specified ranges.',
    fields: [
      {
        name: 'columns',
        yamlKey: 'columns',
        label: 'Columns',
        type: 'textarea',
        required: true,
        placeholder: 'one per line: column: min, max\ne.g. price: 0.01, 10000',
        description: 'One per line: "column: min, max"',
        yamlKind: 'col-range-triples',
      },
    ],
  },
  {
    id: 'pattern_matching',
    label: 'Pattern Matching',
    description: 'Validates a text column against a regex pattern.',
    fields: [
      { name: 'column', yamlKey: 'column', label: 'Column', type: 'text', required: true, yamlKind: 'string' },
      {
        name: 'regex_pattern',
        yamlKey: 'regex_pattern',
        label: 'Regex Pattern',
        type: 'text',
        required: true,
        placeholder: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
        yamlKind: 'string',
      },
      {
        name: 'match_percentage',
        yamlKey: 'match_percentage',
        label: 'Match Percentage',
        type: 'number',
        default: 99.0,
        yamlKind: 'number',
      },
    ],
  },
  {
    id: 'value_set_validation',
    label: 'Value Set Validation',
    description: 'Ensures column values are within an allowed set.',
    fields: [
      { name: 'column', yamlKey: 'column', label: 'Column', type: 'text', required: true, yamlKind: 'string' },
      {
        name: 'allowed_values',
        yamlKey: 'allowed_values',
        label: 'Allowed Values',
        type: 'textarea',
        required: true,
        placeholder: 'one per line, e.g. active',
        yamlKind: 'string-list',
      },
      { name: 'min_pct', yamlKey: 'min_pct', label: 'Min Percentage', type: 'number', default: 99.0, yamlKind: 'number' },
    ],
  },
  {
    id: 'uniqueness_check',
    label: 'Uniqueness Check',
    description: 'Validates uniqueness of a column or composite key.',
    fields: [
      {
        name: 'columns',
        yamlKey: 'columns',
        label: 'Columns (composite key)',
        type: 'textarea',
        required: true,
        placeholder: 'e.g. user_id, order_id',
        description: 'Comma-separated. Use one column for a simple uniqueness check.',
        yamlKind: 'uniqueness-group',
      },
    ],
  },
  {
    id: 'static_threshold',
    label: 'Static Threshold',
    description: 'Validates a metric against static thresholds.',
    fields: [
      {
        name: 'metric',
        yamlKey: 'metric',
        label: 'Metric',
        type: 'text',
        required: true,
        placeholder: 'num_rows, mean:column_name, sum:column_name, min:column_name, max:column_name',
        yamlKind: 'string',
      },
      { name: 'min_value', yamlKey: 'min_value', label: 'Min Value', type: 'number', yamlKind: 'number' },
      { name: 'max_value', yamlKey: 'max_value', label: 'Max Value', type: 'number', yamlKind: 'number' },
    ],
  },
  {
    id: 'anomaly_detection',
    label: 'Anomaly Detection',
    description: 'Detects anomalies in a metric using statistical methods.',
    fields: [
      { name: 'metric', yamlKey: 'metric', label: 'Metric', type: 'text', required: true, yamlKind: 'string' },
      {
        name: 'method',
        yamlKey: 'method',
        label: 'Method',
        type: 'select',
        options: ['z_score', 'iqr', 'isolation_forest'],
        default: 'z_score',
        yamlKind: 'string',
      },
      { name: 'threshold', yamlKey: 'threshold', label: 'Threshold', type: 'number', default: 2.0, yamlKind: 'number' },
      {
        name: 'history',
        yamlKey: 'history',
        label: 'History (data points)',
        type: 'number',
        default: 10,
        yamlKind: 'number',
      },
    ],
  },
  {
    id: 'percent_delta',
    label: 'Percent Delta',
    description: 'Tracks percent changes from historical values.',
    fields: [
      { name: 'metric', yamlKey: 'metric', label: 'Metric', type: 'text', required: true, yamlKind: 'string' },
      {
        name: 'max_delta',
        yamlKey: 'max_delta',
        label: 'Max Delta (%)',
        type: 'number',
        default: 50.0,
        yamlKind: 'number',
      },
      { name: 'history', yamlKey: 'history', label: 'History (data points)', type: 'number', default: 5, yamlKind: 'number' },
    ],
  },
  {
    id: 'entropy_analysis',
    label: 'Entropy Analysis',
    description: 'Analyzes data diversity using Shannon entropy.',
    fields: [
      { name: 'column', yamlKey: 'column', label: 'Column', type: 'text', required: true, yamlKind: 'string' },
      { name: 'min_entropy', yamlKey: 'min_entropy', label: 'Min Entropy', type: 'number', yamlKind: 'number' },
      { name: 'max_entropy', yamlKey: 'max_entropy', label: 'Max Entropy', type: 'number', yamlKind: 'number' },
    ],
  },
  {
    id: 'benford_law',
    label: "Benford's Law",
    description: 'Checks a numeric column conforms to Benford distribution.',
    fields: [
      { name: 'column', yamlKey: 'column', label: 'Column', type: 'text', required: true, yamlKind: 'string' },
      { name: 'threshold', yamlKey: 'threshold', label: 'Threshold', type: 'number', yamlKind: 'number' },
      {
        name: 'digit_position',
        yamlKey: 'digit_position',
        label: 'Digit Position',
        type: 'number',
        default: 1,
        yamlKind: 'number',
      },
      { name: 'min_samples', yamlKey: 'min_samples', label: 'Min Samples', type: 'number', yamlKind: 'number' },
    ],
  },
  {
    id: 'correlation_check',
    label: 'Correlation Check',
    description: 'Validates the correlation between two columns.',
    fields: [
      { name: 'column_x', yamlKey: 'column_x', label: 'Column X', type: 'text', required: true, yamlKind: 'string' },
      { name: 'column_y', yamlKey: 'column_y', label: 'Column Y', type: 'text', required: true, yamlKind: 'string' },
      {
        name: 'method',
        yamlKey: 'method',
        label: 'Method',
        type: 'select',
        options: ['pearson', 'spearman', 'kendall'],
        default: 'pearson',
        yamlKind: 'string',
      },
      { name: 'min_correlation', yamlKey: 'min_correlation', label: 'Min Correlation', type: 'number', yamlKind: 'number' },
      { name: 'max_correlation', yamlKey: 'max_correlation', label: 'Max Correlation', type: 'number', yamlKind: 'number' },
    ],
  },
  {
    id: 'predicted_range',
    label: 'Predicted Range',
    description: "Validates a metric falls within a forecasted range.",
    fields: [
      { name: 'metric', yamlKey: 'metric', label: 'Metric', type: 'text', required: true, yamlKind: 'string' },
      {
        name: 'method',
        yamlKey: 'method',
        label: 'Method',
        type: 'select',
        options: ['moving_average', 'linear_regression', 'exponential_smoothing', 'arima'],
        default: 'moving_average',
        yamlKind: 'string',
      },
      { name: 'confidence', yamlKey: 'confidence', label: 'Confidence', type: 'number', yamlKind: 'number' },
      { name: 'history', yamlKey: 'history', label: 'History (data points)', type: 'number', yamlKind: 'number' },
    ],
  },
  {
    id: 'distribution_change',
    label: 'Distribution Change',
    description: "Detects a shift in a metric's distribution over time.",
    fields: [
      { name: 'metric', yamlKey: 'metric', label: 'Metric', type: 'text', required: true, yamlKind: 'string' },
      {
        name: 'method',
        yamlKey: 'method',
        label: 'Method',
        type: 'select',
        options: ['ks_test', 'chi_square'],
        default: 'ks_test',
        yamlKind: 'string',
      },
      {
        name: 'significance_level',
        yamlKey: 'significance_level',
        label: 'Significance Level',
        type: 'number',
        yamlKind: 'number',
      },
    ],
  },
  {
    id: 'cross_table_validation',
    label: 'Cross-Table Validation',
    description: 'Validates this asset against another table.',
    fields: [
      { name: 'source_table', yamlKey: 'source_table', label: 'Source Table', type: 'text', required: true, yamlKind: 'string' },
      { name: 'source_database', yamlKey: 'source_database', label: 'Source Database', type: 'text', yamlKind: 'string' },
      {
        name: 'join_columns',
        yamlKey: 'join_columns',
        label: 'Join Columns',
        type: 'textarea',
        placeholder: 'one per line, e.g. user_id',
        yamlKind: 'string-list',
      },
      {
        name: 'validation_type',
        yamlKey: 'validation_type',
        label: 'Validation Type',
        type: 'select',
        options: ['row_count', 'column_values', 'aggregate'],
        default: 'row_count',
        yamlKind: 'string',
      },
    ],
  },
  {
    id: 'custom_sql_check',
    label: 'Custom SQL Check',
    description: 'Runs a custom SQL query and validates the result.',
    fields: [
      { name: 'sql_query', yamlKey: 'sql_query', label: 'SQL Query', type: 'textarea', required: true, yamlKind: 'string' },
      {
        name: 'expected_result',
        yamlKey: 'expected_result',
        label: 'Expected Result',
        type: 'text',
        required: true,
        yamlKind: 'string',
      },
      {
        name: 'comparison',
        yamlKey: 'comparison',
        label: 'Comparison',
        type: 'text',
        default: 'equals',
        placeholder: 'equals',
        yamlKind: 'string',
      },
      { name: 'description', yamlKey: 'description', label: 'Description (optional)', type: 'text', yamlKind: 'string' },
    ],
  },
  {
    id: 'custom_dataframe_check',
    label: 'Custom Dataframe Check',
    description: 'Runs custom Python against the loaded dataframe.',
    fields: [
      {
        name: 'python_code',
        yamlKey: 'python_code',
        label: 'Python Code',
        type: 'textarea',
        required: true,
        yamlKind: 'string',
      },
      {
        name: 'expected_result',
        yamlKey: 'expected_result',
        label: 'Expected Result',
        type: 'text',
        required: true,
        yamlKind: 'string',
      },
      {
        name: 'comparison',
        yamlKey: 'comparison',
        label: 'Comparison',
        type: 'text',
        default: 'equals',
        placeholder: 'equals',
        yamlKind: 'string',
      },
      { name: 'description', yamlKey: 'description', label: 'Description (optional)', type: 'text', yamlKind: 'string' },
    ],
  },
  {
    id: 'duration_anomaly_check',
    label: 'Duration Anomaly Check',
    description: 'Flags runs/materializations whose duration looks anomalous. Works well applied via a group selector.',
    fields: [
      {
        name: 'method',
        yamlKey: 'method',
        label: 'Method',
        type: 'select',
        options: ['z_score', 'iqr'],
        default: 'z_score',
        yamlKind: 'string',
      },
      { name: 'threshold', yamlKey: 'threshold', label: 'Threshold', type: 'number', yamlKind: 'number' },
      { name: 'history', yamlKey: 'history', label: 'History (data points)', type: 'number', yamlKind: 'number' },
      { name: 'min_history', yamlKey: 'min_history', label: 'Min History', type: 'number', yamlKind: 'number' },
      {
        name: 'direction',
        yamlKey: 'direction',
        label: 'Direction',
        type: 'select',
        options: ['slow_only', 'fast_only', 'both'],
        default: 'both',
        yamlKind: 'string',
      },
    ],
  },
];

export function buildCheckFormSpec(checkType: DQCheckTypeSpec): FormSpec {
  return {
    title: `Add ${checkType.label}`,
    fields: [...COMMON_FIELDS, ...checkType.fields, ...COMMON_TRAILING_FIELDS],
  };
}

function yamlScalar(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));
}

function indentBlock(lines: string[], indent: string): string[] {
  return lines.map((l) => indent + l);
}

/** Renders one field's submitted value as YAML line(s) at the given key,
 * indented to sit directly under a check entry's `- name: ...` line. */
function renderFieldYaml(field: DQField, value: unknown, indent: string): string[] {
  if (value === undefined || value === null || value === '') return [];

  switch (field.yamlKind) {
    case 'string-list': {
      const items = splitList(String(value));
      if (items.length === 0) return [];
      return [`${indent}${field.yamlKey}: [${items.map((i) => JSON.stringify(i)).join(', ')}]`];
    }
    case 'col-type-pairs': {
      const pairs = String(value)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const idx = l.indexOf(':');
          return idx === -1 ? null : { column: l.slice(0, idx).trim(), expected_type: l.slice(idx + 1).trim() };
        })
        .filter((p): p is { column: string; expected_type: string } => p !== null);
      if (pairs.length === 0) return [];
      const lines = [`${indent}${field.yamlKey}:`];
      for (const p of pairs) {
        lines.push(`${indent}  - column: ${JSON.stringify(p.column)}`);
        lines.push(`${indent}    expected_type: ${JSON.stringify(p.expected_type)}`);
      }
      return lines;
    }
    case 'col-range-triples': {
      const triples = String(value)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const idx = l.indexOf(':');
          if (idx === -1) return null;
          const column = l.slice(0, idx).trim();
          const [min, max] = l
            .slice(idx + 1)
            .split(',')
            .map((s) => s.trim());
          return { column, min, max };
        })
        .filter((p): p is { column: string; min: string; max: string } => p !== null);
      if (triples.length === 0) return [];
      const lines = [`${indent}${field.yamlKey}:`];
      for (const t of triples) {
        lines.push(`${indent}  - column: ${JSON.stringify(t.column)}`);
        if (t.min) lines.push(`${indent}    min_value: ${t.min}`);
        if (t.max) lines.push(`${indent}    max_value: ${t.max}`);
      }
      return lines;
    }
    case 'uniqueness-group': {
      const cols = splitList(String(value));
      if (cols.length === 0) return [];
      return [
        `${indent}${field.yamlKey}:`,
        `${indent}  - columns: [${cols.map((c) => JSON.stringify(c)).join(', ')}]`,
      ];
    }
    case 'bool':
      return [`${indent}${field.yamlKey}: ${value ? 'true' : 'false'}`];
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? [`${indent}${field.yamlKey}: ${n}`] : [];
    }
    default:
      return [`${indent}${field.yamlKey}: ${yamlScalar(value)}`];
  }
}

/** Builds ONE check-entry's YAML, as a single `- name: ...` list item
 * (2-space indented continuation lines), ready to sit directly under
 * `<check_type>:`. */
export function buildCheckEntryYaml(checkType: DQCheckTypeSpec, values: Record<string, unknown>): string {
  const allFields = [...COMMON_FIELDS, ...checkType.fields, ...COMMON_TRAILING_FIELDS];
  const nameField = allFields.find((f) => f.name === 'name')!;
  const nameValue = String(values.name ?? '').trim();
  const lines = [`- name: ${JSON.stringify(nameValue)}`];

  for (const field of allFields) {
    if (field === nameField) continue;
    lines.push(...renderFieldYaml(field, values[field.name], '  '));
  }
  return lines.join('\n');
}

/** Builds a full, fresh `attributes:` block for a brand-new
 * EnhancedDataQualityChecks instance containing exactly one check, for the
 * asset key given -- deterministic, no AI involved, same trust level as
 * "New Project"/"Install Component" already use for brand-new files. */
export function buildFreshAttributesYaml(assetKey: string, checkType: DQCheckTypeSpec, values: Record<string, unknown>): string {
  const entryLines = buildCheckEntryYaml(checkType, values).split('\n');
  const lines = [
    'attributes:',
    '  assets:',
    `    ${JSON.stringify(assetKey)}:`,
    `      ${checkType.id}:`,
    ...indentBlock(entryLines, '        '),
  ];
  return lines.join('\n') + '\n';
}

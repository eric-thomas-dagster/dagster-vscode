import * as vscode from 'vscode';

/**
 * A small, reusable "fill out a form, get structured values back" webview
 * -- built because the Enhanced Data Quality Checks component (and
 * friends like CronSchedule/AssetJob) have enough real fields that
 * asking the model to guess the right YAML from a one-line description
 * was the wrong tool for the job. This builds the YAML attributes
 * deterministically from whatever the user actually filled in -- no AI
 * involved in the structure, only (optionally) in how it gets merged
 * into an existing file afterward.
 */

export type FormFieldType = 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'asset-multiselect' | 'tags';

export interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  default?: string | number | boolean | string[];
  description?: string;
}

export interface FormSpec {
  title: string;
  fields: FormField[];
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderField(field: FormField, assetKeys: string[]): string {
  const id = `field_${field.name}`;
  const req = field.required ? '<span class="req">*</span>' : '';
  const desc = field.description ? `<div class="field-desc">${escapeHtml(field.description)}</div>` : '';

  let control = '';
  switch (field.type) {
    case 'textarea':
      control = `<textarea id="${id}" rows="3" placeholder="${escapeHtml(field.placeholder ?? '')}">${escapeHtml(String(field.default ?? ''))}</textarea>`;
      break;
    case 'number':
      control = `<input id="${id}" type="number" placeholder="${escapeHtml(field.placeholder ?? '')}" value="${escapeHtml(String(field.default ?? ''))}" />`;
      break;
    case 'checkbox':
      control = `<input id="${id}" type="checkbox" ${field.default ? 'checked' : ''} />`;
      break;
    case 'select':
      control = `<select id="${id}">${(field.options ?? [])
        .map((o) => `<option value="${escapeHtml(o)}" ${o === field.default ? 'selected' : ''}>${escapeHtml(o)}</option>`)
        .join('')}</select>`;
      break;
    case 'asset-multiselect': {
      const preselected = new Set(Array.isArray(field.default) ? field.default : []);
      control = `<div class="multiselect" id="${id}">${assetKeys
        .map(
          (k, i) =>
            `<label class="ms-item"><input type="checkbox" value="${escapeHtml(k)}" data-ms="${id}" id="${id}_${i}" ${preselected.has(k) ? 'checked' : ''} /> ${escapeHtml(k)}</label>`
        )
        .join('')}</div>`;
      break;
    }
    case 'tags':
      control = `<textarea id="${id}" rows="2" placeholder="one per line, key: value">${escapeHtml(String(field.default ?? ''))}</textarea>`;
      break;
    default:
      control = `<input id="${id}" type="text" placeholder="${escapeHtml(field.placeholder ?? '')}" value="${escapeHtml(String(field.default ?? ''))}" />`;
  }

  return `
    <div class="field">
      <label for="${id}">${escapeHtml(field.label)}${req}</label>
      ${desc}
      ${control}
    </div>`;
}

function renderHtml(nonce: string, csp: string, spec: FormSpec, assetKeys: string[]): string {
  const fieldsHtml = spec.fields.map((f) => renderField(f, assetKeys)).join('');
  const fieldNamesJson = JSON.stringify(spec.fields.map((f) => ({ name: f.name, type: f.type })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; font-size: 13px; }
    h2 { margin: 0 0 16px; }
    .field { margin-bottom: 14px; }
    label { display: block; font-weight: 600; margin-bottom: 4px; }
    .req { color: var(--vscode-errorForeground); margin-left: 2px; }
    .field-desc { font-size: 11px; opacity: 0.7; margin-bottom: 4px; }
    input[type="text"], input[type="number"], textarea, select {
      width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px 8px;
      font-family: inherit; font-size: inherit;
    }
    input[type="checkbox"] { margin-right: 6px; }
    .multiselect { max-height: 160px; overflow-y: auto; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 4px; padding: 6px; }
    .ms-item { display: block; font-weight: normal; padding: 2px 0; }
    .actions { display: flex; gap: 8px; margin-top: 18px; }
    button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;
    }
    button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <h2>${escapeHtml(spec.title)}</h2>
  <form id="form">${fieldsHtml}</form>
  <div class="actions">
    <button id="submit-btn">Continue</button>
    <button id="cancel-btn" class="secondary">Cancel</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const fieldDefs = ${fieldNamesJson};
    document.getElementById('submit-btn').addEventListener('click', () => {
      const values = {};
      for (const f of fieldDefs) {
        if (f.type === 'checkbox') {
          values[f.name] = document.getElementById('field_' + f.name).checked;
        } else if (f.type === 'asset-multiselect') {
          const container = document.getElementById('field_' + f.name);
          values[f.name] = Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value);
        } else if (f.type === 'number') {
          const raw = document.getElementById('field_' + f.name).value;
          values[f.name] = raw === '' ? undefined : Number(raw);
        } else {
          values[f.name] = document.getElementById('field_' + f.name).value;
        }
      }
      vscode.postMessage({ type: 'submit', values });
    });
    document.getElementById('cancel-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
  </script>
</body>
</html>`;
}

/** Opens the form, resolves with the submitted field values, or
 * `undefined` if cancelled/closed without submitting. */
export async function showComponentForm(
  spec: FormSpec,
  assetKeys: string[]
): Promise<Record<string, string | number | boolean | string[]> | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('dagsterPowerUser.componentForm', spec.title, vscode.ViewColumn.Active, {
      enableScripts: true,
    });
    let resolved = false;
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    panel.webview.html = renderHtml(nonce, csp, spec, assetKeys);

    panel.webview.onDidReceiveMessage((message: { type: string; values?: Record<string, unknown> }) => {
      if (message.type === 'submit') {
        resolved = true;
        resolve(message.values as Record<string, string | number | boolean | string[]>);
        panel.dispose();
      } else if (message.type === 'cancel') {
        resolved = true;
        resolve(undefined);
        panel.dispose();
      }
    });
    panel.onDidDispose(() => {
      if (!resolved) resolve(undefined);
    });
  });
}

import * as vscode from 'vscode';
import {
  getDagsterPlusCredentials,
  getDagsterPlusUsage,
  hasDagsterPlusCredentials,
  setDagsterPlusCredentials,
  type DagsterPlusUsage,
} from '../data/dagsterPlusClient';

let currentPanel: vscode.WebviewPanel | undefined;

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMonth(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Everything below the nonce'd CSP is either fully static or built from
 * numbers the host already computed (bar widths, labels) -- no runtime
 * string interpolation of model/user text happens client-side, so this
 * stays plain inline HTML rather than needing a separate media/*.js file
 * (the chat panel's double-escaping bug class doesn't apply: nothing here
 * is a hand-written regex over free-form text). */
function renderBody(nonce: string, connected: boolean, usage?: DagsterPlusUsage, error?: string): string {
  if (!connected) {
    return `
      <div class="cta">
        <i class="codicon codicon-plug"></i>
        <h2>Dagster+ isn't connected</h2>
        <p>Connect your Dagster+ organization to see real credit usage and plan limits here.</p>
        <button id="connect-btn">Connect Dagster+</button>
      </div>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('connect-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'connect' });
        });
      </script>`;
  }

  if (error) {
    return `
      <div class="cta">
        <i class="codicon codicon-error"></i>
        <h2>Couldn't load Dagster+ usage</h2>
        <p>${escapeHtml(error)}</p>
        <button id="retry-btn">Retry</button>
      </div>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('retry-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'refresh' });
        });
      </script>`;
  }

  if (!usage) return '';

  // The API exposes a running "used" total and an overall period
  // start/end (one month for a Stripe plan, up to a year for an
  // enterprise contract) but NEVER a per-month limit -- a forecast is
  // the only honest way to answer "are we on track", via simple linear
  // extrapolation of used-so-far over elapsed-fraction-of-period. This
  // degrades gracefully (and is suppressed) right at period start, where
  // elapsedFraction is near zero and the projection would be wild.
  const limitSection = usage.limit
    ? (() => {
        const { used, limit, periodStart, periodEnd } = usage.limit!;
        const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        const colorClass = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'ok';
        const period =
          periodStart != null && periodEnd != null
            ? `${formatDate(periodStart)} – ${formatDate(periodEnd)}`
            : '';

        let forecastHtml = '';
        if (periodStart != null && periodEnd != null && periodEnd > periodStart) {
          const now = Date.now() / 1000;
          const elapsedFraction = Math.min(1, Math.max(0, (now - periodStart) / (periodEnd - periodStart)));
          if (elapsedFraction > 0.02) {
            const projectedTotal = used / elapsedFraction;
            const projectedPct = limit > 0 ? (projectedTotal / limit) * 100 : 0;
            const forecastClass = projectedPct >= 100 ? 'danger' : projectedPct >= 90 ? 'warning' : 'ok';
            forecastHtml = `
              <p class="forecast ${forecastClass}">
                <i class="codicon codicon-${projectedPct >= 100 ? 'warning' : 'graph-line'}"></i>
                At the current pace: ~${Math.round(projectedTotal).toLocaleString()} credits by ${formatDate(periodEnd)}
                (${projectedPct.toFixed(0)}% of your ${limit.toLocaleString()} limit)
              </p>`;
          }
        }

        return `
          <section>
            <h3>This billing period</h3>
            <div class="bar-track"><div class="bar-fill ${colorClass}" style="width:${pct.toFixed(1)}%"></div></div>
            <div class="bar-caption">
              <span>${used.toLocaleString()} / ${limit.toLocaleString()} credits used</span>
              ${period ? `<span class="muted">${period}</span>` : ''}
            </div>
            ${forecastHtml}
          </section>`;
      })()
    : '';

  // A running (cumulative) total toward the SAME limit, one row per
  // month inside the current period -- the single current bar above
  // answers "where am I now", this answers "how did I get here", using
  // real monthly history rather than another forecast.
  const cumulativeSection = (() => {
    if (!usage.limit?.periodStart || !usage.limit?.periodEnd) return '';
    const { periodStart, periodEnd, limit } = usage.limit;
    const inPeriod = usage.monthly.filter((m) => m.start >= periodStart && m.start < periodEnd).sort((a, b) => a.start - b.start);
    if (inPeriod.length === 0) return '';

    let running = 0;
    const rows = inPeriod
      .map((m) => {
        running += m.value;
        const pct = limit > 0 ? Math.min(100, (running / limit) * 100) : 0;
        const colorClass = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'ok';
        return `
          <div class="hist-row">
            <span class="hist-label">${formatMonth(m.start)}</span>
            <div class="bar-track small"><div class="bar-fill ${colorClass}" style="width:${pct.toFixed(1)}%"></div></div>
            <span class="hist-value">${running.toLocaleString()}</span>
          </div>`;
      })
      .join('');

    return `
      <section>
        <h3>Cumulative usage this period</h3>
        <p class="muted hist-note">Running total toward your ${limit.toLocaleString()}-credit limit (${formatDate(periodStart)} – ${formatDate(periodEnd)}) -- each bar is that month's share of the limit itself, not relative to other months.</p>
        <div class="history">${rows}</div>
      </section>`;
  })();

  const sortedMonths = [...usage.monthly].sort((a, b) => b.start - a.start).slice(0, 12);

  // A running cumulative total (oldest to newest) drawn as an actual
  // sparkline -- a row of horizontal bars doesn't read as a trend over
  // TIME (bar length has no inherent left-to-right axis), a single rising
  // line does. Hand-rolled inline SVG rather than a charting dependency --
  // this is one polyline plus a filled area under it, nothing a library
  // earns its weight for here.
  const monthsAsc = [...usage.monthly].sort((a, b) => a.start - b.start).slice(-12);
  let runningTotal = 0;
  const cumulativePoints = monthsAsc.map((m) => {
    runningTotal += m.value;
    return runningTotal;
  });
  const grandTotal = Math.max(runningTotal, 1);

  const SPARK_W = 600;
  const SPARK_H = 100;
  const SPARK_PAD = 4;
  const stepX = monthsAsc.length > 1 ? (SPARK_W - SPARK_PAD * 2) / (monthsAsc.length - 1) : 0;
  const coords = cumulativePoints.map((v, i) => ({
    x: SPARK_PAD + i * stepX,
    y: SPARK_H - SPARK_PAD - (v / grandTotal) * (SPARK_H - SPARK_PAD * 2),
  }));
  const linePath = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath =
    coords.length > 0
      ? `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${SPARK_H} L${coords[0].x.toFixed(1)},${SPARK_H} Z`
      : '';

  const sparklineHtml =
    coords.length > 1
      ? `
        <svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" class="sparkline">
          <path d="${areaPath}" class="spark-area"></path>
          <path d="${linePath}" class="spark-line"></path>
        </svg>
        <div class="spark-labels">
          <span>${formatMonth(monthsAsc[0].start)}<br>${cumulativePoints[0].toLocaleString()}</span>
          <span class="spark-labels-right">${formatMonth(monthsAsc[monthsAsc.length - 1].start)}<br>${runningTotal.toLocaleString()}</span>
        </div>`
      : '<p class="muted">Not enough history yet for a trend line.</p>';

  // A pace forecast for whichever month is currently in progress -- this
  // works whether or not the org has any limit at all (an org with no
  // cap on file still gets SOME forecast, just measured against its own
  // recent trend instead of a hard number). Only fires when the most
  // recent bucket is genuinely the real current calendar month (not
  // guessing from the API's own start/end timestamps, which may not
  // mean "data collected through now").
  const monthForecastHtml = (() => {
    const latestMonth = sortedMonths[0];
    if (!latestMonth) return '';
    const latestDate = new Date(latestMonth.start * 1000);
    const now = new Date();
    const isCurrentCalendarMonth =
      latestDate.getUTCFullYear() === now.getUTCFullYear() && latestDate.getUTCMonth() === now.getUTCMonth();
    if (!isCurrentCalendarMonth) return '';

    const daysInMonth = new Date(Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth() + 1, 0)).getUTCDate();
    const dayOfMonth = now.getUTCDate();
    const elapsedFraction = Math.min(1, dayOfMonth / daysInMonth);
    if (elapsedFraction <= 0.02 || elapsedFraction >= 1) return '';

    const projected = latestMonth.value / elapsedFraction;
    const previousMonth = sortedMonths[1];
    const changeRatio = previousMonth && previousMonth.value > 0 ? projected / previousMonth.value : undefined;
    const colorClass = changeRatio == null ? 'neutral' : changeRatio >= 1.5 ? 'danger' : changeRatio >= 1.1 ? 'warning' : 'ok';
    const changeText =
      changeRatio != null
        ? `, vs ${previousMonth!.value.toLocaleString()} last month (${changeRatio >= 1 ? '+' : ''}${Math.round((changeRatio - 1) * 100)}%)`
        : '';

    return `
      <p class="forecast ${colorClass}">
        <i class="codicon codicon-graph-line"></i>
        ${formatMonth(latestMonth.start)} so far: ${latestMonth.value.toLocaleString()} credits (day ${dayOfMonth} of ${daysInMonth}) -- on pace for ~${Math.round(projected).toLocaleString()} by month end${changeText}.
      </p>`;
  })();

  return `
    <div class="header-row">
      <span class="plan-badge">${escapeHtml(usage.planType ?? 'UNKNOWN')} plan</span>
      <button id="refresh-btn" title="Refresh"><i class="codicon codicon-refresh"></i></button>
    </div>
    ${limitSection}
    ${cumulativeSection}
    <section>
      <h3>Accumulated credit usage</h3>
      <p class="muted hist-note">${
        monthsAsc.length
          ? `Running total across the last ${monthsAsc.length} month${monthsAsc.length === 1 ? '' : 's'} (oldest to newest) -- not a percentage of any cap, just this org's own total climbing over time.`
          : ''
      }</p>
      ${monthForecastHtml}
      <div class="spark-wrap">${sparklineHtml}</div>
    </section>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('refresh-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
      });
    </script>`;
}

function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, nonce: string, body: string): string {
  const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicons', 'codicon.css'));
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link href="${codiconCssUri}" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; }
    h2 { margin: 12px 0 4px; }
    h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; }
    .cta { text-align: center; padding: 60px 20px; }
    .cta .codicon { font-size: 32px; opacity: 0.7; }
    .cta p { opacity: 0.8; max-width: 420px; margin: 0 auto 16px; }
    button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    #refresh-btn { background: transparent; color: var(--vscode-foreground); padding: 4px 8px; }
    #refresh-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    .header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .plan-badge {
      font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      padding: 3px 10px; border-radius: 999px;
    }
    section { margin-bottom: 28px; }
    .bar-track { height: 10px; border-radius: 6px; background: var(--vscode-input-background); overflow: hidden; }
    .bar-track.small { height: 7px; }
    .bar-fill { height: 100%; border-radius: 6px; }
    .bar-fill.ok { background: var(--vscode-charts-green, #3fb950); }
    .bar-fill.warning { background: var(--vscode-charts-yellow, #d29922); }
    .bar-fill.danger { background: var(--vscode-charts-red, #f85149); }
    .bar-fill.neutral { background: var(--vscode-charts-blue, #4a9eff); }
    .bar-caption { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; }
    .forecast { margin: 10px 0 0; font-size: 12px; }
    .forecast.ok { color: var(--vscode-charts-green, #3fb950); }
    .forecast.warning { color: var(--vscode-charts-yellow, #d29922); }
    .forecast.danger { color: var(--vscode-charts-red, #f85149); }
    .forecast.neutral { color: var(--vscode-descriptionForeground); }
    .muted { opacity: 0.65; }
    .hist-note { font-size: 11px; line-height: 1.5; margin: -4px 0 12px; }
    .spark-wrap { margin-top: 4px; }
    .sparkline { width: 100%; height: 100px; display: block; }
    .spark-area { fill: var(--vscode-charts-blue, #4a9eff); opacity: 0.15; stroke: none; }
    .spark-line { fill: none; stroke: var(--vscode-charts-blue, #4a9eff); stroke-width: 2; vector-effect: non-scaling-stroke; }
    .spark-labels { display: flex; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; line-height: 1.4; }
    .spark-labels-right { text-align: right; }
    .history { display: flex; flex-direction: column; gap: 8px; }
    .hist-row { display: grid; grid-template-columns: 80px 1fr 70px; align-items: center; gap: 10px; }
    .hist-label { font-size: 12px; opacity: 0.8; }
    .hist-value { font-size: 12px; text-align: right; opacity: 0.8; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

async function refresh(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, mediaRoot: vscode.Uri): Promise<void> {
  const connected = await hasDagsterPlusCredentials(context);
  const nonce = getNonce();
  if (!connected) {
    panel.webview.html = renderHtml(panel.webview, mediaRoot, nonce, renderBody(nonce, false));
    return;
  }
  try {
    const creds = await getDagsterPlusCredentials(context);
    const usage = await getDagsterPlusUsage(creds!);
    panel.webview.html = renderHtml(panel.webview, mediaRoot, nonce, renderBody(nonce, true, usage));
  } catch (e) {
    panel.webview.html = renderHtml(
      panel.webview,
      mediaRoot,
      nonce,
      renderBody(nonce, true, undefined, e instanceof Error ? e.message : String(e))
    );
  }
}

/** Singleton panel, same re-reveal convention as the asset lineage panel. */
export async function showDagsterPlusUsagePanel(context: vscode.ExtensionContext): Promise<void> {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');

  if (currentPanel) {
    currentPanel.reveal();
    void refresh(context, currentPanel, mediaRoot);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'dagsterPowerUser.dagsterPlusUsage',
    'Dagster+ Usage',
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [mediaRoot] }
  );
  currentPanel = panel;
  panel.onDidDispose(() => {
    currentPanel = undefined;
  });

  panel.webview.onDidReceiveMessage(async (message: { type: string }) => {
    if (message.type === 'connect') {
      await setDagsterPlusCredentials(context);
      void refresh(context, panel, mediaRoot);
    } else if (message.type === 'refresh') {
      void refresh(context, panel, mediaRoot);
    }
  });

  void refresh(context, panel, mediaRoot);
}

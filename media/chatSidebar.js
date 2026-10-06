(function () {
  const vscode = acquireVsCodeApi();
  const plusUsageEl = document.getElementById('plus-usage');
  const plusUsageCtaEl = document.getElementById('plus-usage-cta');
  const plusUsageBarEl = document.getElementById('plus-usage-bar');
  const plusUsageLinkEl = document.getElementById('plus-usage-link');
  const plusBarFillEl = document.getElementById('plus-bar-fill');
  const plusBarTextEl = document.getElementById('plus-bar-text');
  const targetLocalEl = document.getElementById('target-local');
  const targetRemoteEl = document.getElementById('target-remote');
  const railListEl = document.getElementById('rail-list');
  const railNewBtnEl = document.getElementById('rail-new-btn');

  railNewBtnEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSessionInline' });
  });

  targetLocalEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'switchTarget', to: 'local' });
  });
  targetRemoteEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'switchTarget', to: 'remote' });
  });

  function renderTarget(isLocal, label) {
    targetLocalEl.classList.toggle('active', isLocal);
    targetRemoteEl.classList.toggle('active', !isLocal);
    targetLocalEl.textContent = 'Local';
    targetRemoteEl.textContent = isLocal ? 'Remote' : label;
  }

  // Quick-action buttons -- so the sidebar can drive the rest of the
  // extension directly (lineage, dg check, dev server, refresh) without
  // ever needing the Command Palette, per the "let this panel do
  // EVERYTHING" ask. Each just runs a real vscode command host-side.
  document.querySelectorAll('[data-run-command]').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'runCommand', command: btn.getAttribute('data-run-command') });
    });
  });

  // Per the "if they haven't connected Dagster+, we don't need to show
  // usage -- maybe a call to action" ask: 'disconnected' shows just a
  // connect link, never a zeroed-out bar. 'no-limit' (an org with no
  // Stripe/enterprise billing record on file -- a real, confirmed-live
  // case) falls back to a plain link into the full history view instead
  // of a bar with nothing to measure against.
  function renderPlusUsage(summary) {
    plusUsageCtaEl.style.display = 'none';
    plusUsageBarEl.style.display = 'none';
    plusUsageLinkEl.style.display = 'none';
    if (!summary || summary.state === 'disconnected') {
      plusUsageEl.classList.add('visible');
      plusUsageCtaEl.style.display = 'block';
      return;
    }
    if (summary.state === 'error') {
      plusUsageEl.classList.remove('visible');
      return;
    }
    if (summary.state === 'no-limit') {
      plusUsageEl.classList.add('visible');
      plusUsageLinkEl.style.display = 'block';
      return;
    }
    // state === 'limit'
    plusUsageEl.classList.add('visible');
    plusUsageBarEl.style.display = 'block';
    const pct = summary.limit > 0 ? Math.min(100, (summary.used / summary.limit) * 100) : 0;
    plusBarFillEl.style.width = pct.toFixed(1) + '%';
    plusBarFillEl.className = 'bar-fill ' + (pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'ok');
    plusBarTextEl.textContent = summary.used.toLocaleString() + ' / ' + summary.limit.toLocaleString() + ' credits';
  }

  function formatRelativeTime(ms) {
    const diffSeconds = Math.max(0, (Date.now() - ms) / 1000);
    if (diffSeconds < 60) return 'just now';
    if (diffSeconds < 3600) return Math.round(diffSeconds / 60) + 'm ago';
    if (diffSeconds < 86400) return Math.round(diffSeconds / 3600) + 'h ago';
    return Math.round(diffSeconds / 86400) + 'd ago';
  }

  // Full re-render on every 'sessionList' message -- the list is short
  // (QuickPick scale, not a paginated feed), so there's no need for
  // incremental DOM patching. Clicking a session OPENS its own editor
  // tab (host-side) rather than swapping anything in place here -- the
  // sidebar has no conversation UI of its own anymore.
  function renderSessionList(sessions, activeId) {
    railListEl.innerHTML = '';
    sessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'rail-item' + (s.id === activeId ? ' active' : '') + (s.archived ? ' archived' : '');
      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'switchSession', id: s.id });
      });

      const title = document.createElement('div');
      title.className = 'rail-item-title';
      title.textContent = s.title;
      item.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'rail-item-meta';
      meta.textContent = s.messageCount + ' msg' + (s.messageCount === 1 ? '' : 's') + ' · ' + formatRelativeTime(s.updatedAt);
      item.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'rail-item-actions';

      const archiveIcon = document.createElement('i');
      archiveIcon.className = 'codicon codicon-' + (s.archived ? 'inbox' : 'archive');
      archiveIcon.title = s.archived ? 'Unarchive' : 'Archive';
      archiveIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'archiveSessionInline', id: s.id, archived: !s.archived });
      });
      actions.appendChild(archiveIcon);

      const deleteIcon = document.createElement('i');
      deleteIcon.className = 'codicon codicon-trash';
      deleteIcon.title = 'Delete';
      deleteIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSessionInline', id: s.id });
      });
      actions.appendChild(deleteIcon);

      item.appendChild(actions);
      railListEl.appendChild(item);
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'plusUsage') {
      renderPlusUsage(message.summary);
    } else if (message.type === 'target') {
      renderTarget(message.isLocal, message.label);
    } else if (message.type === 'sessionList') {
      renderSessionList(message.sessions, message.activeId);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

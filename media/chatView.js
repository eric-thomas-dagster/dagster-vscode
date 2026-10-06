(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const keyBanner = document.getElementById('key-banner');
  const inputRow = document.getElementById('input-row');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const sessionTitleEl = document.getElementById('session-title');
  const plusUsageEl = document.getElementById('plus-usage');
  const plusUsageCtaEl = document.getElementById('plus-usage-cta');
  const plusUsageBarEl = document.getElementById('plus-usage-bar');
  const plusUsageLinkEl = document.getElementById('plus-usage-link');
  const plusBarFillEl = document.getElementById('plus-bar-fill');
  const plusBarTextEl = document.getElementById('plus-bar-text');
  const targetLocalEl = document.getElementById('target-local');
  const targetRemoteEl = document.getElementById('target-remote');
  // Only present in the editor-tab panel's HTML -- the sidebar view has
  // no rail markup, so every lookup below comes back null there and every
  // function that touches these is written to no-op gracefully.
  const railListEl = document.getElementById('rail-list');
  const railNewBtnEl = document.getElementById('rail-new-btn');
  let thinkingEl = null;

  if (railNewBtnEl) {
    railNewBtnEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'newSessionInline' });
    });
  }

  function formatRelativeTime(ms) {
    const diffSeconds = Math.max(0, (Date.now() - ms) / 1000);
    if (diffSeconds < 60) return 'just now';
    if (diffSeconds < 3600) return Math.round(diffSeconds / 60) + 'm ago';
    if (diffSeconds < 86400) return Math.round(diffSeconds / 3600) + 'h ago';
    return Math.round(diffSeconds / 86400) + 'd ago';
  }

  // Full re-render on every 'sessionList' message -- the list is short
  // (a QuickPick-scale history, not a paginated feed), so there's no need
  // for incremental DOM patching here.
  function renderSessionList(sessions, activeId) {
    if (!railListEl) return;
    railListEl.innerHTML = '';
    sessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'rail-item' + (s.id === activeId ? ' active' : '') + (s.archived ? ' archived' : '');
      item.addEventListener('click', () => {
        if (s.id !== activeId) vscode.postMessage({ type: 'switchSession', id: s.id });
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

  document.getElementById('set-key-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'setKey' });
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

  // Quick-action buttons -- so the chat panel can drive the rest of the
  // extension directly (lineage, dg check, dev server, refresh) without
  // ever needing the Command Palette, per the "let this panel do
  // EVERYTHING" ask. Each just runs a real vscode command host-side.
  document.querySelectorAll('[data-run-command]').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'runCommand', command: btn.getAttribute('data-run-command') });
    });
  });

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Markdown-style [text](url) first, then any remaining bare https?://
  // URLs the model just wrote inline -- docs citations (the whole reason
  // this exists) come back as plain URLs or markdown links depending on
  // the model/prompt, so both need to end up clickable. Placeholder-
  // substitution rather than a lookbehind-guarded regex: tested a
  // lookbehind-on-`href="` approach first and it double-wrapped the case
  // where a markdown link's visible text is itself the URL (the anchor's
  // *text*, not just its href, isn't preceded by `href="`). Also strips
  // trailing sentence punctuation (".", ",", ")", etc.) from the URL
  // itself -- otherwise a URL ending a sentence swallows the period.
  function linkify(html) {
    const placeholders = [];
    let out = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) => {
      const token = '\u0000LINK' + placeholders.length + '\u0000';
      placeholders.push('<a href="' + url + '" target="_blank">' + text + '</a>');
      return token;
    });
    out = out.replace(/(https?:\/\/[^\s<>"]+)/g, (rawUrl) => {
      const trailing = (rawUrl.match(/[.,;:!?)]+$/) || [''])[0];
      const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
      const token = '\u0000LINK' + placeholders.length + '\u0000';
      placeholders.push('<a href="' + url + '" target="_blank">' + url + '</a>' + trailing);
      return token;
    });
    placeholders.forEach((h, i) => {
      out = out.replace('\u0000LINK' + i + '\u0000', h);
    });
    return out;
  }

  // Small, deliberately-limited markdown renderer -- bold/italic/inline
  // code/links/bullet lists/paragraphs, enough for the kind of answers
  // an LLM actually produces. Escapes HTML first so model output is
  // never interpreted as live markup.
  function renderMarkdown(raw) {
    const escaped = escapeHtml(raw);
    const withInline = linkify(escaped)
      .replace(/\\(.)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
    const lines = withInline.split(/\n/);
    let html = '';
    let inList = false;
    let paraBuf = [];
    const flushPara = () => {
      if (paraBuf.length) {
        html += '<p>' + paraBuf.join('<br>') + '</p>';
        paraBuf = [];
      }
    };
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        flushPara();
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += '<li>' + bullet[1] + '</li>';
      } else {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        if (line.trim() === '') {
          flushPara();
        } else {
          paraBuf.push(line);
        }
      }
    }
    if (inList) html += '</ul>';
    flushPara();
    return html || '<p></p>';
  }

  function addMessage(text, role) {
    const row = document.createElement('div');
    row.className = 'row ' + role;
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = role === 'user' ? 'You' : 'Dagster Expert';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = renderMarkdown(text);
    row.appendChild(label);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showThinking() {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking';
    thinkingEl.textContent = 'Dagster Expert is thinking…';
    messagesEl.appendChild(thinkingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideThinking() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function addError(text) {
    const div = document.createElement('div');
    div.className = 'error-note';
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addSystemNote(text) {
    const div = document.createElement('div');
    div.className = 'system-note';
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setBusy(busy) {
    input.disabled = busy;
    sendBtn.disabled = busy;
  }

  function send() {
    const question = input.value.trim();
    if (!question) return;
    addMessage(question, 'user');
    input.value = '';
    setBusy(true);
    showThinking();
    vscode.postMessage({ type: 'ask', question });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Session messages are the single source of truth for what's
  // displayed -- 'loadHistory' always replaces the whole list from the
  // persisted session rather than being appended to piecemeal, so a
  // session switch (or this same session after a new answer lands)
  // renders identically either way. The optimistic `addMessage` call in
  // send() still shows the user's own question instantly, before the
  // round trip; loadHistory reconciles shortly after.
  function renderHistory(messages) {
    messagesEl.innerHTML = '';
    if (messages.length === 0) {
      addSystemNote("Ask Dagster Expert about this project's assets, groups, and kinds -- or use a button above.");
      return;
    }
    messages.forEach((m) => addMessage(m.content, m.role));
  }

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

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'needsKey') {
      keyBanner.style.display = 'block';
      inputRow.style.display = 'none';
    } else if (message.type === 'ready') {
      keyBanner.style.display = 'none';
      inputRow.style.display = 'flex';
    } else if (message.type === 'loadHistory') {
      sessionTitleEl.textContent = message.title;
      renderHistory(message.messages);
    } else if (message.type === 'plusUsage') {
      renderPlusUsage(message.summary);
    } else if (message.type === 'target') {
      renderTarget(message.isLocal, message.label);
    } else if (message.type === 'sessionList') {
      renderSessionList(message.sessions, message.activeId);
    } else if (message.type === 'answer') {
      hideThinking();
      setBusy(false);
    } else if (message.type === 'error') {
      hideThinking();
      setBusy(false);
      addError(message.text);
    } else if (message.type === 'commandRan') {
      addSystemNote('Ran: ' + message.label);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

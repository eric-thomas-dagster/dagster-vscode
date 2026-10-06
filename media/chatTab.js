(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const keyBanner = document.getElementById('key-banner');
  const inputRow = document.getElementById('input-row');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const sessionTitleEl = document.getElementById('session-title');
  let thinkingEl = null;

  document.getElementById('set-key-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'setKey' });
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

  // This session's messages are the single source of truth for what's
  // displayed -- 'loadHistory' always replaces the whole list rather than
  // being appended to piecemeal, so a resync after an external change
  // (e.g. a quick action appending from elsewhere) renders identically to
  // a fresh load. The optimistic `addMessage` call in send() still shows
  // the user's own question instantly, before the round trip; loadHistory
  // reconciles shortly after.
  function renderHistory(messages) {
    messagesEl.innerHTML = '';
    if (messages.length === 0) {
      addSystemNote("Ask Dagster Expert about this project's assets, groups, and kinds.");
      return;
    }
    messages.forEach((m) => addMessage(m.content, m.role));
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
    } else if (message.type === 'answer') {
      hideThinking();
      setBusy(false);
    } else if (message.type === 'error') {
      hideThinking();
      setBusy(false);
      addError(message.text);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

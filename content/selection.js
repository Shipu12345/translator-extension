// Selection translation: shows the English for the selected text in a floating
// card (Shadow DOM, so page styles can't leak in) with a Copy button.
(() => {
  const GTE = (globalThis.GTE = globalThis.GTE || {});
  const { engine } = GTE;

  let host = null;
  let request = 0;

  const STYLE = `
    :host { all: initial; }
    .card { position: absolute; z-index: 2147483647; width: min(480px, calc(100vw - 32px));
      max-height: 60vh; display: flex; flex-direction: column;
      font: 15px/1.5 system-ui, -apple-system, sans-serif; color: #111827; background: #fff;
      border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
    .head .title { flex: 1; }
    .body { padding: 10px 12px; overflow: auto; white-space: pre-wrap; }
    .body.muted { color: #6b7280; font-style: italic; }
    button { font: inherit; font-size: 12px; cursor: pointer; border: 1px solid #d1d5db;
      background: #f9fafb; color: inherit; border-radius: 6px; padding: 3px 10px; }
    button:hover { background: #f3f4f6; }
    button.close { border: 0; background: transparent; font-size: 18px; line-height: 1; padding: 0 4px; }
    button.primary { background: #4a90d9; border-color: #4a90d9; color: #fff; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1f2937; color: #f3f4f6; border-color: #374151; }
      .head { border-color: #374151; color: #9ca3af; }
      button { background: #374151; border-color: #4b5563; }
      button:hover { background: #4b5563; }
      .body.muted { color: #9ca3af; }
    }
  `;

  function close() {
    host?.remove();
    host = null;
    request++;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
  }

  const onKey = (e) => e.key === 'Escape' && close();
  const onOutside = (e) => host && !e.composedPath().includes(host) && close();

  function selectionRect() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width || rect.height) return rect;
    }
    return null;
  }

  function open(rect) {
    close();
    host = document.createElement('div');
    host.id = 'gte-host';
    host.setAttribute('translate', 'no');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="card" role="dialog" aria-label="English translation">
        <div class="head"><span class="title">German → English</span>
          <button class="copy" hidden>Copy</button><button class="close" aria-label="Close">×</button></div>
        <div class="body muted">Translating…</div>
      </div>`;
    const card = root.querySelector('.card');

    // Position below the selection (or above if there's no room), in page coordinates.
    const width = Math.min(480, window.innerWidth - 32);
    const r = rect || { left: window.innerWidth / 2 - width / 2, bottom: 80, top: 80 };
    const left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16));
    const below = window.innerHeight - r.bottom > 220 || r.top < 220;
    card.style.left = `${left + window.scrollX}px`;
    if (below) card.style.top = `${r.bottom + 8 + window.scrollY}px`;
    else card.style.bottom = `${document.documentElement.clientHeight - r.top + 8 - window.scrollY}px`;

    root.querySelector('.close').onclick = close;
    document.documentElement.append(host);
    document.addEventListener('keydown', onKey, true);
    // Defer so the click that triggered us doesn't immediately close the card.
    setTimeout(() => document.addEventListener('mousedown', onOutside, true));
    return root;
  }

  async function translateSelection(fallbackText) {
    const selected = window.getSelection()?.toString().trim() || fallbackText?.trim();
    if (!selected) return;
    const root = open(selectionRect());
    const id = ++request;
    const body = root.querySelector('.body');
    const copy = root.querySelector('.copy');

    try {
      // Translate paragraph by paragraph to keep the selection's structure.
      const paragraphs = selected.split(/\n\s*\n/);
      const out = [];
      for (const p of paragraphs) {
        out.push(await engine.translate(p.replace(/\s*\n\s*/g, ' '), { urgent: true }));
        if (id !== request) return;
        body.textContent = out.join('\n\n') + (out.length < paragraphs.length ? '\n\n…' : '');
        body.classList.remove('muted');
      }
      const result = out.join('\n\n');
      body.textContent = result;
      copy.hidden = false;
      copy.onclick = async () => {
        await navigator.clipboard.writeText(result);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1200);
      };
    } catch (err) {
      if (id !== request || err?.cancelled) return;
      engine.log('Selection translation failed', err);
      body.classList.add('muted');
      body.textContent = engine.describeError(err);
      if (err?.code === 'needs-download') {
        const btn = document.createElement('button');
        btn.className = 'primary';
        btn.textContent = 'Enable translation';
        btn.onclick = () => {
          btn.disabled = true;
          engine
            .downloadModel((loaded) => (btn.textContent = `Enabling… ${Math.round(loaded * 100)}%`))
            .then(() => translateSelection(selected))
            .catch((e) => {
              body.textContent = `Download failed: ${engine.describeError(e)}`;
            });
        };
        body.append(document.createElement('br'), btn);
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'translate-selection') translateSelection(msg.text);
    return false;
  });
})();

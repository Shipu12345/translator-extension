// Page translation: finds text blocks, translates them lazily as they scroll
// near the viewport, and shows the English in one of two ways:
//  - "below": an English line under the German block (bilingual), for content text;
//  - "replace": the German text swapped for English in place (German on hover),
//    for short UI labels and layouts that can't grow (menus, buttons, badges,
//    clamped titles, flex rows). See PROJECT.md, decision 4.
(() => {
  const GTE = (globalThis.GTE = globalThis.GTE || {});
  const { engine } = GTE;

  const TR_CLASS = 'gte-tr';
  const OWN_UI = new Set(['gte-host', 'gte-notice']);
  // Never translated, and not descended into.
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'SVG', 'MATH', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'HEAD', 'TITLE',
  ]);
  // Kept as part of a sentence's text, but never translated on their own.
  const CODE_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR']);
  const INTERACTIVE =
    'button, summary, label, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"]';
  const NAVIGATION =
    'nav, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], [role="toolbar"]';
  const HAS_LETTERS = /\p{L}.*\p{L}/su;
  const FOOTNOTE = /^\s*\[[^\]]{1,12}\]\s*$/; // e.g. [12], [a], [Anm. 3]

  let active = false;
  let session = 0; // bumped on every start/stop so stale async work is discarded
  let blocked = false; // engine can't work (model missing etc.); stop trying until re-toggled
  const state = new WeakMap(); // block element -> 'pending' | 'working' | 'done' | 'skip'
  const tracked = new Set(); // blocks we've marked, for cleanup
  const inserted = new Set(); // our "below" spans (may live inside shadow roots)
  const replaced = new Map(); // text node -> { original, english }
  const titled = new Set(); // blocks we gave a German-original tooltip
  const observedRoots = new Set(); // document.body + open shadow roots under mutation watch
  const boundaryCache = new WeakMap();
  let intersection = null;
  let mutation = null;
  let pendingRoots = new Set();
  let mutationTimer = null;

  // ---------- block discovery ----------

  function isSkippedElement(el) {
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (tag === 'SUP' && FOOTNOTE.test(el.textContent)) return true;
    if (el.classList.contains(TR_CLASS) || el.classList.contains('notranslate')) return true;
    if (OWN_UI.has(el.id)) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  const lettersIn = (node) => node?.nodeType === Node.TEXT_NODE && HAS_LETTERS.test(node.nodeValue);

  // Does this element start its own text block? Block-level boxes do. Inline-block
  // style boxes (buttons, pills, menu links) do too, unless they sit inside running
  // text, e.g. a styled word in the middle of a sentence.
  function isBoundary(el) {
    let result = boundaryCache.get(el);
    if (result !== undefined) return result;
    const display = getComputedStyle(el).display;
    if (display === 'inline' || display === 'contents') result = false;
    else if (display.startsWith('inline-')) result = !(lettersIn(el.previousSibling) || lettersIn(el.nextSibling));
    else result = true;
    boundaryCache.set(el, result);
    return result;
  }

  // Nearest block-level ancestor of a text node, or null if inside skipped content.
  function blockFor(textNode) {
    let el = textNode.parentElement;
    let block = null;
    while (el) {
      if (isSkippedElement(el)) return null;
      if (!block && isBoundary(el)) block = el;
      el = el.parentElement;
    }
    return block;
  }

  // Text nodes belonging directly to this block (not to nested blocks or skipped content).
  // Text nodes belonging directly to this block (not to nested blocks or skipped
  // content), plus the <br> elements between them.
  function ownTextNodes(block) {
    const nodes = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE || node.tagName === 'BR') return NodeFilter.FILTER_ACCEPT;
        if (isSkippedElement(node)) return NodeFilter.FILTER_REJECT;
        if (node !== block && isBoundary(node)) return NodeFilter.FILTER_REJECT; // nested block
        return NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function blockText(nodes) {
    return nodes.map((n) => (n.nodeType === Node.TEXT_NODE ? n.nodeValue : ' ')).join('').replace(/\s+/g, ' ').trim();
  }

  function charRect(node, offset) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    return range.getBoundingClientRect();
  }

  // How two adjacent text nodes with no whitespace between them are laid out:
  // 'line' when the page shows them on separate lines (e.g. a news kicker above the
  // headline), 'gap' when CSS spaces them apart on one line, 'none' when they form
  // one word (e.g. "Haupt<b>stadt</b>").
  function junction(prev, next) {
    if (!prev.nodeValue || !next.nodeValue || prev.parentElement === next.parentElement) return 'none';
    if (/\s$/.test(prev.nodeValue) || /^\s/.test(next.nodeValue)) return 'none';
    const a = charRect(prev, prev.nodeValue.length - 1);
    const b = charRect(next, 0);
    if (!a.height || !b.height) return 'none';
    if (b.top >= a.bottom - 1) return 'line';
    return b.left - a.right > 2 ? 'gap' : 'none';
  }

  const joinText = (nodes, gaps) =>
    nodes.map((n, i) => (gaps.has(i) ? ' ' : '') + n.nodeValue).join('').replace(/\s+/g, ' ').trim();

  // Split a block's text at line breaks (<br>, or kicker-style lines), so text laid out
  // as several lines inside one element gets an English line after each of them rather
  // than one at the very end. `gaps` marks nodes that CSS visually separates from the
  // previous one, so they're joined with a space (and replaced separately in place).
  function segmentsOf(nodes) {
    const segments = [];
    let current = { nodes: [], gaps: new Set(), br: null };
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const prev = current.nodes[current.nodes.length - 1];
        const kind = prev ? junction(prev, node) : 'none';
        if (kind === 'line') {
          segments.push(current);
          current = { nodes: [], gaps: new Set(), br: null };
        } else if (kind === 'gap') {
          current.gaps.add(current.nodes.length);
        }
        current.nodes.push(node);
      } else {
        current.br = node;
        segments.push(current);
        current = { nodes: [], gaps: new Set(), br: null };
      }
    }
    segments.push(current);
    return segments
      .map((seg) => ({ ...seg, text: joinText(seg.nodes, seg.gaps) }))
      .filter((seg) => HAS_LETTERS.test(seg.text));
  }

  function watchRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    mutation.observe(root, { childList: true, subtree: true });
  }

  function discover(root) {
    if (!active || blocked) return;
    const start = root.nodeType === Node.TEXT_NODE ? root.parentNode : root;
    if (!start?.isConnected) return;
    for (let el = start.nodeType === Node.ELEMENT_NODE ? start : start.host; el; el = el.parentElement) {
      if (isSkippedElement(el)) return;
    }

    const found = new Set();
    const shadowRoots = [];
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return HAS_LETTERS.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        if (isSkippedElement(node)) return NodeFilter.FILTER_REJECT;
        if (node.shadowRoot) shadowRoots.push(node.shadowRoot); // open shadow roots (e.g. cookie banners)
        return NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) found.add(blockFor(walker.currentNode));

    for (const block of found) {
      if (!block || state.has(block) || CODE_TAGS.has(block.tagName.toUpperCase())) continue;
      state.set(block, 'pending');
      tracked.add(block);
      block.setAttribute('data-gte', 'pending');
      intersection.observe(block);
    }
    for (const shadow of shadowRoots) {
      watchRoot(shadow);
      discover(shadow);
    }
  }

  // ---------- layout decisions ----------

  // Screen-reader-only text (1px boxes, clipped) must not get a visible translation.
  function isVisuallyHidden(block) {
    const r = block.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return true;
    let el = block.parentElement;
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      const rect = el.getBoundingClientRect();
      if ((rect.width < 2 || rect.height < 2) && getComputedStyle(el).overflow !== 'visible') return true;
    }
    return false;
  }

  // "replace" for UI labels and layouts that can't take an extra line; "below" otherwise.
  function chooseMode(block, text) {
    if (block.closest(INTERACTIVE) || block.closest(NAVIGATION)) return 'replace';
    const cs = getComputedStyle(block);
    if (cs.display.startsWith('inline-')) return 'replace';
    if (/flex|grid/.test(cs.display) && !cs.flexDirection.startsWith('column')) return 'replace';
    if (cs.webkitLineClamp !== 'none' || cs.textOverflow === 'ellipsis' || cs.whiteSpace === 'nowrap') {
      return 'replace';
    }
    const isHeading = /^H[1-6]$/.test(block.tagName.toUpperCase());
    if (!isHeading && text.length <= 40 && text.split(' ').length <= 3) return 'replace';
    return 'below';
  }

  // Ancestors that clip their content (fixed-height bars, cards, pills). Scroll
  // containers are fine to grow, so only hidden/clip count.
  function clippingAncestors(block) {
    const list = [];
    let el = block;
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (/hidden|clip/.test(cs.overflowY + cs.overflowX)) list.push(el);
    }
    return list;
  }

  const overflows = (el) => el.scrollHeight > el.clientHeight + 1;

  // ---------- rendering ----------

  function insertBelow(block, segment, english) {
    const nodes = segment.nodes;
    const span = document.createElement('span');
    span.className = TR_CLASS;
    span.lang = 'en';
    span.setAttribute('translate', 'no');
    span.textContent = english;

    // Match the text as it actually looks (the styling often sits on an inner link or span).
    const textEl = nodes[nodes.length - 1].parentElement || block;
    const ts = getComputedStyle(textEl);
    const align = getComputedStyle(block).textAlign;
    const centered = /center|right|end/.test(align);
    const style = {
      display: 'block',
      margin: '0.25em 0 0',
      padding: centered ? '0' : '0 0 0 0.5em',
      'border-left': centered ? 'none' : '2px solid rgba(74, 144, 217, 0.85)',
      'text-align': align,
      'font-family': ts.fontFamily,
      'font-size': ts.fontSize,
      'font-weight': ts.fontWeight,
      'line-height': ts.lineHeight,
      'letter-spacing': ts.letterSpacing,
      color: ts.color,
      opacity: '0.8',
      'font-style': 'normal',
      'text-transform': 'none',
      'text-decoration': 'none',
      'white-space': 'normal',
      float: 'none',
      position: 'static',
    };
    for (const [prop, value] of Object.entries(style)) span.style.setProperty(prop, value, 'important');

    // Place right after the segment's line break, else after the block's last own text
    // (so a block that also contains nested blocks gets it next to its own text).
    if (segment.br) {
      segment.br.after(span);
    } else {
      let anchor = nodes[nodes.length - 1];
      while (anchor && anchor.parentNode !== block) anchor = anchor.parentNode;
      if (anchor) anchor.after(span);
      else block.append(span);
    }
    inserted.add(span);
    return span;
  }

  // Swap the German text for English in place. German original stays available on hover.
  // One phrase is translated as a whole (better quality) and written into its first text
  // node; pieces that belong to different links (breadcrumbs, link lists) are translated
  // one by one so every link keeps its own text.
  async function replaceInPlace(block, segments, fullText, mySession) {
    const linkOf = (n) => n.parentElement?.closest('a');
    const groups = [];
    for (const seg of segments) {
      // Visually separate pieces (CSS gaps) are replaced separately, keeping their own styling.
      const runs = [[]];
      seg.nodes.forEach((n, i) => {
        if (seg.gaps.has(i) && runs[runs.length - 1].length) runs.push([]);
        runs[runs.length - 1].push(n);
      });
      for (const run of runs) {
        const targets = run.filter((n) => lettersIn(n) && !insideCode(n, block));
        if (!targets.length) continue;
        if (targets.every((n) => linkOf(n) === linkOf(targets[0]))) {
          // Source text includes whitespace-only nodes between the pieces ("15 bar" " " "Pumpendruck").
          const span = run.slice(run.indexOf(targets[0]), run.indexOf(targets[targets.length - 1]) + 1);
          groups.push({ nodes: targets, text: blockText(span) });
        } else {
          groups.push(...targets.map((n) => ({ nodes: [n], text: blockText([n]) })));
        }
      }
    }
    if (!groups.length) return false;
    const sources = groups.map((g) => g.text);
    const results = await Promise.all(sources.map((t) => engine.translate(t)));
    if (mySession !== session || !block.isConnected) return false;

    let changed = false;
    const write = (node, text) => {
      const original = node.nodeValue;
      replaced.set(node, { original, english: text });
      node.nodeValue = text;
    };
    groups.forEach(({ nodes: group }, i) => {
      const english = results[i]?.trim();
      if (!english || english.toLowerCase() === sources[i].toLowerCase()) return;
      const first = group[0].nodeValue;
      // Keep the surrounding whitespace so words don't run together.
      const last = group[group.length - 1].nodeValue;
      write(group[0], first.match(/^\s*/)[0] + english + last.match(/\s*$/)[0]);
      for (const node of group.slice(1)) write(node, '');
      changed = true;
    });
    if (changed && !block.hasAttribute('title')) {
      block.setAttribute('title', fullText);
      titled.add(block);
    }
    return changed;
  }

  function insideCode(node, block) {
    for (let el = node.parentElement; el && el !== block; el = el.parentElement) {
      if (CODE_TAGS.has(el.tagName.toUpperCase())) return true;
    }
    return false;
  }

  // ---------- translation ----------

  async function processBlock(block) {
    if (state.get(block) !== 'pending' || blocked) return;
    state.set(block, 'working');
    const mySession = session;
    try {
      const nodes = ownTextNodes(block);
      const text = blockText(nodes);
      if (!HAS_LETTERS.test(text) || isVisuallyHidden(block) || !(await engine.isGerman(text))) {
        if (mySession === session) mark(block, 'skip');
        return;
      }
      const segments = segmentsOf(nodes);
      const inPlace = async () => {
        const changed = await replaceInPlace(block, segments, text, mySession);
        if (mySession === session) mark(block, changed ? 'done' : 'skip');
      };

      if (chooseMode(block, text) === 'replace') return await inPlace();

      const results = await Promise.all(segments.map((seg) => engine.translate(seg.text)));
      if (mySession !== session || !block.isConnected) return;

      // Insert, then check the layout: if a clipping container can no longer show
      // everything, the extra lines don't fit, so translate in place instead.
      const clippers = clippingAncestors(block).filter((el) => !overflows(el));
      const spans = [];
      segments.forEach((seg, i) => {
        const english = results[i]?.trim();
        if (english && english.toLowerCase() !== seg.text.toLowerCase()) spans.push(insertBelow(block, seg, english));
      });
      if (!spans.length) return mark(block, 'skip');
      if (clippers.some(overflows)) {
        for (const span of spans) {
          span.remove();
          inserted.delete(span);
        }
        return await inPlace();
      }
      mark(block, 'done');
    } catch (err) {
      if (err?.cancelled || mySession !== session) return;
      if (err instanceof engine.EngineError) {
        state.set(block, 'pending'); // allow retry after re-toggle
        handleEngineError(err);
      } else {
        // Anything else is specific to this block; never let it stop the whole page.
        engine.log('Skipped a block after an error', err, block);
        mark(block, 'skip');
      }
    }
  }

  function mark(block, status) {
    state.set(block, status);
    block.setAttribute('data-gte', status);
  }

  function handleEngineError(err) {
    if (blocked) return;
    blocked = true;
    engine.log('Translation failed', err);
    chrome.runtime.sendMessage({ type: 'status', status: 'error' }).catch(() => {});
    if (err?.code === 'needs-download') {
      // Chrome only lets a site start the translator after a click on that page
      // (once per site; the model itself is shared and downloads only once).
      const notice = GTE.notify('Chrome needs one click to enable German→English translation on this site.', 'Enable translation', () => {
        // Runs inside the click, which is what Chrome requires.
        notice.update('Enabling… 0%');
        engine
          .downloadModel((loaded) => notice.update(`Enabling… ${Math.round(loaded * 100)}%`))
          .then(() => {
            notice.update('Enabled. Translating…');
            notice.dismissIn(3000);
            chrome.runtime.sendMessage({ type: 'status', status: 'ok' }).catch(() => {});
            stop();
            start();
          })
          .catch((e) => {
            engine.log('Model download failed', e);
            notice.update(`Download failed: ${engine.describeError(e)}`);
            notice.showAction(true);
          });
      }, { keepOpen: true });
    } else {
      GTE.notify(engine.describeError(err));
    }
  }

  // ---------- observers ----------

  function onIntersect(entries) {
    const visible = entries.filter((e) => e.isIntersecting);
    // Closest to the viewport first.
    const vh = window.innerHeight;
    const distance = (e) => {
      const r = e.boundingClientRect;
      return r.bottom < 0 ? -r.bottom : r.top > vh ? r.top - vh : 0;
    };
    visible.sort((a, b) => distance(a) - distance(b));
    for (const entry of visible) {
      intersection.unobserve(entry.target);
      processBlock(entry.target);
    }
  }

  function onMutations(records) {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && (node.classList.contains(TR_CLASS) || OWN_UI.has(node.id))) continue;
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) pendingRoots.add(node);
      }
    }
    if (pendingRoots.size && !mutationTimer) {
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        const roots = pendingRoots;
        pendingRoots = new Set();
        for (const root of roots) if (root.isConnected) discover(root);
      }, 300);
    }
  }

  // ---------- activation ----------

  function start() {
    if (active || !document.body) return;
    active = true;
    session++;
    blocked = false;
    intersection = new IntersectionObserver(onIntersect, { rootMargin: '100% 0px' });
    mutation = new MutationObserver(onMutations);
    watchRoot(document.body);
    discover(document.body);
    engine.log('Page translation on');
  }

  function stop() {
    if (!active) return;
    active = false;
    session++;
    engine.cancelAll();
    intersection?.disconnect();
    mutation?.disconnect();
    observedRoots.clear();
    clearTimeout(mutationTimer);
    mutationTimer = null;
    pendingRoots = new Set();
    for (const span of inserted) span.remove();
    inserted.clear();
    for (const [node, { original, english }] of replaced) {
      if (node.nodeValue === english) node.nodeValue = original; // leave text the page has since changed
    }
    replaced.clear();
    for (const block of titled) block.removeAttribute('title');
    titled.clear();
    for (const block of tracked) {
      block.removeAttribute('data-gte');
      state.delete(block);
    }
    tracked.clear();
    engine.log('Page translation off');
  }

  // ---------- small in-page notice ----------

  GTE.notify = (message, actionLabel, action, { keepOpen = false } = {}) => {
    document.getElementById('gte-notice')?.remove();
    const host = document.createElement('div');
    host.id = 'gte-notice';
    host.setAttribute('translate', 'no');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .box { position: fixed; top: 16px; right: 16px; z-index: 2147483647; max-width: 360px;
          font: 14px/1.4 system-ui, sans-serif; background: #1f2937; color: #f9fafb;
          padding: 12px 14px; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.25);
          display: flex; gap: 10px; align-items: center; }
        .msg { flex: 1; }
        button { font: inherit; cursor: pointer; border: 0; border-radius: 6px; padding: 4px 10px; }
        .act { background: #4a90d9; color: #fff; white-space: nowrap; }
        .close { background: transparent; color: #9ca3af; padding: 0 4px; font-size: 18px; }
      </style>
      <div class="box"><span class="msg"></span></div>`;
    const box = root.querySelector('.box');
    const msg = root.querySelector('.msg');
    msg.textContent = message;
    let btn = null;
    if (actionLabel) {
      btn = document.createElement('button');
      btn.className = 'act';
      btn.textContent = actionLabel;
      btn.onclick = () => {
        btn.hidden = true;
        action();
      };
      box.append(btn);
    }
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.onclick = () => host.remove();
    box.append(close);
    document.documentElement.append(host);
    let timer = keepOpen ? null : setTimeout(() => host.remove(), 12000);
    return {
      update: (text) => (msg.textContent = text),
      showAction: (show) => btn && (btn.hidden = !show),
      dismissIn: (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => host.remove(), ms);
      },
    };
  };

  // ---------- messaging ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'set-active') {
      msg.active ? start() : stop();
      sendResponse({ ok: true });
    }
    return false;
  });

  // Resume if translation was switched on for this tab before navigating here.
  chrome.runtime.sendMessage({ type: 'hello' }).then(
    (reply) => reply?.active && start(),
    () => {}
  );
})();

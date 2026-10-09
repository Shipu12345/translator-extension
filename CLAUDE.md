# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is
A personal Manifest V3 Chrome extension that translates German web pages and selections to English **only on demand**, using Chrome's built-in on-device `Translator` and `LanguageDetector` APIs. `PROJECT.md` records every product decision and the alternatives that were rejected. Read it before changing behavior, and update it when a decision changes.

Hard constraints:
- **Zero cost:** no paid APIs, keys, servers or Web Store.
- **Plain JS:** no build step and no npm dependencies.
- **Never auto-translate** a tab the user hasn't switched on.

## Develop / test
- No build, lint or test tooling. Syntax-check with `for f in background.js content/*.js; do node --check "$f"; done`.
- Run: `chrome://extensions` → Developer mode → Load unpacked (repo root). After edits, click reload on the extension card **and** reload the target tab, because content scripts don't hot-update.
- Content-script logs are prefixed `[GTE]` (console.debug, so enable "Verbose" in DevTools). Service-worker logs: the "service worker" link on the extension card.
- **Chrome masks Translator availability per origin.** A site sees `downloadable` until it has called `Translator.create()` once inside a real click on *that page*, even when the model is already on disk (`~/Library/Application Support/Google/Chrome/TranslateKit/models/de_en`).
  - The toolbar click doesn't count as a click on the page.
  - `Translator` isn't exposed on `chrome-extension://` pages.
  - So the only enable path is `engine.downloadModel()`, called synchronously (no `await` before it) from the "Enable translation" button in the in-page notice or the selection card.
  - `setup/setup.html` is just a welcome page.
- Layout testing on real sites: the content scripts can be run in a normal tab, without loading the extension, by injecting `engine.js` + `page.js` with a small `chrome.runtime` mock. Optionally also mock `window.Translator` to skip the per-site enable click.
- Testing gotchas:
  - IntersectionObserver never fires in hidden or background tabs, and `requestAnimationFrame` never fires there either. Test with a visible tab.
  - `LanguageDetector.create()` can reject (with `undefined`) in hidden documents. The engine treats detector failures as "German".

## Release (GitHub, free distribution: PROJECT.md decision 10b)
- Bump `version` in `manifest.json`, then build the zip from only the extension files:
  `zip -r german-english-translator-vX.Y.Z.zip manifest.json background.js content setup icons`
- Publish it: `gh release create vX.Y.Z german-english-translator-vX.Y.Z.zip`. Zips are gitignored.

## Architecture
- **background.js** (service worker)
  - Holds the per-tab on/off state in `chrome.storage.session` (`tab:<id>`).
  - Handles the action click (Alt+T is `_execute_action`), the `translate-selection` command and the context menu, and sets the `EN` badge.
  - Content scripts send `hello` on every page load and resume if the tab is on. That's how translation persists across navigation without new clicks, and why content scripts are declared statically for `<all_urls>` (they stay idle until activated).
- **Content scripts** share one isolated world and communicate through the `globalThis.GTE` namespace. Load order in `manifest.json` matters: `engine.js` first.
  - `content/engine.js`:
    - Memoized Translator/Detector.
    - A **serial queue** with a generation counter: `cancelAll()` drops queued jobs.
    - `{urgent:true}` bypasses the queue (used for selections).
    - Long-text handling: anything over `inputQuota` or `MAX_CHUNK_CHARS` is split into sentence groups with `Intl.Segmenter`.
    - A cache keyed by source text.
    - Errors carry `code`: `needs-download` | `unsupported` | `unavailable`.
  - `content/page.js`:
    - A "block" is the nearest boundary box around a text node. Block-level boxes are boundaries, and so are `inline-*` boxes (buttons, pills) unless text sits next to them in a sentence. A block's text is only its *own* text nodes.
    - Discovery walks open shadow roots too.
    - Blocks are tracked in a WeakMap plus a `data-gte` attribute, and translated lazily via IntersectionObserver (`rootMargin: 100%`). New DOM is picked up by a debounced MutationObserver.
    - **Two display modes**, chosen in `chooseMode()` (PROJECT.md, decision 4):
      - `below`: inserts `span.gte-tr` with inline `!important` styles copied from the text's own element (there's no stylesheet, so it works in shadow roots).
      - `replace`: swaps text-node values and keeps originals in `replaced` for restoring.
      - A `below` insert that makes a clipping ancestor overflow falls back to `replace`.
    - `segmentsOf()` splits a block at `<br>` and at visual line breaks between text nodes, measured with Range rects. It also records same-line CSS gaps, so kicker/headline pairs and spec pieces don't run together.
    - A `session` counter discards async results that finish after a stop/start.
    - Only `EngineError`s block the page and show the notice. Any other exception just skips that block.
    - `stop()` must leave the DOM exactly as it was.
  - `content/selection.js`: the floating translation card, in a closed Shadow DOM. The in-page toast (`GTE.notify`) lives in page.js.
- Anything inserted into pages must use `textContent` (never `innerHTML` with translated or page text) and be excluded from discovery (`.gte-tr`, `#gte-host`, `#gte-notice`, `translate="no"`).

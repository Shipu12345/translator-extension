# German → English Translator: project brief and decisions

## What we are building

A personal Chrome extension that translates German web pages and selected text into English, **only when asked**.

### Why
- Google Translate fails on long texts: page translation stops partway, and pasted text hits the 5,000-character limit.
- A tool is needed that reliably translates long German pages and passages into English.

### Hard requirements
- **One direction only:** German → English.
- **Never automatic:** nothing translates until the user clicks the icon, presses a shortcut or uses the right-click menu.
- **Must handle long texts.**
- **Zero cost:** free to build, run and maintain. No paid APIs, no API keys, no servers, no store fees.
- **Mainly for Chrome** (desktop).

### Environment (checked 2026-10-05)
- macOS with Chrome 154. The built-in AI APIs need Chrome 138+.
- 24 GB RAM, enough for the on-device model.

---

## Decisions

Each decision below came from the planning interview. Alternatives that were considered and rejected are listed for future reference.

### 1. What gets translated
**Decision:** whole web pages **and** selected text.
- Rejected: a paste-text box (not needed).
- Rejected: PDFs in Chrome's viewer (extensions can't modify the built-in PDF viewer).

### 2. Translation engine
**Decision:** Chrome's built-in **Translator API** (`sourceLanguage: 'de'`, `targetLanguage: 'en'`).
- On-device and free, with no key and no rate limits.
- Works offline after a one-time model download.
- Text never leaves the machine.
- Rejected: the unofficial Google Translate endpoint (undocumented, rate-limited, can break at any time, sends text to Google).
- Rejected: self-hosted LibreTranslate (needs a running server, lower quality).
- Rejected: a built-in + Google fallback hybrid (extra code and an external dependency).
- Accepted trade-off: quality is slightly below Google web translate.

### 3. Trigger
**Decision:** clicking the toolbar icon toggles translation of the current page (click again to remove it).
- Rejected: a popup menu (one extra click).

### 4. Display style
**Decision:** **bilingual** for content, **in place** for UI. *(Refined 2026-10-06 after testing 20 sites.)*

**Bilingual ("below") for content text:** paragraphs, headings, list items and long table cells.
- The English line appears under the German, which stays as is.
- The line copies the font size, family, weight and colour from the element that actually holds the German text (often an inner link or span). So it fits dark themes, hero images and coloured cards.
- It has a thin blue left bar and 80% opacity. Centered or right-aligned text keeps its alignment and has no bar.

**In place ("replace") for UI labels and layouts that can't grow:**
- Which elements:
  - menus and navigation
  - buttons, tabs, checkboxes and form labels
  - badges and pills
  - short labels of 3 words or fewer (footer links, breadcrumbs, sidebar categories, product specs, short table cells)
  - line-clamped or ellipsised titles
  - flex and grid rows
  - anything that would be clipped by a fixed-height container. This is detected by inserting the line and then checking for overflow.
- How it behaves:
  - The German text is swapped for English, and hovering shows the German original.
  - Inline structure is kept: links stay links, and a kicker keeps its own colour.

**Line handling in both modes:**
- Text split by `<br>`, or laid out on separate lines (like a news kicker above a headline), is translated line by line.
- Pieces that CSS spaces apart are joined with a space.

**Toggling off** restores the page exactly: inserted lines are removed, swapped text is restored, and added tooltips are removed.

**Rejected:**
- Bilingual everywhere: on most sites it broke menus, badges and buttons by clipping or overflowing them.
- Dimming the German.

### 5. Long pages
**Decision:** **translate only as you scroll.**
- Paragraphs are translated when they approach the viewport, with about one screen of look-ahead so the text is usually ready before you reach it.
- Every paragraph gets translated eventually, so none are skipped. This is the main fix for Google's long-page failures.
- Very long single paragraphs or selections are split into sentence groups that fit the model's input quota, then rejoined.
- Rejected: viewport first, then the rest in the background.
- Rejected: translating everything at once.

### 6. Selected text
**Decision:** a **floating card** next to the selection with the English text and a **Copy** button.
- Closes with Esc or a click outside.
- Works whether or not page translation is on.
- Rejected: Chrome side panel.

### 7. Dynamic content (infinite scroll, "load more", single-page apps)
**Decision:** **yes**, while translation is on for a tab, newly added German content is translated too.

### 8. Navigation
**Decision:** once switched on, translation **stays on for that tab** across page loads until toggled off.
- Other tabs are never touched.
- Closing the tab forgets the state.
- Rejected: off on every new page.

### 9. Mixed-language pages
**Decision:** **skip non-German blocks.**
- Chrome's built-in **LanguageDetector API** (also free and on-device) checks each paragraph, and only German ones get an English line.
- Rejected: translating everything (would duplicate English text).

### 10. Tech stack and install
**Decision:** **Manifest V3, plain JavaScript**, with no build step and no npm dependencies.
- Installed via `chrome://extensions` → Developer mode → **Load unpacked**.
- Rejected: TypeScript + Vite (needs a build step).

### 10b. Publishing *(decided 2026-10-06)*
**Decision:** **option B, a free public GitHub repo.** Each release has a zip; users unzip it and use Load unpacked.
- Rejected: the Chrome Web Store (one-time $5 developer fee, which breaks the zero-cost rule).
- Rejected: personal-only (no sharing).
- Trade-offs:
  - No automatic updates.
  - Chrome may show a "developer mode extensions" warning.

### 11. Keyboard shortcuts
**Decision:**
- `Alt+T` (Option+T on Mac): toggle page translation.
- `Alt+Shift+T`: translate the selection.
- A right-click menu item, **"Translate selection to English"**, is also available.
- Shortcuts can be changed at `chrome://extensions/shortcuts`.

### 12. Model download / per-site enable
**Decision:** a one-click **"Enable translation"** button **on the web page itself**, shown the first time you translate on each site. The selection card shows the same button.
- Translation starts automatically after that click.

**Why:**
- **Chrome hides the model from each new site.** To prevent tracking, Chrome reports the model as "downloadable" until that site has started it once with a real click on the page. The ~100 MB model itself is only downloaded once and is shared by all sites and profiles.
- **Extension pages can't help.** Chrome doesn't offer the translator API on extension pages, so a setup page can't download or unlock anything.
- **A toolbar-icon click doesn't count** as a click on the page.

The setup page is now only a welcome/how-to page, opened on install.

*History (2026-10-05):* first a setup-page download button (it can't work there), then an in-page button. Verified end-to-end on de.wikipedia.org with Chrome's real translator.

---

## Architecture

```
manifest.json            MV3 manifest: permissions (storage, contextMenus), content scripts, shortcuts
background.js            service worker: per-tab on/off state, icon/shortcut/context menu, badge
content/engine.js        Translator + LanguageDetector wrapper: queue, chunking, cache, errors
content/page.js          finds text blocks, lazy (on-scroll) translation, the two display modes
content/selection.js     floating selection-translation card (Shadow DOM)
setup/setup.html + .css  welcome / how-to page, opened on install
icons/                   extension icons
```

### Flow
1. Click the icon (or press Alt+T). The background flips the tab's state, stores it in `chrome.storage.session`, messages the content script and sets the badge to `EN`.
2. The content script finds text blocks, including inside open shadow roots such as cookie banners, and watches them with an IntersectionObserver.
   - A block is the nearest block-level box around some text.
   - Button-like inline boxes count as their own block, unless they sit inside a sentence.
3. When a block nears the viewport:
   1. Hidden (screen-reader-only) blocks and non-German blocks are skipped.
   2. A display mode is chosen (decision 4).
   3. The text is translated through a serial queue, with sentence-chunking for long text and a cache for repeated strings.
   4. The English is shown.
4. A MutationObserver picks up newly added content while the tab is active.
5. On a new page load in that tab, the content script asks the background for the state and resumes if it's on.
6. Clicking again restores the page exactly.

### Not translated (known limits)
- Footnote markers like `[12]` (bracketed superscripts).
- Code blocks (`pre`), inputs and textareas. Inline `code` inside a sentence stays part of the sentence.
- Editable areas and elements marked `translate="no"` or `.notranslate`.
- Cross-origin iframes. This includes many cookie and pay walls (e.g. taz, Duden), which extensions can't reach.
- Closed shadow roots.
- Chrome's PDF viewer.
- Browsers other than desktop Chrome.

## Design test report (2026-10-06)
The real content scripts were run on 20 German sites, with screenshots and analysis of each, then fixed and re-checked.
- **Sites 1–10 used Chrome's real translator:**
  - de.wikipedia.org
  - tagesschau.de
  - dw.com
  - bundesregierung.de
  - otto.de
  - developer.mozilla.org/de
  - bahn.de
  - chefkoch.de
  - berlin.de
  - zdfheute.de
- **Sites 11–20 used a stand-in translator.** Chrome's translation service stopped for the browser session after heavy testing, and layout testing doesn't depend on translation quality.
  - dm.de
  - taz.de
  - adac.de
  - ikea.com/de
  - duden.de
  - deutschlandfunk.de
  - gutefrage.net
  - arbeitsagentur.de
  - tum.de
  - lidl.de

| Problem found | Where | Fix |
|---|---|---|
| English lines clipped or overflowing in fixed-height menus, badges, pills, "Sort by" dropdowns | tagesschau, bundesregierung, otto, bahn, chefkoch | "Replace in place" mode for UI and short labels, plus an overflow check after inserting |
| Left bar looked wrong on centered headings and modals | tagesschau, dw, chefkoch | No bar for centered or right-aligned text; alignment is kept |
| English tiny and dark on hero images (styles taken from the container, not the text) | dw | Copy typography and colour from the element holding the text |
| Cookie banners not translated (in shadow DOM) | dw (CMP), dm (Usercentrics) | Discover and observe open shadow roots; all styles inline |
| Line-clamped product and teaser titles never showed the English | otto, tagesschau, zdf | Clamped, ellipsised or nowrap blocks use in-place mode |
| Accordion and FAQ questions untranslated (inside `<button>`) | bahn | Buttons are translated in place instead of skipped |
| Inline code dropped from the sentence ("The HTML element…") | MDN | Inline `code` stays in the sentence |
| Stray English line from a screen-reader-only duplicate title | bahn | Skip visually hidden blocks |
| One English block at the very bottom of a long `<br>`-separated text | zdf banner | Split blocks at `<br>` and translate line by line |
| Kicker and headline merged ("VerfassungsschutzGrünen-…") | deutschlandfunk | Detect visual line breaks and CSS gaps between text pieces |
| Space lost between spec pieces ("15 barPumpendruck") | otto | Keep whitespace-only nodes when building in-place phrases |
| Soft hyphens leaked into English ("Rei-che") | zdf | Strip soft hyphens before translating |
| One bad block stopped the whole page (an empty text node made a range measurement throw) | otto | Guard the measurement; non-engine errors only skip that block |
| Misleading "not available on this device" when Chrome's service stopped | all, after heavy testing | Message now says to restart Chrome; mid-page failures show a notice |

## Testing checklist
1. Load unpacked. A welcome page opens.
2. On a long German page (e.g. a long de.wikipedia.org article), click the icon. The first time on a site, click **Enable translation** in the box at the top right.
3. English appears under paragraphs and headings as you scroll, all the way to the bottom. Menus, buttons and badges switch to English in place (hover to see the German), and no menu or card layout breaks.
4. English paragraphs on mixed pages get no duplicate.
5. Click a link on the same site: it auto-translates. A new tab stays German.
6. Click the icon again: the page is restored exactly.
7. Select text → right-click → "Translate selection to English" (or Alt+Shift+T): the card shows the full translation, and Copy works.
8. On infinite-scroll pages, new items get translated.

---

## Status log
- **2026-10-05**:
  - **Built v1.0.0.** All files are in place.
  - **Tested on de.wikipedia.org/wiki/Berlin with a mock translator:**
    - Found 1,583 blocks in 54 ms.
    - Lazy translation on scroll works.
    - A 3,300-character paragraph was split into 3 chunks and rejoined.
    - Dynamically added content was translated.
    - Toggling off restored the page completely.
  - **Not yet run:** the real model download and a real-translation pass (the steps in the testing checklist after Load unpacked).
- **2026-10-05 (later):** The user reported that the model download didn't work.
  - A real click on a normal web page downloaded the model successfully (`downloadable` → `available`).
  - **Fixes:**
    - Added an in-page "Download model" button.
    - The setup page no longer crashes on undefined rejections, and it no longer waits on the language detector.
    - Clearer error messages.
- **2026-10-05 (fix 2):** The user reported being sent to the setup page, which then told them to open a German page.
  - **Root causes:**
    - The `Translator` API isn't exposed on extension pages.
    - Chrome masks the availability per site (the model was on disk, yet each new site reported `downloadable`).
  - **Fixes:**
    - Removed every redirect to the setup page.
    - The in-page "Enable translation" button now handles it.
  - **Verified with the real translator on de.wikipedia.org/wiki/Brandenburger_Tor:**
    - One click took the site to `available`.
    - Real English appeared under each block.
    - Non-German blocks were skipped.
- **2026-10-06:**
  - **Publishing:** the user chose option B (free GitHub repo). Removed the unneeded `tabs` permission.
  - **Design pass across 20 sites:** see the design test report above. `page.js` was rewritten around the two display modes, and `content.css` was dropped (styles are now inline so they work inside shadow roots).
  - **Pending:** a real-translator re-check of the new layout code, after a Chrome restart (Chrome's translation service had stopped for that browser session).

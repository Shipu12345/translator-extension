# German → English Translator (Chrome extension)

On-demand German→English translation for Chrome. It uses Chrome's **built-in, on-device Translator**, so it's free, needs no API key, works offline after setup, and keeps your text on your machine.

- **Click the icon** (or press `Alt+T` / `⌥T`): English appears under each German paragraph as you scroll, even on very long pages. Click again to remove it.
- **Menus, buttons and labels** switch to English in place so page layouts don't break. Hover over one to see the German.
- Translation **stays on for that tab** while you browse the site, and never starts by itself anywhere else.
- **Selected text:** right-click → *Translate selection to English*, or press `Alt+Shift+T`. A card shows the English with a Copy button.
- Paragraphs that aren't German (English quotes, code and so on) are skipped.

## Install (one time)
1. Download the latest `german-english-translator-*.zip` from the [Releases](../../releases) page and unzip it, or clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. A welcome page opens with instructions. The first time you translate on each website, a small box appears at the top right. Click **Enable translation** once; Chrome requires one click per site. The very first time, it also downloads the ~100 MB language model.
5. Optional: pin the extension using the puzzle-piece icon in the toolbar.

Requires desktop Chrome 138 or newer.

## Updating
Download the new release, replace the folder's contents, then click reload ↻ on the extension card in `chrome://extensions` and reload your open tabs.

## Limits
- Pages inside cross-origin iframes (including some cookie and paywall pop-ups) and Chrome's built-in PDF viewer aren't translated.
- If you see "Chrome's translator isn't available right now", restart Chrome.
- `chrome://` pages and the Chrome Web Store can't be translated (Chrome blocks extensions there).

See [PROJECT.md](PROJECT.md) for the full brief and design decisions.

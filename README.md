# Page Translator

A Chrome extension that translates web pages into English, including pages where Chrome's
built-in "Translate this page" gives up: `notranslate` markers, a wrong `<html lang>`,
iframes, content loaded later (AJAX, ASP.NET UpdatePanels, single-page apps) and open shadow DOM.

- **Engines:** Chrome's built-in on-device Translator API first, then the free Google
  translate endpoint as a fallback. No API keys and no paid services.
- **Language detection** uses the page's visible text. The `<html lang>` attribute is never trusted.
- **Extras:** hover a translated element to see the original text, and select any text to
  translate just that selection.
- **Requirements:** desktop Chrome 138 or later. Plain JavaScript with no build step and no dependencies.

---

## Install

1. Download the code: `git clone https://github.com/Bakar9832/page-translator.git`, or use
   **Code → Download ZIP** on GitHub and unzip it.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the `page-translator` folder (the one that contains `manifest.json`).
5. Click the puzzle-piece icon in the toolbar, then the pin next to **Page Translator**, so its icon stays visible.
6. Optional: to use it on local `file:///` pages, open the extension's **Details** and turn on
   **Allow access to file URLs**.

Tabs that were open before installing don't have the extension running yet. Refresh them, or
open the popup on them, which injects it automatically.

## Usage

- **Translate a page:** click the toolbar icon, then **Translate this page**. The first time you
  translate a new language, Chrome may download that language's model. A progress bar appears;
  keep the popup open until it finishes.
- **Show original:** restores the page exactly as it was.
- **Auto-translate:** translates every non-English page as soon as it loads. English pages are left alone.
- **Engine:** *Auto* (Chrome built-in, then Google), *Chrome built-in only*, or *Google only*.
- **Ignore "do not translate" markers:** on by default. Turn it off to respect pages and
  sections that ask not to be translated.
- **Hover** a translated element to see the original text in a tooltip.
- **Select text** on any page and click the **Translate** button that appears to see that text in English.
- **Diagnostics** (in the popup) shows, for each frame, whether Chrome's translator is usable there.
  It also lets you clear the translation cache.

## Updating after code changes

| What you changed | What to do |
|---|---|
| `manifest.json`, `background.js`, content scripts | Click the reload icon on the extension's card in `chrome://extensions`, then **refresh open tabs**. Old content scripts stay in already-open tabs, and they stop working after a reload. |
| Popup files only | Close and reopen the popup. |

If a tab says "Extension was reloaded. Refresh this page.", refresh it.

To debug:
- **Service worker:** in `chrome://extensions`, click **service worker** on the card.
- **Content scripts:** open the page's DevTools, go to Console, and use the context dropdown to pick "Page Translator".
- **Popup:** right-click the popup and choose **Inspect**.

---

## How it works

```
 ┌──────────── popup (extension page) ────────────┐
 │ settings → chrome.storage.local                 │
 │ Translator.create() on click (model download)   │
 │ status ← chrome.scripting.executeScript(allFrames)
 │ commands → chrome.tabs.sendMessage (all frames) │
 └───────────────────────┬─────────────────────────┘
                         │
      ┌──────────────────▼───────────────────┐    runtime.sendMessage   ┌──────────────────────┐
      │ content scripts, one copy PER FRAME  │ ───────────────────────▶ │ background.js        │
      │ engine.js: detect + Chrome Translator│   google / cacheGet /    │ (service worker)     │
      │ dom.js: walk, apply, restore         │   cachePut               │ Google fetch, queue, │
      │ ui.js: tooltip + selection bubble    │ ◀─────────────────────── │ retry, LRU cache     │
      │ main.js: auto, observer, messages    │                          └──────────────────────┘
      └──────────────────────────────────────┘
```

- **One content-script instance per frame.** `all_frames`, `match_about_blank` and
  `match_origin_as_fallback` make Chrome inject into every iframe, including
  `about:blank`/`srcdoc` frames and frames such as `data:`/`blob:` that inherit their creator's origin.
  Each frame translates itself, so cross-origin iframes work without any cross-frame access.
- **Translation flow for each text:**
  1. The frame's memory cache.
  2. The persistent cache in the service worker.
  3. Language check. English is skipped. Short strings use the page language.
  4. Chrome Translator, if usable in this frame. Otherwise Google, through the service worker.
- **No feedback loop.** `dom.js` records exactly what it wrote. The MutationObserver ignores
  changes that match that record and re-translates only real page changes.
- **"Show original"** writes back the original text, but only where the page hasn't since replaced ours.
- **Form-safe buttons.** Some servers (e.g. ASP.NET WebForms) read a submit button's label when
  the form is posted. The original label is put back for the instant of the click, so those sites keep working.

### Where Chrome's built-in AI APIs work

| Context | `Translator` / `LanguageDetector` |
|---|---|
| Popup (extension page) | Yes. It runs on a real user gesture, so this is where model downloads start. |
| Content script, top frame / same-origin iframe | Yes. The APIs are on `Window`, and the content script sees the frame's window. |
| Content script, cross-origin iframe | Blocked by the `translator` Permissions Policy (default `self`) unless the embedding page set `allow="translator"`. The extension detects this and uses Google. |
| Service worker | **No.** The APIs are Window-only and not available in workers. |

A model that isn't downloaded yet needs a **user gesture** to start the download. A message
from the popup is not a gesture inside the page. So:

- **Auto mode on a new language:** Google is used right away, and the popup offers the Chrome model download.
- **Clicking "Translate this page":** the popup starts the download inside the click and shows progress.
  Models are shared across the browser, so every page uses it from then on.
- **Selection "Translate" button:** this is a real click in the page, so it can also start a download.

Chrome's support for these APIs varies by version, platform and hardware. If yours behaves
differently, the popup's **Diagnostics** section will show it, and Auto mode falls back to Google anyway.

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves your settings and the translation cache (`chrome.storage.local`, capped at about 2M characters, oldest entries evicted first). |
| `activeTab` | Temporary access to the current tab when you click the toolbar icon. Mostly covered by `<all_urls>`, but kept so the popup still works if you restrict the extension's site access in Chrome. |
| `scripting` | Lets the popup read each frame's status and inject the content scripts into tabs opened before the extension was installed or reloaded. |
| `host_permissions: <all_urls>` | Runs the content scripts in every page and iframe, which Auto-translate needs. |
| `host_permissions: https://translate.googleapis.com/*` | Lets the service worker call the Google fallback. Already covered by `<all_urls>`, but listed explicitly so the intent is clear. |

**Privacy:** with the Chrome engine, text never leaves your machine. With Google (the fallback,
or "Google only"), page text is sent to `translate.googleapis.com`. Nothing else is collected or sent anywhere.

---

## Testing

The `test` folder has a Swedish test page that covers the tricky cases. Start its server
(needs [Node.js](https://nodejs.org/), no packages to install):

```
node test/serve.js
```

Open **http://localhost:8080/test.html**. Use `localhost`, not `127.0.0.1`, because the
cross-origin iframe is loaded from the other host name.

Checklist:

- [ ] Popup shows **Page language: Swedish (sv)**, even though the page says `lang="en"` and has a `notranslate` meta tag.
- [ ] **Translate this page.** Headings, paragraphs, table, `<title>` (tab text) and button labels turn English. The English paragraph and the price/date line are unchanged.
- [ ] The first time, a **download progress bar** may appear for the Swedish model. The popup then shows **Engine used: Chrome built-in**. The cross-origin frame shows Google in Diagnostics, which is expected.
- [ ] Placeholders, `title` tooltips, image `alt`, `aria-label`, Submit/Reset/Button labels, select options and the optgroup label are translated.
- [ ] Type in the username field, translate again: **your typed text is unchanged**.
- [ ] `<code>`, `<pre>`, the textarea's content and the contenteditable box stay Swedish. The textarea **placeholder** is translated.
- [ ] Section marked `translate="no"`: translated with **Ignore markers ON**. Turn it **OFF**, click Show original, then Translate: the popup says the page is marked "do not translate", because the meta tag is honoured.
- [ ] All three iframes (same-origin, cross-origin, about:blank) and the **open** shadow root are translated. The **closed** shadow root stays Swedish (limitation).
- [ ] The "Nya upphandlingar" block that appears after 3 s gets translated within about half a second.
- [ ] **Simulera postback** (repeatedly): the new panel content is translated every time.
- [ ] "Ansluter till servern" changes at 5 s and the new text is translated.
- [ ] Click **Logga in** (translated "Log in"): the line below shows the posted value is the **original "Logga in"**.
- [ ] Hover a translated paragraph: a small tooltip shows the Swedish original.
- [ ] **Show original:** everything (text, attributes, tab title, frames) returns exactly to Swedish.
- [ ] Select some Swedish text, with the page translated or not: a **Translate** button appears. Click it to see the English in a bubble. Esc or a click outside closes it.
- [ ] Turn on **Auto-translate** and reload: the page translates by itself. An English site (e.g. wikipedia.org) is left alone.
- [ ] Switch the engine to **Google only**, Show original, then Translate: the engine shows Google.

### Testing on a real website

Pick a non-English site with a login form and content that loads dynamically:

1. Open the page and the popup. Check the detected language, and use Diagnostics to see how many frames there are and whether `Translator` is "present" in each.
2. Click **Translate this page** and allow the one-time model download if offered. Menus, body text and footer become English.
3. Check form fields: placeholders, labels and button text are English.
4. Submit a form or press a button that posts back. The site should behave normally, and new content is translated automatically.
5. Use dropdowns or tabs that load content dynamically. The new content turns English shortly after it appears.
6. Hover a translated label to see the original, and select text to test the selection bubble.
7. Click **Show original**. The page is exactly as before, and the site still works.
8. Turn on Auto-translate, open the page in a new tab, and confirm it translates on load.

---

## Known limitations

- **Target language is English only.**
- **Closed shadow roots** can't be reached by extensions. **Shadow roots attached after an
  element was already scanned** are only picked up when that part of the page changes again.
- **Text in canvas, images, PDFs** (Chrome's PDF viewer), video and CSS `content:` is not translated.
- **`chrome://` pages, the Chrome Web Store and other extensions' pages** can't be scripted by extensions.
- **Selection translation doesn't work inside shadow DOM, `<input>` or `<textarea>`.** It uses
  `window.getSelection()`, which doesn't report selections there.
- **Translation is per text node.** A sentence split across tags (`Hej <b>du</b>!`) is translated in
  pieces, so word order can be a bit off. This is the trade-off for never breaking the page's DOM or event handlers.
- **Whitespace and newlines inside a text node are collapsed** in the translation, which matters for
  elements styled with `white-space: pre` (real `<pre>` is skipped).
- **The Google endpoint is unofficial and rate-limited**, and may change without notice. Requests are
  serialised with a 150 ms gap and back off on HTTP 429. Very large pages in Google mode take a few seconds.
- **Language detection on very short frames** (a few words) may be undecided. Auto mode then waits
  for more content. Manual translate still works through Google auto-detection.
- **Submit-button labels** are swapped back to the original only for the instant of a click. Scripts
  that read `input.value` at some other time will see the English label.
- **Chrome models not yet downloaded:** in Auto mode, the first visit to a new language uses Google
  until you start the model download from the popup.

## License

[MIT](LICENSE)

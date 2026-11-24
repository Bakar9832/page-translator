# Page Translator (personal Chrome extension)

Translates web pages into English, including pages where Chrome's built-in
"Translate this page" gives up: `notranslate` markers, a wrong `<html lang>`,
iframes, content loaded later (AJAX / ASP.NET UpdatePanels / SPAs) and open shadow DOM.

- **Engines:** Chrome's built-in on-device Translator API first, then the free
  Google endpoint as a fallback. No API keys and no paid services.
- **Language detection** uses the page's visible text. The `<html lang>` attribute is never trusted.
- **Requirements:** desktop Chrome 138 or later. Plain JavaScript with no build step.

---

## Install (Windows, "Load unpacked")

1. Put the folder at `C:\Work\Projects\page-translator`. `manifest.json` must be directly inside it.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select `C:\Work\Projects\page-translator`.
5. Click the puzzle-piece icon in the toolbar, then the pin next to **Page Translator**, so the "T" icon stays visible.
6. Optional: to use it on local `file:///` pages, open the extension's **Details** and turn on
   **Allow access to file URLs**. The test page below uses a local server, so it doesn't need this.

## Updating after code changes

| What you changed | What to do |
|---|---|
| `manifest.json`, `background.js`, content scripts | Click the reload icon on the extension's card in `chrome://extensions`, then **refresh open tabs**. Old content scripts stay in already-open tabs, and they stop working after a reload. |
| Popup files only | Just close and reopen the popup. |

If a tab says "Extension was reloaded. Refresh this page.", refresh it.

To debug:
- **Service worker:** in `chrome://extensions`, click **service worker** on the card.
- **Content scripts:** open the page's DevTools, go to Console, and use the context dropdown to pick "Page Translator (personal)".
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
- **"Show original"** writes back the original from a WeakMap, but only where the
  page hasn't since replaced our text.

### What I found: where the built-in AI APIs actually work

| Context | `Translator` / `LanguageDetector` |
|---|---|
| Popup (extension page) | Yes. It runs on a real user gesture, so this is where model downloads start. |
| Content script, top frame / same-origin iframe | Yes. The APIs are on `Window`, and the isolated world sees the frame's window. |
| Content script, cross-origin iframe | Blocked by the `translator` Permissions Policy (default `self`) unless the embedder set `allow="translator"`. `availability()` then returns `"unavailable"`. The extension detects this through `document.featurePolicy` and uses Google. |
| Service worker | **No.** The APIs are Window-only and not available in workers. |

A model in the `"downloadable"` state needs a **user gesture** for `create()`. A message
from the popup is not a gesture inside the page. So:

- **Auto mode on a new language:** it uses Google right away. The popup then says the Chrome
  model can be downloaded.
- **Clicking "Translate this page":** the popup calls `Translator.create()` inside the click
  handler and shows download progress. Models are shared across the browser, so the page
  uses it from then on. Keep the popup open until the download finishes.
- **Selection "Translate" button:** this is a real click in the page, so it can also start a download.

The popup's **Diagnostics** section shows what your Chrome actually exposes in each frame.
These results come from Chrome's documentation and MDN; I couldn't run Chrome while building this.
If your Chrome behaves differently, Diagnostics will show it, and Auto mode falls back to Google anyway.

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves your settings and the translation cache (`chrome.storage.local`, capped at about 2M characters, oldest entries evicted first). |
| `activeTab` | Temporary access to the current tab when you click the toolbar icon. Mostly covered by `<all_urls>`, but kept so the popup works even if you later restrict site access in Chrome's settings. |
| `scripting` | Lets the popup read each frame's status (`executeScript` returns one result per frame) and inject the content scripts into tabs opened before the extension was installed or reloaded. |
| `host_permissions: <all_urls>` | Runs the content scripts automatically in every page and every iframe, which Auto-translate needs. |
| `host_permissions: https://translate.googleapis.com/*` | Lets the service worker call the Google fallback without CORS problems. Already covered by `<all_urls>`, but listed explicitly so the intent is clear. |

**Privacy:** with the Chrome engine, text never leaves your machine. With Google (the fallback,
or "Google only"), page text is sent to `translate.googleapis.com`.

---

## Testing with the local test page

```powershell
cd C:\Work\Projects\page-translator
node test\serve.js
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
- [ ] Click **Logga in** (translated "Log in"): the line below shows the posted value is the **original "Logga in"**, which matters for ASP.NET.
- [ ] Hover a translated paragraph: a small tooltip shows the Swedish original.
- [ ] **Show original:** everything (text, attributes, tab title, frames) returns exactly to Swedish.
- [ ] Select some Swedish text, with the page translated or not: a **Translate** button appears. Click it to see the English in a bubble. Esc or a click outside closes it.
- [ ] Turn on **Auto-translate** and reload: the page translates by itself. An English site (e.g. wikipedia.org) is left alone.
- [ ] Switch the engine to **Google only**, Show original, then Translate: the engine shows Google.

### Manual checklist for https://tendsign.com/supplier/start.aspx

1. Open the page and open the popup. The language should be **Swedish**. Check Diagnostics to see how many frames there are and whether `Translator` is "present" in each.
2. Click **Translate this page**. Allow the one-time model download if offered. The menu, body text and footer become English.
3. Check the login form: field placeholders, labels and the login button text are English.
4. **Log in or press another button** (the ASP.NET postback). The site should behave normally, which shows the original button value was posted. New content after the postback is translated automatically.
5. Use any dropdowns or tabs that load content via AJAX (UpdatePanels). The new content turns English shortly after it appears.
6. Hover a translated label to see the original Swedish. Select Swedish text to test the selection bubble.
7. Click **Show original**. The page is exactly as before, and the site still works.
8. Turn on Auto-translate, open the page in a new tab, and confirm it translates on load.

---

## Known limitations

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
- **The Google endpoint is unofficial and rate-limited.** Requests are serialised with a 150 ms
  gap and back off on HTTP 429. Very large pages in Google mode take a few seconds.
- **Language detection on very short frames** (a few words) may be undecided. Auto mode then waits
  for more content. Manual translate still works through Google auto-detection.
- **Submit-button labels** are swapped back to the original for the instant of a click, so
  servers that read the button value (ASP.NET) keep working. Scripts that read `input.value`
  at some other time will see the English label.
- **Not yet downloaded Chrome models:** in Auto mode the first visit to a new language uses Google
  until you trigger the model download from the popup.

// Popup. It is a normal extension page (a Window), so:
//  - it can call Translator.create() inside the click handler (a real user gesture),
//    which is how Chrome models get downloaded; the page can then use the model;
//  - it talks to every frame of the tab through chrome.scripting / chrome.tabs.
const $ = (id) => document.getElementById(id);
let tab = null;
let settings = { ...PT_DEFAULTS };
let frames = [];
let downloading = false;

const langName = (code) => {
  if (!code || code === 'und') return 'Unknown';
  try { return `${new Intl.DisplayNames(['en'], { type: 'language' }).of(code)} (${code})`; } catch { return code; }
};
const ENGINE_NAMES = { chrome: 'Chrome built-in', google: 'Google (free endpoint)' };

function showMessage(text, isError = false) {
  const m = $('message');
  m.textContent = text;
  m.className = 'message' + (isError ? ' error' : '');
  m.hidden = !text;
}

// Tabs opened before the extension was installed/reloaded have no content script.
// Inject into any frame that lacks it (the scripts guard against double-injection).
async function ensureInjected() {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => !!(globalThis.PT && globalThis.PT.started)
  });
  const missing = results.filter((r) => !r.result).map((r) => r.frameId);
  if (missing.length) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: missing },
      files: chrome.runtime.getManifest().content_scripts[0].js
    });
  }
}

// Ask every frame for its status. executeScript returns one result per frame;
// tabs.sendMessage would only return the first frame's answer.
async function refresh() {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: async () => (globalThis.PT && globalThis.PT.getStatus ? await globalThis.PT.getStatus() : null)
    });
    frames = results.filter((r) => r.result).map((r) => ({ frameId: r.frameId, ...r.result }));
  } catch {
    frames = [];
  }
  render();
}

// The language to offer a Chrome model for: first non-English frame, else the top frame.
function currentLang() {
  const nonEn = frames.find((f) => f.pageLang && f.pageLang !== 'en' && f.pageLang !== 'und');
  if (nonEn) return nonEn.pageLang;
  const top = frames.find((f) => f.isTop);
  return top ? top.pageLang : null;
}

function render() {
  $('lang').textContent = langName(currentLang());

  const engines = [...new Set(frames.flatMap((f) => f.engines))];
  $('engine').textContent = engines.length ? engines.map((e) => ENGINE_NAMES[e] || e).join(' + ') : '–';

  const total = frames.reduce((n, f) => n + f.translated, 0);
  const translatedFrames = frames.filter((f) => f.translated > 0).length;
  if (frames.some((f) => f.busy)) $('state').textContent = `Translating… (${total})`;
  else if (total) $('state').textContent = `Translated · ${total} items · ${translatedFrames} frame(s)`;
  else if (frames.some((f) => f.autoPending)) $('state').textContent = 'Waiting for content…';
  else $('state').textContent = 'Original';

  if (!downloading) {
    const err = frames.find((f) => f.error);
    const need = frames.find((f) => f.needsDownload);
    if (err) showMessage(err.error, true);
    else if (need && settings.engine !== 'google') {
      showMessage(`Chrome's ${langName(need.needsDownload)} model isn't downloaded yet. Click "Translate this page" to download it once. Google is used until then.`);
    } else showMessage('');
  }

  // Diagnostics: where the built-in APIs are actually usable.
  const diag = $('diag');
  diag.replaceChildren();
  const add = (text) => {
    const d = document.createElement('div');
    d.className = 'frame';
    d.textContent = text;
    diag.append(d);
  };
  add(`Popup: Translator ${'Translator' in self ? 'available' : 'missing'}, LanguageDetector ${'LanguageDetector' in self ? 'available' : 'missing'}`);
  for (const f of frames) {
    add(`${f.isTop ? 'Top frame' : 'Frame ' + f.frameId}: Translator ${f.translatorApi} · lang ${f.pageLang || '?'} · ${f.translated} translated\n${f.url}`);
  }
}

// Download the Chrome model if needed. Must run inside the click handler: create()
// needs a user gesture when the model is 'downloadable'.
async function prepareChromeModel(lang) {
  if (!('Translator' in self)) return;
  try {
    const avail = await Translator.availability({ sourceLanguage: lang, targetLanguage: 'en' });
    if (avail === 'available' || avail === 'unavailable') return;
    downloading = true;
    $('download').hidden = false;
    $('dlLabel').textContent = `Downloading ${langName(lang)} → English model…`;
    const t = await Translator.create({
      sourceLanguage: lang,
      targetLanguage: 'en',
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          $('dlProgress').value = e.loaded;
          $('dlLabel').textContent = `Downloading ${langName(lang)} → English model… ${Math.round(e.loaded * 100)}%`;
        });
      }
    });
    if (t && t.destroy) t.destroy();
  } catch (e) {
    showMessage(`Chrome model download failed (${e.message}). Using Google instead.`, true);
  } finally {
    downloading = false;
    $('download').hidden = true;
  }
}

async function send(type) {
  // Broadcast to every frame in the tab.
  try { await chrome.tabs.sendMessage(tab.id, { type }); } catch { /* no receiver */ }
  setTimeout(refresh, 200);
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await ptLoadSettings();

  // Bind each control to its setting: [element id, setting key, element property].
  for (const [id, key, prop] of [
    ['auto', 'autoTranslate', 'checked'],
    ['engineSel', 'engine', 'value'],
    ['ignore', 'ignoreNoTranslate', 'checked']
  ]) {
    const input = $(id);
    input[prop] = settings[key];
    input.onchange = () => chrome.storage.local.set({ [key]: (settings[key] = input[prop]) });
  }

  $('translate').onclick = async () => {
    const lang = currentLang();
    if (settings.engine !== 'google' && lang && lang !== 'en' && lang !== 'und') await prepareChromeModel(lang);
    send('translate');
  };
  $('restore').onclick = () => send('restore');
  $('clearCache').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'cacheClear' });
    $('clearCache').textContent = 'Cache cleared';
  };

  try {
    await ensureInjected();
  } catch (e) {
    // chrome://, the Web Store, the PDF viewer, etc. cannot be scripted.
    showMessage(`This page can't be translated by extensions (${e.message}).`, true);
    $('translate').disabled = $('restore').disabled = true;
    return;
  }
  await refresh();
  setInterval(refresh, 1000);

  const stats = await chrome.runtime.sendMessage({ type: 'cacheStats' }).catch(() => null);
  if (stats && stats.entries != null) $('clearCache').textContent = `Clear translation cache (${stats.entries} entries)`;
}

init();

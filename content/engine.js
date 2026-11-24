// Translation engine for content scripts: language detection, Chrome's built-in
// Translator API (runs right here, in this frame), and the Google fallback via the
// service worker. Each file is wrapped in an IIFE and guarded, so injecting the
// scripts a second time (from the popup) doesn't reset any state.
(() => {
  const PT = (globalThis.PT = globalThis.PT || {});
  if (PT.engine) return;

  let settings = { ...PT_DEFAULTS };
  let contextDead = false;
  const status = {
    engines: new Set(),   // engines used in this frame
    lastEngine: null,
    needsDownload: null   // language whose Chrome model must be downloaded (needs a gesture)
  };

  // ------------------------------------------------------------ helpers
  // Message the service worker. After the extension is reloaded, old content scripts
  // lose their connection ("Extension context invalidated"); we then shut down quietly.
  async function bg(msg) {
    if (contextDead) throw new Error('Extension was reloaded. Refresh this page.');
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (res && res.error) throw new Error(res.error);
      return res;
    } catch (e) {
      if (/context invalidated/i.test(String(e && e.message))) {
        contextDead = true;
        if (PT.onContextDead) PT.onContextDead();
      }
      throw e;
    }
  }

  // Make CLD (chrome.i18n) codes match the BCP 47 tags the Translator API expects.
  function normLang(code) {
    if (!code) return 'und';
    const c = code.toLowerCase();
    if (c === 'zh-tw' || c === 'zh-hant') return 'zh-Hant';
    if (c.startsWith('zh')) return 'zh';
    if (c === 'iw') return 'he';
    if (c === 'jw') return 'jv';
    return c.split('-')[0];
  }

  // Is the Translator API usable in *this* frame? It exists on Window (so in content
  // scripts too), but the "translator" Permissions Policy blocks it in cross-origin
  // iframes unless the page set allow="translator".
  function translatorApiState() {
    if (!('Translator' in self)) return 'missing';
    try {
      const fp = document.featurePolicy;
      if (fp && fp.features().includes('translator') && !fp.allowsFeature('translator')) return 'blocked';
    } catch { /* featurePolicy not available; assume allowed */ }
    return 'present';
  }

  // ------------------------------------------------------------ language detection
  let detectorPromise = null;
  function getDetector() {
    if (!detectorPromise) {
      detectorPromise = (async () => {
        if (!('LanguageDetector' in self)) return null;
        try {
          // Only use it if it's ready; we never trigger a download for detection.
          if ((await LanguageDetector.availability()) !== 'available') return null;
          return await LanguageDetector.create();
        } catch {
          return null;
        }
      })();
    }
    return detectorPromise;
  }

  // Returns { lang, reliable }. Uses the built-in LanguageDetector if ready, else
  // chrome.i18n.detectLanguage (CLD3, always available, no download).
  async function detect(text) {
    const det = await getDetector();
    if (det) {
      try {
        const [top] = await det.detect(text);
        if (top && top.detectedLanguage !== 'und') {
          return { lang: normLang(top.detectedLanguage), reliable: top.confidence >= 0.7 };
        }
      } catch { /* fall through to CLD */ }
    }
    try {
      const r = await chrome.i18n.detectLanguage(text);
      const top = r.languages && r.languages[0];
      return { lang: top ? normLang(top.language) : 'und', reliable: !!(r.isReliable && top) };
    } catch {
      return { lang: 'und', reliable: false };
    }
  }

  // Language of one segment. Short strings ("OK", "Logga in") can't be detected
  // reliably, so they inherit the page language.
  async function segmentLang(text, pageLang) {
    if (text.length >= 20) {
      const d = await detect(text);
      if (d.reliable && d.lang !== 'und') return d.lang;
    }
    return pageLang || 'und';
  }

  // ------------------------------------------------------------ Chrome Translator
  const translators = new Map(); // source lang -> Promise<Translator>

  // Returns a ready translator or null. Without a user gesture we only use models that
  // are already downloaded ('available'); otherwise we remember that a download is
  // needed so the popup can offer it.
  async function getChromeTranslator(src, allowDownload) {
    if (translatorApiState() !== 'present' || src === 'und' || src === 'en') return null;
    if (translators.has(src)) return translators.get(src);
    let avail;
    try {
      avail = await Translator.availability({ sourceLanguage: src, targetLanguage: 'en' });
    } catch {
      return null;
    }
    if (avail === 'unavailable') return null;
    if (avail !== 'available' && !allowDownload) {
      status.needsDownload = src;
      return null;
    }
    const p = Translator.create({ sourceLanguage: src, targetLanguage: 'en' }).catch(() => null);
    translators.set(src, p);
    const t = await p;
    if (t) {
      if (status.needsDownload === src) status.needsDownload = null;
    } else {
      translators.delete(src); // allow a retry later (e.g. after the popup downloads it)
      if (avail !== 'available') status.needsDownload = src;
    }
    return t;
  }

  function chromeUnavailableReason(src) {
    const api = translatorApiState();
    if (api === 'missing') return 'Chrome built-in Translator API is not available in this browser.';
    if (api === 'blocked') return 'Chrome built-in translator is blocked in this (cross-origin) frame.';
    if (src === 'und') return 'Could not detect the source language for the Chrome translator.';
    if (status.needsDownload === src) return `Chrome's ${src}→en model needs a download. Click "Translate this page" in the popup.`;
    return `Chrome built-in translator does not support ${src}→en.`;
  }

  // ------------------------------------------------------------ translate
  function setStatusEngine(name) {
    status.engines.add(name);
    status.lastEngine = name;
  }

  async function translateWithEngine(texts, src, gesture) {
    const mode = settings.engine;
    if (mode !== 'google') {
      const tr = await getChromeTranslator(src, gesture || mode === 'chrome');
      if (tr) {
        try {
          const translations = await Promise.all(texts.map((t) => tr.translate(t)));
          setStatusEngine('chrome');
          bg({ type: 'cachePut', engine: 'chrome', entries: texts.map((t, i) => [t, translations[i]]) }).catch(() => {});
          return { engine: 'chrome', translations };
        } catch (e) {
          if (mode === 'chrome') throw e;
          // auto: fall through to Google
        }
      } else if (mode === 'chrome') {
        throw new Error(chromeUnavailableReason(src));
      }
    }
    const { translations } = await bg({ type: 'google', texts });
    setStatusEngine('google');
    return { engine: 'google', translations };
  }

  // In-memory cache for this frame: memKey(engine, text) -> translation.
  const mem = new Map();
  const memKey = (engine, text) => engine + '\u0001' + text;
  const engineOrder = () =>
    settings.engine === 'google' ? ['google'] : settings.engine === 'chrome' ? ['chrome'] : ['chrome', 'google'];

  // Translate many unique texts. Returns an array aligned with `texts`; an entry is
  // null when the text was skipped (already English).
  async function translateMany(texts, pageLang, { gesture = false } = {}) {
    const out = new Array(texts.length).fill(null);
    const order = engineOrder();

    // 1. memory cache
    let todo = [];
    texts.forEach((t, i) => {
      for (const e of order) {
        const v = mem.get(memKey(e, t));
        if (v !== undefined) { out[i] = v; return; }
      }
      todo.push(i);
    });

    // 2. persistent cache in the service worker
    if (todo.length) {
      const { hits } = await bg({ type: 'cacheGet', texts: todo.map((i) => texts[i]), engines: order });
      todo = todo.filter((i) => {
        const h = hits[texts[i]];
        if (h === undefined) return true;
        out[i] = h;
        return false;
      });
    }

    // 3. group by source language, skipping English segments
    const groups = new Map();
    for (const i of todo) {
      const src = await segmentLang(texts[i], pageLang);
      if (src === 'en') continue;
      if (!groups.has(src)) groups.set(src, []);
      groups.get(src).push(i);
    }

    // 4. translate each group
    if (mem.size > 10000) mem.clear();
    for (const [src, idx] of groups) {
      const res = await translateWithEngine(idx.map((i) => texts[i]), src, gesture);
      idx.forEach((i, k) => {
        out[i] = res.translations[k];
        mem.set(memKey(res.engine, texts[i]), res.translations[k]);
      });
    }
    return out;
  }

  PT.engine = {
    status,
    setSettings: (s) => { settings = s; },
    detect,
    translatorApiState,
    translateMany
  };
})();

// Orchestration for one frame: auto-translate on load, manual translate/restore from
// the popup, the MutationObserver for late content, and status for the popup.
(() => {
  const PT = (globalThis.PT = globalThis.PT || {});
  if (PT.started) return; // already running in this frame (popup may inject again)
  PT.started = true;
  const { engine, dom, ui } = PT;

  const state = {
    settings: { ...PT_DEFAULTS },
    active: false,        // page is (being) translated; new content gets translated too
    busy: 0,              // running translation passes
    gen: 0,               // bumped by "Show original" to cancel running passes
    pageLang: null,       // detected from visible text, never from <html lang>
    error: null,
    autoPending: false,   // auto mode, but not enough text yet to decide the language
    userRestored: false,  // user clicked "Show original": don't auto-translate again
    checking: false
  };

  // ------------------------------------------------------------ observing
  const observedRoots = new WeakSet();
  const observer = new MutationObserver(onMutations);

  // A document observer doesn't see inside shadow roots, so each one is observed too.
  function observe(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: dom.WATCHED_ATTRS
    });
  }

  function collectAll(roots) {
    const out = [], seen = new Set();
    const opts = { ignoreMarkers: state.settings.ignoreNoTranslate, onShadowRoot: observe };
    for (const r of roots) dom.collect(r, out, seen, opts);
    return out;
  }

  const dirty = new Set();
  let flushTimer = null, firstDirtyAt = 0;

  function onMutations(records) {
    if (!state.active && !state.autoPending) return;
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) if (n !== ui.host()) dirty.add(n);
      } else if (r.type === 'characterData') {
        if (!dom.isOwnText(r.target)) dirty.add(r.target);        // ignore our own writes
      } else if (!dom.isOwnAttr(r.target, r.attributeName)) {
        dirty.add(r.target);
      }
    }
    if (dirty.size) scheduleFlush();
  }

  // Debounce 400 ms, but never wait more than 2 s while the page keeps changing.
  function scheduleFlush() {
    const now = Date.now();
    if (!firstDirtyAt) firstDirtyAt = now;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, Math.min(400, Math.max(0, firstDirtyAt + 2000 - now)));
  }

  function flush() {
    firstDirtyAt = 0;
    const ignore = state.settings.ignoreNoTranslate;
    const roots = [...dirty].filter((n) => n.isConnected && !dom.isExcluded(n, ignore));
    dirty.clear();
    if (state.autoPending) return autoCheck();
    if (!state.active || !roots.length) return;
    const segs = collectAll(roots);
    if (segs.length) translateSegments(segs);
  }

  // ------------------------------------------------------------ translating
  async function detectPageLang(segs) {
    // Sample visible text first (the content the user actually sees).
    const texts = segs.filter((s) => s.kind === 'text' && s.core.length > 3);
    const visible = texts.filter((s) => dom.isInViewport(s));
    let sample = '';
    for (const s of [...visible, ...texts]) {
      if (sample.length > 3000) break;
      sample += s.core + '\n';
    }
    if (sample.length < 30) return { lang: 'und', sampleLen: sample.length };
    const d = await engine.detect(sample);
    return { lang: d.lang, sampleLen: sample.length };
  }

  // Group identical texts, visible ones first, and translate batch by batch,
  // yielding between batches so the page stays responsive.
  async function translateSegments(segs) {
    const gen = state.gen;
    const groups = new Map();
    for (const s of segs) {
      let g = groups.get(s.core);
      if (!g) groups.set(s.core, (g = { text: s.core, segs: [] }));
      g.segs.push(s);
    }
    const items = [...groups.values()];
    for (const it of items) it.visible = it.segs.some(dom.isInViewport);
    items.sort((a, b) => b.visible - a.visible);

    state.busy++;
    try {
      for (const batch of makeBatches(items)) {
        if (gen !== state.gen || !state.active) return;
        const translations = await engine.translateMany(batch.map((i) => i.text), state.pageLang);
        if (gen !== state.gen || !state.active) return; // user clicked "Show original"
        batch.forEach((it, k) => { for (const s of it.segs) dom.apply(s, translations[k]); });
        await new Promise((r) => setTimeout(r, 0));
      }
      dom.prune();
    } catch (e) {
      state.error = String(e && e.message || e);
    } finally {
      state.busy--;
    }
  }

  function makeBatches(items, maxItems = 40, maxChars = 3500) {
    const batches = [];
    let cur = [], chars = 0;
    for (const it of items) {
      if (cur.length && (cur.length >= maxItems || chars + it.text.length > maxChars)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(it);
      chars += it.text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  async function translatePage() {
    if (document.designMode === 'on') return; // rich-text editor frames
    if (!state.settings.ignoreNoTranslate && dom.pageOptOut()) {
      state.error = 'This page is marked "do not translate". Turn on "Ignore do-not-translate markers" to translate it anyway.';
      return;
    }
    state.active = true;
    state.autoPending = false;
    state.error = null;
    observe(document);
    const segs = collectAll([document]);
    if (!state.pageLang || state.pageLang === 'und') state.pageLang = (await detectPageLang(segs)).lang;
    await translateSegments(segs);
  }

  // Auto mode: translate only if the page's visible text is not English.
  async function autoCheck() {
    const s = state.settings;
    if (!s.autoTranslate || state.active || state.userRestored || state.checking) return;
    if (document.designMode === 'on') return;
    if (!s.ignoreNoTranslate && dom.pageOptOut()) return;
    state.checking = true;
    try {
      observe(document);
      const { lang, sampleLen } = await detectPageLang(collectAll([document]));
      if (lang === 'und') {
        // Not enough text yet (SPA still rendering, empty frame): retry on mutations.
        state.autoPending = sampleLen < 3000;
        return;
      }
      state.autoPending = false;
      state.pageLang = lang;
      if (lang !== 'en') await translatePage();
    } finally {
      state.checking = false;
    }
  }

  function showOriginal() {
    state.active = false;
    state.autoPending = false;
    state.userRestored = true;
    state.gen++;
    dirty.clear();
    clearTimeout(flushTimer);
    dom.restoreAll();
    observer.takeRecords(); // drop the mutation records our restore just produced
    ui.hideTip();
  }

  // Used by the selection bubble.
  async function translateText(text) {
    const d = await engine.detect(text);
    if (d.reliable && d.lang === 'en') return { translation: null, lang: 'en' };
    const fallback = state.pageLang && state.pageLang !== 'en' ? state.pageLang : 'und';
    const src = d.lang !== 'und' && d.lang !== 'en' ? d.lang : fallback;
    const [translation] = await engine.translateMany([text], src, { gesture: true });
    return { translation, lang: src, engine: engine.status.lastEngine };
  }

  // ------------------------------------------------------------ ASP.NET-safe buttons
  // Some servers (e.g. ASP.NET WebForms) read a submit button's value on postback.
  // Right before the click is processed, put the original value back; restore the
  // translated label just after the form data has been built.
  addEventListener('click', (e) => {
    const el = e.composedPath()[0];
    if (!el || el.tagName !== 'INPUT') return;
    const orig = dom.originalAttr(el, 'value');
    if (orig == null) return;
    const translated = el.getAttribute('value');
    el.setAttribute('value', orig);
    setTimeout(() => {
      if (state.active && el.getAttribute('value') === orig) el.setAttribute('value', translated);
    }, 0);
  }, true);

  // ------------------------------------------------------------ status / messages
  PT.getStatus = async () => {
    if (state.pageLang == null && !state.checking) {
      state.pageLang = (await detectPageLang(collectAll([document]))).lang;
    }
    return {
      url: location.href,
      isTop: window === top,
      pageLang: state.pageLang,
      active: state.active,
      busy: state.busy > 0,
      translated: dom.count(),
      engines: [...engine.status.engines],
      error: state.error,
      translatorApi: engine.translatorApiState(),
      needsDownload: engine.status.needsDownload,
      autoPending: state.autoPending
    };
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'translate') {
      state.userRestored = false;
      translatePage();
    } else if (msg.type === 'restore') {
      showOriginal();
    }
    sendResponse({ ok: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k of Object.keys(PT_DEFAULTS)) {
      if (changes[k]) state.settings[k] = changes[k].newValue;
    }
    engine.setSettings(state.settings);
    if (changes.autoTranslate && changes.autoTranslate.newValue) autoCheck();
  });

  // The extension was reloaded: this copy is orphaned, so stop doing work.
  PT.onContextDead = () => {
    observer.disconnect();
    state.active = false;
    state.autoPending = false;
    PT.started = false;
  };

  // ------------------------------------------------------------ start
  ui.init({ hasTranslations: () => state.active && dom.count() > 0, translateText });
  ptLoadSettings().then((s) => {
    state.settings = s;
    engine.setSettings(s);
    if (s.autoTranslate) autoCheck();
  }).catch(() => {});
})();

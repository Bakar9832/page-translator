// In-page UI: hover tooltip with the original text, and the selection
// "Translate" button + result bubble. Everything lives in a *closed* shadow root on a
// custom element, so page CSS can't style it and our CSS can't leak into the page.
// Built with createElement (no innerHTML) so Trusted-Types pages don't block it.
(() => {
  const PT = (globalThis.PT = globalThis.PT || {});
  if (PT.ui) return;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    [hidden] { display: none !important; }
    .tip, .bubble, .sel {
      position: fixed; z-index: 2147483647; color: #1f2328; background: #fff;
      border: 1px solid #d0d7de; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
    }
    .tip { max-width: 380px; padding: 6px 10px; pointer-events: none; white-space: pre-wrap; }
    .tip .label, .bubble .meta { display: block; font-size: 11px; color: #656d76; margin-bottom: 2px; }
    .sel { padding: 4px 10px; cursor: pointer; font-weight: 600; color: #fff; background: #2563eb; border-color: #1d4ed8; }
    .sel:hover { background: #1d4ed8; }
    .bubble { width: 360px; max-width: calc(100vw - 16px); padding: 10px 12px; }
    .bubble .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .bubble .close { all: unset; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 4px; color: #656d76; }
    .bubble .close:hover { background: #eaeef2; }
    .bubble .body { margin-top: 4px; max-height: 260px; overflow: auto; white-space: pre-wrap; }
    .bubble .error { color: #cf222e; }
    @media (prefers-color-scheme: dark) {
      .tip, .bubble { color: #e6edf3; background: #1c2128; border-color: #444c56; }
      .tip .label, .bubble .meta, .bubble .close { color: #9198a1; }
      .bubble .close:hover { background: #2d333b; }
      .bubble .error { color: #ff7b72; }
    }`;

  let host = null, tip, selBtn, bubble, bubbleMeta, bubbleBody;
  let hooks = { hasTranslations: () => false, translateText: async () => ({}) };
  let hoverTimer = null, selText = '', selRect = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('page-translator-ui');
    // Inline !important beats page stylesheets like `* { display:none }`.
    host.setAttribute('style', 'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;display:block!important;');
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS); // constructed sheets aren't blocked by the page's style CSP
    root.adoptedStyleSheets = [sheet];

    tip = el('div', 'tip');
    tip.hidden = true;

    selBtn = el('button', 'sel', 'Translate');
    selBtn.hidden = true;
    selBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    selBtn.addEventListener('click', onSelButtonClick);

    bubble = el('div', 'bubble');
    bubble.hidden = true;
    const head = el('div', 'head');
    bubbleMeta = el('span', 'meta');
    const close = el('button', 'close', '×');
    close.title = 'Close (Esc)';
    close.addEventListener('click', hideBubble);
    head.append(bubbleMeta, close);
    bubbleBody = el('div', 'body');
    bubble.append(head, bubbleBody);

    root.append(tip, selBtn, bubble);
    (document.documentElement || document.body).appendChild(host);
    PT.dom.setUiHost(host);
  }

  // Place a fixed element near (x, y) but keep it inside the viewport.
  function place(node, x, y) {
    node.hidden = false;
    const w = node.offsetWidth, h = node.offsetHeight;
    node.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    node.style.top = (y + h > innerHeight - 8 ? Math.max(8, y - h - 28) : y) + 'px';
  }

  const isOurs = (e) => !!host && e.composedPath().includes(host);

  // ------------------------------------------------------------ hover tooltip
  function onMouseOver(e) {
    clearTimeout(hoverTimer);
    if (!hooks.hasTranslations() || isOurs(e)) return;
    const target = e.composedPath()[0]; // real target, even inside open shadow roots
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
    const { clientX: x, clientY: y } = e;
    hoverTimer = setTimeout(() => {
      const original = PT.dom.originalFor(target);
      if (!original) return hideTip();
      ensureHost();
      tip.replaceChildren(el('span', 'label', 'Original'), document.createTextNode(original));
      place(tip, x + 12, y + 18);
    }, 450);
  }

  function hideTip() {
    clearTimeout(hoverTimer);
    if (tip) tip.hidden = true;
  }

  // ------------------------------------------------------------ selection translate
  function onMouseUp(e) {
    if (isOurs(e)) return;
    setTimeout(checkSelection, 10); // let the selection settle first
  }

  function checkSelection() {
    const sel = getSelection();
    const text = sel && sel.rangeCount && !sel.isCollapsed ? sel.toString().trim() : '';
    if (!text || text.length > 5000 || !/\p{L}/u.test(text)) return hideSelButton();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) return hideSelButton();
    selText = text;
    selRect = rect;
    ensureHost();
    place(selBtn, rect.right - 40, rect.bottom + 6);
  }

  function hideSelButton() {
    if (selBtn) selBtn.hidden = true;
  }

  async function onSelButtonClick() {
    // This click is a real user gesture in the page, so the engine may start a
    // Chrome model download here if needed.
    hideSelButton();
    const text = selText;
    bubbleMeta.textContent = 'Translating…';
    bubbleBody.className = 'body';
    bubbleBody.textContent = '';
    place(bubble, selRect.left, selRect.bottom + 8);
    try {
      const r = await hooks.translateText(text);
      const lang = r.lang && r.lang !== 'und' ? langName(r.lang) : 'auto-detected';
      if (r.translation == null) {
        bubbleMeta.textContent = 'Already English';
        bubbleBody.textContent = text;
      } else {
        bubbleMeta.textContent = `${lang} → English · ${r.engine === 'chrome' ? 'Chrome built-in' : 'Google'}`;
        bubbleBody.textContent = r.translation;
      }
    } catch (err) {
      bubbleMeta.textContent = 'Translation failed';
      bubbleBody.className = 'body error';
      bubbleBody.textContent = String(err && err.message || err);
    }
    place(bubble, selRect.left, selRect.bottom + 8); // re-place now that size is known
  }

  function hideBubble() {
    if (bubble) bubble.hidden = true;
  }

  function langName(code) {
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code); } catch { return code; }
  }

  function init(h) {
    hooks = h;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', (e) => { if (!isOurs(e)) hideTip(); }, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') onMouseUp(e); }, true);
    document.addEventListener('mousedown', (e) => {
      if (isOurs(e)) return;
      hideTip();
      hideSelButton();
      hideBubble(); // click outside closes the bubble
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hideBubble(); hideSelButton(); hideTip(); }
    }, true);
    addEventListener('scroll', () => { hideTip(); hideSelButton(); }, true);
  }

  PT.ui = { init, hideTip, host: () => host };
})();

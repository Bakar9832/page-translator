// DOM layer: find translatable text (text nodes + selected attributes), write
// translations, and restore originals exactly. Knows nothing about engines.
(() => {
  const PT = (globalThis.PT = globalThis.PT || {});
  if (PT.dom) return;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'TEMPLATE',
    'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED'
  ]);
  const TEXT_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset']);
  const WATCHED_ATTRS = [...TEXT_ATTRS, 'value', 'label'];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Originals and what we wrote. WeakMaps don't keep removed nodes alive; the Sets
  // exist only so "Show original" can iterate, and are cleared on restore/prune.
  const origText = new WeakMap();    // Text -> original data
  const writtenText = new WeakMap(); // Text -> data we wrote
  const textNodes = new Set();
  const origAttr = new WeakMap();    // Element -> { attrName: original }
  const writtenAttr = new WeakMap(); // Element -> { attrName: written }
  const attrEls = new Set();

  let uiHost = null; // our own tooltip host; never translate or observe it

  const hasMarker = (el) => el.getAttribute('translate') === 'no' || el.classList.contains('notranslate');

  function rejectElement(el, ignoreMarkers) {
    if (el === uiHost) return true;
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
    if (el.namespaceURI === SVG_NS) return true;
    if (el.isContentEditable) return true;
    if (!ignoreMarkers && hasMarker(el)) return true;
    return false;
  }

  // Split "  Hej  då \n" into leading ws, core text, trailing ws. We translate only the
  // core (with inner whitespace collapsed, as HTML renders it) and keep the outer
  // whitespace so the layout doesn't shift.
  function splitWs(full) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(full);
    return { lead: m[1], core: m[2].replace(/\s+/g, ' '), trail: m[3] };
  }

  // Must contain at least one letter: skips whitespace, numbers, prices, "—", "»" etc.
  const worthTranslating = (core) => core.length >= 2 && /\p{L}/u.test(core);

  function addText(node, out, seen) {
    if (seen.has(node)) return;
    seen.add(node);
    const full = node.data;
    if (writtenText.get(node) === full) return; // already translated by us
    const { lead, core, trail } = splitWs(full);
    if (worthTranslating(core)) out.push({ kind: 'text', node, full, lead, core, trail });
  }

  function addAttrs(el, out, seen) {
    if (seen.has(el)) return;
    seen.add(el);
    const names = TEXT_ATTRS.slice();
    const tag = el.tagName.toUpperCase();
    // Only button-like inputs: never touch the value of fields the user types into.
    if (tag === 'INPUT' && BUTTON_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase())) names.push('value');
    if (tag === 'OPTION' || tag === 'OPTGROUP') names.push('label');
    const written = writtenAttr.get(el);
    for (const name of names) {
      const full = el.getAttribute(name);
      if (full == null || (written && written[name] === full)) continue;
      const { lead, core, trail } = splitWs(full);
      if (worthTranslating(core)) out.push({ kind: 'attr', el, name, full, lead, core, trail });
    }
  }

  // Visit one element: collect its attributes and enter its open shadow root.
  // Returns false if the element (and so its subtree) is skipped.
  function visitElement(el, out, seen, opts) {
    if (rejectElement(el, opts.ignoreMarkers)) {
      if (el.tagName === 'TEXTAREA') addAttrs(el, out, seen); // its placeholder is fine
      return false;
    }
    addAttrs(el, out, seen);
    if (el.shadowRoot) enterShadow(el.shadowRoot, out, seen, opts); // open shadow roots only
    return true;
  }

  // Collect segments under `root` (Document, ShadowRoot, Element or Text).
  // opts: { ignoreMarkers, onShadowRoot(root) } — onShadowRoot lets main.js observe it.
  function collect(root, out, seen, opts) {
    if (root.nodeType === Node.TEXT_NODE) return addText(root, out, seen);
    if (root.nodeType === Node.ELEMENT_NODE && !visitElement(root, out, seen, opts)) return;
    const doc = root.ownerDocument || root;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) addText(n, out, seen);
        else if (!visitElement(n, out, seen, opts)) return NodeFilter.FILTER_REJECT; // skip subtree
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()); // all work happens in acceptNode
  }

  function enterShadow(sr, out, seen, opts) {
    if (opts.onShadowRoot) opts.onShadowRoot(sr);
    collect(sr, out, seen, opts);
  }

  // True if any ancestor (crossing shadow boundaries) is skipped. Used for content
  // added later, which arrives without the walker's top-down filtering.
  function isExcluded(node, ignoreMarkers) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
    while (el) {
      if (el.nodeType === Node.DOCUMENT_FRAGMENT_NODE) { el = el.host || null; continue; }
      if (el.nodeType !== Node.ELEMENT_NODE) break;
      if (el !== node && rejectElement(el, ignoreMarkers)) return true;
      el = el.parentNode;
    }
    return false;
  }

  // Write one translation. Returns false if the page changed the text meanwhile.
  function apply(seg, translation) {
    if (!translation || translation === seg.core) return false;
    const value = seg.lead + translation + seg.trail;
    if (seg.kind === 'text') {
      const n = seg.node;
      if (!n.isConnected || n.data !== seg.full) return false;
      origText.set(n, seg.full);
      writtenText.set(n, value);
      textNodes.add(n);
      n.data = value;
    } else {
      const el = seg.el;
      if (el.getAttribute(seg.name) !== seg.full) return false;
      if (!origAttr.has(el)) { origAttr.set(el, {}); writtenAttr.set(el, {}); }
      origAttr.get(el)[seg.name] = seg.full;
      writtenAttr.get(el)[seg.name] = value;
      attrEls.add(el);
      el.setAttribute(seg.name, value);
    }
    return true;
  }

  // Restore everything we changed, but only where the page hasn't since replaced it.
  function restoreAll() {
    for (const n of textNodes) {
      if (writtenText.get(n) === n.data) n.data = origText.get(n);
      writtenText.delete(n);
      origText.delete(n);
    }
    textNodes.clear();
    for (const el of attrEls) {
      const w = writtenAttr.get(el) || {};
      const o = origAttr.get(el) || {};
      for (const name in w) if (el.getAttribute(name) === w[name]) el.setAttribute(name, o[name]);
      writtenAttr.delete(el);
      origAttr.delete(el);
    }
    attrEls.clear();
  }

  // Drop references to nodes the page removed (keeps the Sets from growing forever).
  function prune() {
    for (const n of textNodes) if (!n.isConnected) textNodes.delete(n);
    for (const el of attrEls) if (!el.isConnected) attrEls.delete(el);
  }

  // For MutationObserver: was this change made by us?
  const isOwnText = (n) => writtenText.get(n) === n.data;
  const isOwnAttr = (el, name) => {
    const w = writtenAttr.get(el);
    return !!w && w[name] === el.getAttribute(name);
  };

  // Original value of an attribute we translated (null if not translated by us).
  function originalAttr(el, name) {
    return isOwnAttr(el, name) ? origAttr.get(el)[name] : null;
  }

  // Original text for the hover tooltip: translated text inside `el` plus its own
  // translated attributes, capped so hovering a big container stays readable.
  function originalFor(el) {
    const parts = [];
    let len = 0;
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && len < 400; n = walker.nextNode()) {
      if (writtenText.get(n) === n.data) {
        const t = origText.get(n).trim();
        parts.push(t);
        len += t.length;
      }
    }
    const o = origAttr.get(el);
    if (o) for (const name in o) if (isOwnAttr(el, name)) parts.push(`[${name}] ${o[name].trim()}`);
    const text = parts.join(' ').replace(/\s+/g, ' ');
    return text.length > 400 ? text.slice(0, 400) + '…' : text;
  }

  // Page-level "do not translate" markers.
  function pageOptOut() {
    for (const meta of document.querySelectorAll('meta[name="google" i]')) {
      if (/notranslate/i.test(meta.getAttribute('content') || '')) return true;
    }
    return [document.documentElement, document.body].some((el) => el && hasMarker(el));
  }

  function isInViewport(seg) {
    let el = seg.kind === 'attr' ? seg.el : seg.node.parentElement || (seg.node.parentNode && seg.node.parentNode.host);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return (r.width > 0 || r.height > 0) && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  PT.dom = {
    WATCHED_ATTRS,
    setUiHost: (h) => { uiHost = h; },
    collect,
    isExcluded,
    apply,
    restoreAll,
    prune,
    isOwnText,
    isOwnAttr,
    originalAttr,
    originalFor,
    pageOptOut,
    isInViewport,
    count: () => textNodes.size + attrEls.size
  };
})();

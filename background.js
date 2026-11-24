// Service worker. Two jobs:
//  1. Call the free Google endpoint (only here, so the page's CSP can never block it).
//  2. Own the persistent translation cache (one writer, no races between frames/tabs).
// Note: the Translator API is NOT available in service workers (Window-only), so all
// built-in translation happens in content scripts / the popup.
importScripts('shared/settings.js');

chrome.runtime.onInstalled.addListener(async () => {
  // Write defaults for any missing keys, keep existing user choices.
  const current = await chrome.storage.local.get(Object.keys(PT_DEFAULTS));
  await chrome.storage.local.set({ ...PT_DEFAULTS, ...current });
});

// ---------------------------------------------------------------- cache
// Stored as an array of [key, value] pairs so insertion order (= LRU order) survives.
// Key = engine + '\u0001' + source text, so switching engines gives fresh results.
const CACHE_KEY = 'tcache';
const MAX_ENTRIES = 20000;
const MAX_CHARS = 2_000_000; // keeps us well under chrome.storage.local's 10 MB quota

let cache = null;            // Map, loaded lazily (the worker can be restarted any time)
let cacheChars = 0;
let cacheLoading = null;
let saveTimer = null;

function loadCache() {
  if (cache) return Promise.resolve();
  if (!cacheLoading) {
    cacheLoading = chrome.storage.local.get(CACHE_KEY).then((res) => {
      cache = new Map(res[CACHE_KEY] || []);
      cacheChars = 0;
      for (const [k, v] of cache) cacheChars += k.length + v.length;
    });
  }
  return cacheLoading;
}

const cacheKey = (engine, text) => engine + '\u0001' + text;

function cacheGet(engine, text) {
  const key = cacheKey(engine, text);
  const v = cache.get(key);
  if (v !== undefined) { cache.delete(key); cache.set(key, v); } // mark recently used
  return v;
}

function cacheSet(engine, text, translation) {
  const key = cacheKey(engine, text);
  const old = cache.get(key);
  if (old !== undefined) { cacheChars -= key.length + old.length; cache.delete(key); }
  cache.set(key, translation);
  cacheChars += key.length + translation.length;
  // Evict oldest entries (Map iterates in insertion order).
  while (cache.size > MAX_ENTRIES || cacheChars > MAX_CHARS) {
    const [k, v] = cache.entries().next().value;
    cache.delete(k);
    cacheChars -= k.length + v.length;
  }
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [CACHE_KEY]: [...cache] });
  }, 2000);
}

// ---------------------------------------------------------------- Google fallback
const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=';
const MAX_ENCODED_PER_REQUEST = 6000; // encoded q length; keeps the GET URL well under limits
const GAP_MS = 150;                   // minimum pause between requests

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// All Google requests (from every tab and frame) run one at a time through this chain.
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {}).then(() => sleep(GAP_MS));
  return p;
}

async function fetchWithRetry(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) throw new Error(`Google translate HTTP ${res.status}`);
    // Exponential backoff with jitter: ~1s, 2s, 4s, 8s.
    await sleep(1000 * 2 ** attempt + Math.random() * 300);
  }
}

// One request. Segments are joined with newlines, and Google keeps line breaks,
// so splitting the result on '\n' gives one translation per segment.
async function requestChunk(texts) {
  const q = texts.map((t) => t.replace(/\s*\n\s*/g, ' ')).join('\n');
  const data = await enqueue(() => fetchWithRetry(GOOGLE_URL + encodeURIComponent(q)));
  const joined = (data && data[0] ? data[0] : []).map((part) => part[0] || '').join('');
  const lines = joined.split('\n');
  if (lines.length === texts.length) return lines.map((l) => l.trim());
  if (texts.length === 1) return [joined.trim()];
  // Google merged or split lines: fall back to one request per segment.
  const out = [];
  for (const t of texts) out.push((await requestChunk([t]))[0]);
  return out;
}

// Split a very long text on sentence boundaries so one segment never overflows a request.
function splitLong(text) {
  if (encodeURIComponent(text).length <= MAX_ENCODED_PER_REQUEST) return [text];
  const pieces = [];
  let cur = '';
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    const next = cur ? cur + ' ' + sentence : sentence;
    if (cur && encodeURIComponent(next).length > MAX_ENCODED_PER_REQUEST) {
      pieces.push(cur);
      cur = sentence;
    } else {
      cur = next;
    }
  }
  if (cur) pieces.push(cur);
  // A single giant "sentence" is hard-cut by characters as a last resort.
  return pieces.flatMap((p) =>
    encodeURIComponent(p).length <= MAX_ENCODED_PER_REQUEST ? [p] : p.match(/[\s\S]{1,1500}/g)
  );
}

async function googleTranslate(texts) {
  await loadCache();
  const results = new Array(texts.length);
  const pending = []; // { index, pieces }
  texts.forEach((t, i) => {
    const hit = cacheGet('google', t);
    if (hit !== undefined) results[i] = hit;
    else pending.push({ index: i, pieces: splitLong(t) });
  });

  // Pack all pieces into requests by encoded size.
  const flat = pending.flatMap((p) => p.pieces);
  const translatedFlat = [];
  let batch = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    translatedFlat.push(...(await requestChunk(batch)));
    batch = [];
    size = 0;
  };
  for (const piece of flat) {
    const len = encodeURIComponent(piece).length + 3; // + encoded '\n'
    if (size + len > MAX_ENCODED_PER_REQUEST) await flush();
    batch.push(piece);
    size += len;
  }
  await flush();

  // Re-assemble pieces into whole segments.
  let k = 0;
  for (const p of pending) {
    const tr = translatedFlat.slice(k, k + p.pieces.length).join(' ');
    k += p.pieces.length;
    results[p.index] = tr;
    cacheSet('google', texts[p.index], tr);
  }
  return results;
}

// ---------------------------------------------------------------- messaging
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {
      case 'google':
        return { translations: await googleTranslate(msg.texts) };
      case 'cacheGet': {
        // Returns { text: translation } for texts found under any of msg.engines (in order).
        await loadCache();
        const hits = {};
        for (const t of msg.texts) {
          for (const engine of msg.engines) {
            const v = cacheGet(engine, t);
            if (v !== undefined) { hits[t] = v; break; }
          }
        }
        return { hits };
      }
      case 'cachePut':
        await loadCache();
        for (const [text, tr] of msg.entries) cacheSet(msg.engine, text, tr);
        return { ok: true };
      case 'cacheClear':
        await loadCache();
        cache.clear();
        cacheChars = 0;
        await chrome.storage.local.remove(CACHE_KEY);
        return { ok: true };
      case 'cacheStats':
        await loadCache();
        return { entries: cache.size, chars: cacheChars };
      default:
        return { error: 'unknown message ' + msg.type };
    }
  };
  handle().then(sendResponse, (err) => sendResponse({ error: String(err && err.message || err) }));
  return true; // keep the channel open for the async response
});

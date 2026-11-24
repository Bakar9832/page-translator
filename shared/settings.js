// Shared settings, loaded by the service worker (importScripts), the popup (<script>)
// and the content scripts (manifest). Plain global, no modules, so it works in all three.
var PT_DEFAULTS = {
  autoTranslate: false,      // translate every non-English page on load
  engine: 'auto',            // 'auto' | 'chrome' | 'google'
  ignoreNoTranslate: true    // ignore notranslate meta / translate="no" / class="notranslate"
};

async function ptLoadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(PT_DEFAULTS));
  return { ...PT_DEFAULTS, ...stored };
}

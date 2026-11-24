// Tiny static server for the test pages (no dependencies).
//   node test/serve.js
// Open http://localhost:8080/test.html — the page embeds frames from the same origin
// (localhost) and from 127.0.0.1, which the browser treats as a different origin, so
// both same-origin and cross-origin iframes are covered with a single server.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const ROOT = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); return res.end(); // malformed %-escape would otherwise crash the server
  }
  const file = path.join(ROOT, urlPath === '/' ? 'test.html' : urlPath);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Test page:            http://localhost:${PORT}/test.html`);
  console.log(`(cross-origin frames come from http://127.0.0.1:${PORT})`);
});

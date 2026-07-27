// Minimal static server for the repo root. Deliberately sends NO ETag header:
// the app's heartbeat (_fetchIndexEtag, index.html:3378) then disables itself (_vchkDisabled)
// so tests never see a heartbeat-triggered reload even without the route shim.
import http from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shimJs, INJECT_ANCHOR } = require('./routes.js');

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const port = Number(process.env.STATIC_PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.csv': 'text/csv; charset=utf-8',
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  if (pathname === '/') pathname = '/index.html';
  const file = normalize(join(root, pathname));
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('not found'); return;
  }
  // Emulator-shim injection: contexts created by boot.js send `x-test-shim: <projectId>:<port>`.
  // Injecting here (instead of route.fulfill) keeps the document's origin native in Chromium —
  // fulfilled documents lose their local address space and all cross-port fetches fail.
  const shimSpec = req.headers['x-test-shim'];
  if (shimSpec && pathname === '/index.html' && req.method === 'GET') {
    const m = /^(.+):(\d+)$/.exec(String(shimSpec));
    if (!m) { res.writeHead(400); res.end('bad x-test-shim'); return; }
    let html = readFileSync(file, 'utf8');
    if (!INJECT_ANCHOR.test(html)) { res.writeHead(500); res.end('shim anchor not found — firebase CDN tags changed'); return; }
    html = html.replace(INJECT_ANCHOR, `$1\n<script>${shimJs(m[1], Number(m[2]))}</script>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => console.log(`static server on http://127.0.0.1:${port} serving ${root}`));

// Chromium holds keep-alive sockets open, so a plain server.close() never resolves.
// Drop live connections and hard-exit on a deadline so teardown can never stall a run.
// (Do NOT tie shutdown to stdin: non-interactive shells hand us a closed stdin and the
// server would exit before serving anything.)
function shutdown() {
  try { server.closeAllConnections?.(); } catch { /* older Node */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

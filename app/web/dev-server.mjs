import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
// Local dev server for the project home (not deployed). Serves app/web and proxies /api/* and /ws/* to the Worker,
// which sends no CORS headers. Usage: node dev-server.mjs [port], then open http://localhost:8788/r/<repo>#k=<key>
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// UPSTREAM, else the deployment from ~/.cinq/config.json
const UPSTREAM = new URL(process.env.UPSTREAM || JSON.parse(require_('fs').readFileSync(require_('path').join(require_('os').homedir(), '.cinq', 'config.json'), 'utf8')).url);
const PORT = Number(process.argv[2] || process.env.PORT || 8788);
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function proxy(req, res) {
  const headers = { ...req.headers, host: UPSTREAM.host };
  delete headers.origin; delete headers.referer;
  const up = https.request({ host: UPSTREAM.hostname, port: 443, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'dev proxy: ' + e.message })); });
  req.pipe(up);
}

async function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path === '/' || path.startsWith('/r/') ? 'index.html' : normalize(path).replace(/^([/\\])+/, '');
  if (file.includes('..') || file === 'dev-server.mjs') { res.writeHead(404); return res.end('not found'); }
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) return proxy(req, res);
  serveStatic(req, res);
});

// WebSocket: open a TLS socket to the Worker, replay the upgrade request with the upstream Host, then pipe both ways.
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws/')) return socket.destroy();
  const up = tls.connect({ host: UPSTREAM.hostname, port: 443, servername: UPSTREAM.hostname }, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], v = req.rawHeaders[i + 1];
      if (/^(host|origin)$/i.test(k)) continue;
      lines.push(`${k}: ${v}`);
    }
    lines.push(`Host: ${UPSTREAM.host}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const end = () => { socket.destroy(); up.destroy(); };
  up.on('error', end); socket.on('error', end);
});

server.listen(PORT, () => console.log(`project home on http://localhost:${PORT}/r/<repo>  (proxying ${UPSTREAM.origin})`));

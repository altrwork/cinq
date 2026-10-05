// Test-only git smart-HTTP server (git http-backend over CGI) that stands in for an Artifacts trunk:
// every request needs Basic auth whose password hashes to argv[3]. It gets only the hash, never the token,
// so a test hunting for the token in /proc finds nothing here.
// Usage: node git-http.cjs <projectRoot> <sha256(token)>   → prints the port on stdout
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const [root, tokenHash] = process.argv.slice(2);
const backend = require('node:path').join(execFileSync('git', ['--exec-path'], { windowsHide: true, encoding: 'utf8' }).trim(), 'git-http-backend');

http.createServer((req, res) => {
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  const pass = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
  if (!pass || crypto.createHash('sha256').update(pass).digest('hex') !== tokenHash) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="trunk"' }); return res.end('unauthorised');
  }
  const u = new URL(req.url, 'http://x');
  const cgi = spawn(backend, [], { windowsHide: true, env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'x',
    PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '',
    HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '', REMOTE_ADDR: '127.0.0.1' } });
  req.pipe(cgi.stdin);
  let buf = Buffer.alloc(0); let head = false;
  cgi.stdout.on('data', (d) => {
    if (head) return res.write(d);
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    head = true; let status = 200; const headers = {};
    for (const l of buf.slice(0, i).toString().split('\r\n')) { const [k, ...v] = l.split(':'); if (/^status$/i.test(k)) status = parseInt(v.join(':')); else headers[k] = v.join(':').trim(); }
    res.writeHead(status, headers); res.write(buf.slice(i + 4));
  });
  cgi.on('close', () => res.end());
}).listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port) + '\n'); });

/**
 * Tiny static server for local Fire TV testing.
 *
 *   node server/serve.js              # serves the repo root on :8080, all NICs
 *   PORT=9000 node server/serve.js
 *
 * Includes:
 *   - permissive CORS (so an IMA WebView fetching from a different origin works)
 *   - /track/*  endpoints that just 200 + log (so VAST tracking pings show up)
 *   - directory traversal protection
 *
 * No deps. Plain Node.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');
const os   = require('os');

const PORT     = Number(process.env.PORT || 8080);
const ROOT     = path.resolve(__dirname, '..');
const MIME     = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
};

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();

  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname || '/');

  // VAST tracking-ping endpoints. Just log + 1x1 GIF.
  if (pathname.startsWith('/track/')) {
    console.log(`[track] ${pathname}${parsed.search || ''}`);
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  }

  // Default to /vast/interactive-vast.xml when someone hits /vast?
  if (pathname === '/vast' || pathname === '/vast/') pathname = '/vast/interactive-vast.xml';

  if (pathname === '/') pathname = '/README.md';

  const safe = path.normalize(path.join(ROOT, pathname));
  if (!safe.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.stat(safe, (err, stat) => {
    if (err) { res.writeHead(404); return res.end('Not found: ' + pathname); }
    if (stat.isDirectory()) {
      // Try index.html in dir.
      const idx = path.join(safe, 'index.html');
      if (fs.existsSync(idx)) return stream(idx, res);
      res.writeHead(403); return res.end('Directory listing disabled');
    }
    stream(safe, res);
  });
});

function stream(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(filePath)
    .on('error', () => { res.writeHead(500); res.end('Read error'); })
    .pipe(res);
}

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(`${ni.address}  (${name})`);
    }
  }
  console.log(`Serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);
  addrs.forEach(a => console.log(`  http://${a.replace(/  .*$/, '')}:${PORT}/   <- use this from Fire TV`));
  console.log(`VAST tag URL: http://<lan-ip>:${PORT}/vast/interactive-vast.xml`);
  console.log(`Creative:     http://<lan-ip>:${PORT}/creative/index.html?debug=1`);
});

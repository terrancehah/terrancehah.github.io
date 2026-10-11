// Simple proxy server to mimic Vercel's routing locally
// Routes /api/* requests to FastAPI backend on port 8000
// Serves static files from root directory

const http = require('http');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');

const proxy = httpProxy.createProxyServer({});
const PORT = 3000;
const API_PORT = 8000;

// MIME types for static files
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.gpx': 'application/gpx+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
};

const server = http.createServer((req, res) => {
  // Route /projects/persona requests to FastAPI backend (persona generator).
  if (req.url.startsWith('/projects/persona')) {
    console.log(`[PROXY] ${req.method} ${req.url} -> http://localhost:${API_PORT}`);
    // Rewrite the URL to remove /projects/persona prefix.
    const apiUrl = req.url.replace('/projects/persona', '');
    req.url = apiUrl || '/';
    proxy.web(req, res, { 
      target: `http://localhost:${API_PORT}`,
      changeOrigin: true
    });
    return;
  }

  // Route /projects/running-posture-analyser/analyse to FastAPI /analyse endpoint.
  if (req.url.startsWith('/projects/running-posture-analyser/analyse')) {
    console.log(`[PROXY] ${req.method} ${req.url} -> http://localhost:${API_PORT}/analyse`);
    req.url = '/analyse';
    proxy.web(req, res, {
      target: `http://localhost:${API_PORT}`,
      changeOrigin: true
    });
    return;
  }

  // Route the Biwa ride's API calls to its isolated dev runner (biwa-dev.py).
  // Only /projects/biwa-ride/api/biwa-* is forwarded, ahead of all other
  // routing; everything else on the site is untouched.
  if (req.url.startsWith('/projects/biwa-ride/api/')) {
    const apiPath = req.url.replace('/projects/biwa-ride/api/', '/api/');
    console.log(`[PROXY] ${req.method} ${req.url} -> http://localhost:${API_PORT}${apiPath}`);
    req.url = apiPath;
    proxy.web(req, res, {
      target: `http://localhost:${API_PORT}`,
      changeOrigin: true
    });
    return;
  }

  // Route Pacey's API calls to the FastAPI /race-goal/* endpoints. The app now
  // calls /pacey/api/*; the old /projects/pacey/api/* prefix is kept so a
  // cached page still works.
  if (req.url.startsWith('/pacey/api/') || req.url.startsWith('/projects/pacey/api/')) {
    const apiPath = req.url.replace(/^\/(?:projects\/pacey|pacey)\/api\//, '/race-goal/');
    console.log(`[PROXY] ${req.method} ${req.url} -> http://localhost:${API_PORT}${apiPath}`);
    req.url = apiPath;
    proxy.web(req, res, {
      target: `http://localhost:${API_PORT}`,
      changeOrigin: true
    });
    return;
  }

  // The old /projects/pacey page 301s to the app's real path, /pacey.
  if (req.url === '/projects/pacey' || req.url === '/projects/pacey/') {
    res.writeHead(301, { Location: '/pacey' });
    res.end();
    return;
  }

  // Serve static files. The path is percent-decoded so filenames containing
  // escaped characters resolve — without this, '%20' is treated as literal
  // text and the request 404s even though the file exists.
  let reqPath = req.url;
  try {
    reqPath = decodeURIComponent(reqPath);
  } catch (e) {
    // Malformed escape sequence — fall back to the raw path.
  }
  let filePath = '.' + reqPath;
  if (filePath === './') {
    filePath = './index.html';
  }

  // A directory serves its index.html (e.g. /pacey -> ./pacey/index.html)
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // Handle clean URLs (e.g., /about -> /about.html)
  if (!path.extname(filePath) && !fs.existsSync(filePath)) {
    const htmlPath = filePath + '.html';
    if (fs.existsSync(htmlPath)) {
      filePath = htmlPath;
    }
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`, 'utf-8');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

proxy.on('error', (err, req, res) => {
  console.error('[PROXY ERROR]', err.message);
  res.writeHead(502, { 'Content-Type': 'text/plain' });
  res.end('Bad Gateway - Is the FastAPI server running on port 8000?');
});

server.listen(PORT, () => {
  console.log(`\n🚀 Development server running:`);
  console.log(`   Static site:               http://localhost:${PORT}`);
  console.log(`   API proxied from:          http://localhost:${API_PORT}`);
  console.log(`\n   Persona generator:         http://localhost:${PORT}/projects/persona`);
  console.log(`   Running posture analyser:  http://localhost:${PORT}/projects/running-posture-analyser`);
  console.log(`   Pacey:                http://localhost:${PORT}/pacey`);
  console.log(`   (the old /projects/pacey 301s to /pacey)\n`);
});

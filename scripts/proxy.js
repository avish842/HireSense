const http = require('http');
const httpProxy = require('http-proxy');

// Create the proxy server
const proxy = httpProxy.createProxyServer({
  changeOrigin: true
});

// Target mapping
const targets = {
  auth: 'http://localhost:3001',
  ingestion: 'http://localhost:3002',
  ws: 'http://localhost:3005',
  frontend: 'http://localhost:5173'
};

// Create main HTTP server to handle proxy routing
const server = http.createServer((req, res) => {
  // CORS preflight handling for direct requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route requests based on URL prefix
  if (req.url.startsWith('/auth')) {
    proxy.web(req, res, { target: targets.auth });
  } else if (req.url.startsWith('/ingestion')) {
    proxy.web(req, res, { target: targets.ingestion });
  } else {
    // Default route: Frontend (Vite)
    proxy.web(req, res, { target: targets.frontend });
  }
});

// Handle WebSocket upgrades (Socket.io and Vite HMR)
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/socket.io')) {
    proxy.ws(req, socket, head, { target: targets.ws });
  } else {
    // Default to Vite dev server HMR (Hot Module Replacement) websocket
    proxy.ws(req, socket, head, { target: targets.frontend });
  }
});

// Error handling
proxy.on('error', (err, req, res) => {
  console.error('[Proxy Error]:', err.message);
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway: Target service might be offline.');
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`  Local Reverse Proxy running on http://localhost:${PORT}`);
  console.log(`  Routes:`);
  console.log(`    /auth/*      -> Port 3001`);
  console.log(`    /ingestion/* -> Port 3002`);
  console.log(`    /socket.io/* -> Port 3005`);
  console.log(`    * (Default)  -> Port 5173 (Frontend)`);
  console.log(`====================================================`);
});

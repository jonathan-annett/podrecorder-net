const express    = require('express');
const { WebSocketServer } = require('ws');
const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const url        = require('url');
const { nanoid } = require('nanoid');

// ─── TLS / cert config ────────────────────────────────────────────────────────
// Looks for cert.json in the project root (written by setup-cert.sh).
// Falls back to plain HTTP if not present — safe for localhost dev.
//
// cert.json format:
// {
//   "key":  "/etc/letsencrypt/live/yourdomain.com/privkey.pem",
//   "cert": "/etc/letsencrypt/live/yourdomain.com/fullchain.pem"
// }

const CERT_CONFIG = path.join(__dirname, 'cert.json');

function loadCertConfig() {
  try {
    return JSON.parse(fs.readFileSync(CERT_CONFIG, 'utf8'));
  } catch {
    return null;
  }
}

function readCerts(cfg) {
  try {
    return {
      key:  fs.readFileSync(cfg.key),
      cert: fs.readFileSync(cfg.cert),
    };
  } catch (e) {
    console.error('⚠️  Could not read cert files:', e.message);
    return null;
  }
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

// Required for SharedArrayBuffer (Whisper WASM threading)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/transcribe', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'transcribe.html')));

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = new Map();

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [token, room] of rooms)
    if (room.created < cutoff) rooms.delete(token);
}, 60 * 60 * 1000);

app.get('/api/create-room', (req, res) => {
  const token = nanoid(12);
  rooms.set(token, { host: null, guest: null, created: Date.now() });
  res.json({ token });
});

app.get('/api/room/:token', (req, res) => {
  const room = rooms.get(req.params.token);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ exists: true, full: room.host !== null && room.guest !== null });
});

// ─── HTTP → HTTPS redirect (only when running HTTPS) ─────────────────────────
function makeRedirectServer(httpsPort) {
  return http.createServer((req, res) => {
    const host = req.headers.host?.replace(/:\d+$/, '');
    const dest = `https://${host}${httpsPort !== 443 ? ':' + httpsPort : ''}${req.url}`;
    res.writeHead(301, { Location: dest });
    res.end();
  });
}

// ─── WebSocket handler (shared between http and https server) ─────────────────
function attachWss(server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const query = url.parse(req.url, true).query;
    const token = query.token;

    if (!token || !rooms.has(token)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid room token' }));
      ws.close();
      return;
    }

    const room = rooms.get(token);
    let role;
    if      (room.host  === null) { room.host  = ws; role = 'host';  }
    else if (room.guest === null) { room.guest = ws; role = 'guest'; }
    else {
      ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
      ws.close();
      return;
    }

    ws.role  = role;
    ws.token = token;
    ws.send(JSON.stringify({ type: 'role', role, serverTime: Date.now() }));

    if (role === 'guest' && room.host?.readyState === 1) {
      const ts = { type: 'peer-joined', serverTime: Date.now() };
      room.host.send(JSON.stringify(ts));
      room.guest.send(JSON.stringify(ts));
    }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      const room = rooms.get(ws.token);
      if (!room) return;

      switch (msg.type) {
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong', clientTime: msg.clientTime,
            serverTime: Date.now(), seq: msg.seq,
          }));
          break;
        case 'signal':
        case 'peer-msg': {
          const peer = ws.role === 'host' ? room.guest : room.host;
          if (peer?.readyState === 1)
            peer.send(JSON.stringify({ type: msg.type, data: msg.data }));
          break;
        }
      }
    });

    ws.on('close', () => {
      const room = rooms.get(ws.token);
      if (!room) return;
      if (room.host  === ws) room.host  = null;
      if (room.guest === ws) room.guest = null;
      const other = room.host ?? room.guest;
      if (other?.readyState === 1)
        other.send(JSON.stringify({ type: 'peer-left' }));
      if (!room.host && !room.guest) rooms.delete(ws.token);
    });
  });

  return wss;
}

// ─── Server startup ───────────────────────────────────────────────────────────
const HTTP_PORT  = parseInt(process.env.HTTP_PORT  || '80',   10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443',  10);
const DEV_PORT   = parseInt(process.env.PORT       || '3000', 10);

const certCfg = loadCertConfig();

if (certCfg) {
  // ── HTTPS mode ──────────────────────────────────────────────────────────────
  const certs = readCerts(certCfg);
  if (!certs) {
    console.error('❌  cert.json found but cert files are unreadable. Falling back to HTTP.');
    startHttp();
  } else {
    const httpsServer = https.createServer(certs, app);
    attachWss(httpsServer);
    httpsServer.listen(HTTPS_PORT, () =>
      console.log(`🔒  Podcast Studio (HTTPS) → https://localhost:${HTTPS_PORT}`));

    // HTTP → HTTPS redirect on port 80
    const redirectServer = makeRedirectServer(HTTPS_PORT);
    redirectServer.listen(HTTP_PORT, () =>
      console.log(`↪️   HTTP redirect          → http://localhost:${HTTP_PORT}`));

    // ── Auto-reload certs on renewal ──────────────────────────────────────────
    // certbot renews in-place; watching fullchain.pem is enough.
    // We re-read the key material and call server.setSecureContext() —
    // no restart, no dropped connections.
    let debounceTimer = null;
    fs.watchFile(certCfg.cert, { interval: 60_000 }, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const fresh = readCerts(certCfg);
        if (!fresh) { console.warn('⚠️  Cert reload failed — still using old certs.'); return; }
        try {
          httpsServer.setSecureContext(fresh);
          console.log(`🔄  TLS certs reloaded — ${new Date().toISOString()}`);
        } catch (e) {
          console.warn('⚠️  setSecureContext failed:', e.message);
        }
      }, 2000); // small debounce — certbot writes key then cert
    });

    console.log(`👁️   Watching ${certCfg.cert} for renewal…`);
  }
} else {
  // ── HTTP mode (localhost dev) ────────────────────────────────────────────────
  startHttp();
}

function startHttp() {
  const httpServer = http.createServer(app);
  attachWss(httpServer);
  httpServer.listen(DEV_PORT, () => {
    console.log(`🎙️   Podcast Studio (HTTP)  → http://localhost:${DEV_PORT}`);
    console.log(`     No cert.json found — running in plain HTTP mode.`);
    console.log(`     Run setup-cert.sh to enable HTTPS for production use.`);
  });
}

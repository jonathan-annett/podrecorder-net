// Podcast Studio — Cloudflare Worker
//
// Ports the old Node server (server.js: express static + `ws` signaling relay)
// to Workers + Durable Objects:
//   • Static PWA assets are served by the [assets] binding.
//   • Each room token maps to one `Room` Durable Object that holds the two peer
//     WebSockets and relays signaling between them (was the in-memory `rooms` Map).
//   • R2 provides a store-and-forward fallback for the HQ recording transfer.
//   • /api/turn-credentials mints short-lived Cloudflare Realtime TURN creds.
//
// TLS, cert watching, and HTTP→HTTPS redirect from server.js are gone — the edge
// terminates TLS.

import { createClerkClient } from '@clerk/backend';

const TOKEN_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; // 64 chars
const TOKEN_LEN = 12;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

function genToken(len = TOKEN_LEN) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += TOKEN_ALPHABET[bytes[i] & 63];
  return out;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Headers that enable SharedArrayBuffer (Whisper WASM threading). Mirrors the
// COOP/COEP middleware in the old server.js. Also declared in public/_headers
// for assets served directly by the platform; set here for docs we proxy.
function withIsolation(res) {
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, headers: h });
}

// ── Entitlement ──────────────────────────────────────────────────────────────
// TURN + R2 (+ WS relay) are gated. Resolves whether the caller is entitled to
// create an entitled room; returns a userId string when entitled, else null.
// Governed by AUTH_MODE:
//   • 'off'       — no auth; nobody is entitled via sign-in (default; prod today).
//   • 'prelaunch' — any signed-in user is entitled (no payment). Pre-launch testing.
//   • 'live'      — entitled only with the paid `pro` plan (has({plan:'pro'})).
// CI bypass: `X-Test-Entitle: <TEST_ENTITLE_SECRET>` — only honored when the secret
// is set (never in prod). It works regardless of AUTH_MODE.
async function requirePro(request, env) {
  const testHeader = request.headers.get('X-Test-Entitle');
  if (env.TEST_ENTITLE_SECRET && testHeader === env.TEST_ENTITLE_SECRET) {
    return 'test-user';
  }
  const mode = env.AUTH_MODE || 'off';
  if (mode === 'off' || !env.CLERK_SECRET_KEY) return null;
  try {
    const clerk = createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });
    const auth = (await clerk.authenticateRequest(request)).toAuth();
    if (!auth?.userId) return null;
    if (mode === 'prelaunch') return auth.userId;               // signed-in = entitled
    if (mode === 'live' && auth.has({ plan: 'pro' })) return auth.userId;
    return null;
  } catch {
    return null;
  }
}

// Read the entitlement flag a room's Durable Object has stored.
async function roomEntitled(env, token) {
  if (!token) return false;
  try {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(token));
    const res = await stub.fetch('https://room/status');
    const status = await res.json();
    return status.entitled === true;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── Signaling WebSocket → Room Durable Object ──
    if (pathname === '/ws') {
      const token = url.searchParams.get('token');
      if (!token) return new Response('missing token', { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(token));
      return stub.fetch(request);
    }

    // Client-visible config: which auth mode is active (off | prelaunch | live).
    // Defaults 'off' so a public deploy stays free-only (no auth UI, no payment
    // surface). 'prelaunch' shows sign-in only (no checkout; sign-in = entitled);
    // 'live' shows sign-in + Go Pro (entitlement requires the paid plan).
    if (pathname === '/api/config') {
      return json({ authMode: env.AUTH_MODE || 'off' });
    }

    // ── Room lifecycle API ──
    if (pathname === '/api/create-room') {
      const token = genToken();
      const owner = await requirePro(request, env);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(token));
      await stub.fetch('https://room/create', {
        method: 'POST',
        body: JSON.stringify({ entitled: !!owner, ownerId: owner }),
      });
      return json({ token, entitled: !!owner });
    }

    if (pathname.startsWith('/api/room/')) {
      const rest = decodeURIComponent(pathname.slice('/api/room/'.length));
      if (!rest) return json({ error: 'Room not found' }, 404);

      // POST /api/room/:token/entitle — flip a room to entitled once the host
      // proves Pro (covers signing in *after* landing on the room).
      if (rest.endsWith('/entitle')) {
        const token = rest.slice(0, -'/entitle'.length);
        if (!token) return json({ error: 'Room not found' }, 404);
        const owner = await requirePro(request, env);
        if (!owner) return json({ error: 'Payment required' }, 402);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(token));
        await stub.fetch('https://room/entitle', {
          method: 'POST',
          body: JSON.stringify({ ownerId: owner }),
        });
        return json({ entitled: true });
      }

      const token = rest;
      const stub = env.ROOMS.get(env.ROOMS.idFromName(token));
      const res = await stub.fetch('https://room/status');
      const status = await res.json();
      if (!status.exists) return json({ error: 'Room not found' }, 404);
      return json({ exists: true, full: status.full, entitled: !!status.entitled });
    }

    // ── Short-lived TURN credentials (Pro rooms only; else STUN-only) ──
    if (pathname === '/api/turn-credentials') {
      const token = url.searchParams.get('token');
      const entitled = await roomEntitled(env, token);
      const creds = entitled
        ? await turnCredentials(env)
        : { iceServers: [STUN_SERVERS] };
      return json({ ...creds, entitled });
    }

    // ── R2 recording fallback:  /api/blob/:token/:role ──
    if (pathname.startsWith('/api/blob/')) {
      return handleBlob(request, env, url);
    }

    // ── /transcribe → the Whisper page (proxied so we can force isolation hdrs) ──
    if (pathname === '/transcribe') {
      const res = await env.ASSETS.fetch(
        new Request(new URL('/transcribe.html', url), request),
      );
      return withIsolation(res);
    }

    // ── Everything else: static assets (index.html, client.js, sw.js, icons…) ──
    return env.ASSETS.fetch(request);
  },
};

// ── TURN credential minting (Cloudflare Realtime) ─────────────────────────────
const STUN_SERVERS = {
  urls: [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
  ],
};

async function turnCredentials(env) {
  const stun = STUN_SERVERS;
  if (!env.TURN_TOKEN_ID || !env.TURN_API_TOKEN) {
    return { iceServers: [stun] };
  }
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_TOKEN_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (!res.ok) return { iceServers: [stun] };
    const data = await res.json();
    // Cloudflare returns { iceServers: {...} } or { iceServers: [...] }.
    const cf = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    return { iceServers: [stun, ...cf.filter(Boolean)] };
  } catch {
    return { iceServers: [stun] };
  }
}

// ── R2 store-and-forward for the HQ recording ─────────────────────────────────
async function handleBlob(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','blob',token,role]
  const token = parts[2];
  const role = parts[3];
  if (!token || !role) return new Response('bad path', { status: 400 });

  // The R2 fallback is Pro-only — the whole room is gated on entitlement.
  if (!(await roomEntitled(env, token))) {
    return json({ error: 'Payment required' }, 402);
  }
  const key = `${token}/${role}`;

  switch (request.method) {
    case 'PUT': {
      await env.RECORDINGS.put(key, request.body, {
        httpMetadata: {
          contentType:
            request.headers.get('content-type') || 'application/octet-stream',
        },
        customMetadata: { uploaded: String(Date.now()) },
      });
      return json({ ok: true, key });
    }
    case 'GET': {
      const obj = await env.RECORDINGS.get(key);
      if (!obj) return new Response('not found', { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      return new Response(obj.body, { headers });
    }
    case 'DELETE': {
      await env.RECORDINGS.delete(key);
      return json({ ok: true });
    }
    default:
      return new Response('method not allowed', { status: 405 });
  }
}

// ── Room Durable Object ───────────────────────────────────────────────────────
// Uses the WebSocket Hibernation API so the room survives eviction between the
// client's 5s pings. Roles are stored as connection tags ('host'/'guest') so we
// can look up the peer with getWebSockets(tag) after a hibernation wake.
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  // Safely parse an optional JSON body from an internal room request.
  async readJson(request) {
    try {
      const text = await request.text();
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/create') {
      await this.ctx.storage.put('created', Date.now());
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      const body = await this.readJson(request);
      if (body.entitled) {
        await this.ctx.storage.put('entitled', true);
        this.entitled = true;
        if (body.ownerId) await this.ctx.storage.put('ownerId', body.ownerId);
      }
      return new Response('ok');
    }

    if (url.pathname === '/entitle') {
      const body = await this.readJson(request);
      await this.ctx.storage.put('entitled', true);
      this.entitled = true;
      if (body.ownerId) await this.ctx.storage.put('ownerId', body.ownerId);
      return new Response('ok');
    }

    if (url.pathname === '/status') {
      const created = await this.ctx.storage.get('created');
      const entitled = (await this.ctx.storage.get('entitled')) === true;
      const count = this.ctx.getWebSockets().length;
      return Response.json({ exists: created != null, full: count >= 2, entitled });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleUpgrade(request);
    }

    return new Response('not found', { status: 404 });
  }

  async handleUpgrade(request) {
    const created = await this.ctx.storage.get('created');
    const guid = new URL(request.url).searchParams.get('guid') || null;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const reject = (message) => {
      server.accept();
      server.send(JSON.stringify({ type: 'error', message }));
      server.close(1008, message);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (created == null) return reject('Invalid room token');

    // Reconnect / single-session: a live socket carrying the same device GUID (a
    // refresh, or the room reopened in another tab of the same browser) is the SAME
    // device — evict the stale socket and reuse its slot, instead of counting it as
    // a third participant ("Room is full").
    let role = null;
    const liveRoles = [];
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment() || {};
      if (guid && a.guid === guid) {
        role = a.role || null;
        try { s.close(1000, 'reconnected'); } catch { /* already closing */ }
      } else if (a.role) {
        liveRoles.push(a.role);
      }
    }
    if (!role) {
      if (!liveRoles.includes('host')) role = 'host';
      else if (!liveRoles.includes('guest')) role = 'guest';
      else return reject('Room is full');
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, guid });

    server.send(JSON.stringify({ type: 'role', role, serverTime: Date.now() }));

    // Announce peer-joined to both when the room now has both roles present. Target
    // the NEW socket + the other role's live socket, so a just-evicted stale socket
    // is never used. Fires for host OR guest (re)joining — a refresh re-triggers
    // peer setup on the surviving side too.
    const otherRole = role === 'host' ? 'guest' : 'host';
    const other = this.ctx.getWebSockets(otherRole).find((s) => s.readyState === 1);
    if (other) {
      const ts = JSON.stringify({ type: 'peer-joined', serverTime: Date.now() });
      server.send(ts);
      other.send(ts);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || {};
    const role = att.role;

    // Binary frame → live media relay fallback (WebRTC blocked). Forward the raw
    // frame to the peer, but ONLY for entitled (Pro) rooms — free rooms get no
    // server relay. Cache the entitled flag so we don't hit storage per frame.
    if (typeof message !== 'string') {
      if (this.entitled === undefined) {
        this.entitled = (await this.ctx.storage.get('entitled')) === true;
      }
      if (!this.entitled) return;
      const peer = this.ctx.getWebSockets(role === 'host' ? 'guest' : 'host')[0];
      if (peer && peer.readyState === 1) peer.send(message);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'ping':
        ws.send(
          JSON.stringify({
            type: 'pong',
            clientTime: msg.clientTime,
            serverTime: Date.now(),
            seq: msg.seq,
          }),
        );
        break;
      case 'signal':
      case 'peer-msg': {
        const peer = this.ctx.getWebSockets(role === 'host' ? 'guest' : 'host')[0];
        if (peer && peer.readyState === 1)
          peer.send(JSON.stringify({ type: msg.type, data: msg.data }));
        break;
      }
    }
  }

  webSocketClose(ws, code, reason) {
    // A socket we intentionally evicted on reconnect (same nonce) — don't tell the
    // peer someone left; the client is just refreshing and reclaiming its slot.
    if (reason === 'reconnected') return;
    const att = ws.deserializeAttachment() || {};
    const peer = this.ctx.getWebSockets(att.role === 'host' ? 'guest' : 'host')[0];
    if (peer && peer.readyState === 1)
      peer.send(JSON.stringify({ type: 'peer-left' }));
  }

  webSocketError(ws) {
    // The runtime also fires webSocketClose after an error; peer-left is sent there.
  }

  async alarm() {
    // 24h GC (was the setInterval sweep in server.js). Close stragglers, drop state.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'room expired');
      } catch {
        /* already closing */
      }
    }
    await this.ctx.storage.deleteAll();
  }
}

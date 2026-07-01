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

// ── Entitlement (Clerk Billing) ──────────────────────────────────────────────
// TURN + R2 are Pro-only. This resolves whether the *caller* is entitled to
// create an entitled room. Returns a userId string when entitled, else null.
//   • CI bypass: `X-Test-Entitle: <TEST_ENTITLE_SECRET>` — only honored when the
//     secret is set (never in prod, where it is unset).
//   • Otherwise verify the Clerk session JWT and check the `pro` plan via has().
async function requirePro(request, env) {
  const testHeader = request.headers.get('X-Test-Entitle');
  if (env.TEST_ENTITLE_SECRET && testHeader === env.TEST_ENTITLE_SECRET) {
    return 'test-user';
  }
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const clerk = createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });
    const state = await clerk.authenticateRequest(request);
    const auth = state.toAuth();
    if (auth?.userId && auth.has({ plan: 'pro' })) return auth.userId;
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
        if (body.ownerId) await this.ctx.storage.put('ownerId', body.ownerId);
      }
      return new Response('ok');
    }

    if (url.pathname === '/entitle') {
      const body = await this.readJson(request);
      await this.ctx.storage.put('entitled', true);
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
      return this.handleUpgrade();
    }

    return new Response('not found', { status: 404 });
  }

  async handleUpgrade() {
    const created = await this.ctx.storage.get('created');
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

    const hasHost = this.ctx.getWebSockets('host').length > 0;
    const hasGuest = this.ctx.getWebSockets('guest').length > 0;

    let role;
    if (!hasHost) role = 'host';
    else if (!hasGuest) role = 'guest';
    else return reject('Room is full');

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    server.send(JSON.stringify({ type: 'role', role, serverTime: Date.now() }));

    // If both participants are now present, announce to both. This fires whether
    // the guest OR the host was the second to (re)connect — so a host that
    // refreshes and rejoins an occupied room re-triggers peer setup, exactly like
    // a guest does. (Previously peer-joined only fired for guests, so a host
    // refresh never recovered the connection.)
    const host  = this.ctx.getWebSockets('host')[0];
    const guest = this.ctx.getWebSockets('guest')[0];
    if (host && guest) {
      const ts = JSON.stringify({ type: 'peer-joined', serverTime: Date.now() });
      host.send(ts);
      guest.send(ts);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string') return; // control JSON only; media is P2P
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() || {};
    const role = att.role;

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

  webSocketClose(ws) {
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

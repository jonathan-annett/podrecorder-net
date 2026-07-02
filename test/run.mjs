// Layer 0 — headless smoke tests for the Cloudflare Worker signaling + storage.
//
// Proves the entire ported surface (HTTP endpoints, DO relay, clock-sync stamps,
// R2 round-trip) against a real local `workerd` runtime, before any browser is
// involved. Assumes `wrangler dev` is serving at BASE (default localhost:8787).
//
//   Usage:  BASE=http://localhost:8787 node test/run.mjs
//
// Exits non-zero on the first failure so it can gate the browser layers.

import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');

// Must match TEST_ENTITLE_SECRET in .dev.vars (the CI/dev entitlement bypass).
const ENTITLE_SECRET = process.env.TEST_ENTITLE_SECRET || 'test-entitle-secret';

// Create a room already flipped to entitled (Pro) via the test bypass header.
async function createEntitledRoom() {
  const res = await fetch(`${BASE}/api/create-room`, {
    method: 'POST',
    headers: { 'X-Test-Entitle': ENTITLE_SECRET },
  });
  return (await res.json()).token;
}

let passed = 0;
const failures = [];

function ok(name) {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function fail(name, err) {
  failures.push(name);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err}`);
}
async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err?.message || String(err));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  assert(a === b, msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── WebSocket helper: buffers messages, lets tests await a given type ──
function openWS(token, nonce) {
  const qs = `?token=${encodeURIComponent(token)}` + (nonce ? `&nonce=${encodeURIComponent(nonce)}` : '');
  const ws = new WebSocket(`${WS_BASE}/ws${qs}`);
  const seen = [];
  const binaries = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) { binaries.push(data); return; }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    seen.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  ws.opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.waitFor = (type, timeout = 4000) =>
    new Promise((resolve, reject) => {
      const pred = (m) => m.type === type;
      const hit = seen.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for '${type}' (saw: ${seen.map((m) => m.type).join(',') || 'nothing'})`));
      }, timeout);
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  ws.send$ = (obj) => ws.send(JSON.stringify(obj));
  ws.count = (type) => seen.filter((m) => m.type === type).length;
  ws.binaryCount = () => binaries.length;
  ws.waitForBinary = (timeout = 2000) =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        if (binaries.length) return resolve(binaries[binaries.length - 1]);
        if (Date.now() - start > timeout) return reject(new Error('no binary frame received'));
        setTimeout(poll, 20);
      })();
    });
  return ws;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error('waitUntil timed out');
}

console.log(`\nLayer 0 headless tests → ${BASE}\n`);

// ── HTTP endpoints ──
let token;
await test('create-room returns a 12-char token', async () => {
  const res = await fetch(`${BASE}/api/create-room`);
  eq(res.status, 200, `status ${res.status}`);
  const body = await res.json();
  assert(typeof body.token === 'string', 'token missing');
  eq(body.token.length, 12, `token length ${body.token.length}`);
  token = body.token;
});

await test('room/:token reports existing and not full', async () => {
  const res = await fetch(`${BASE}/api/room/${token}`);
  eq(res.status, 200);
  const body = await res.json();
  eq(body.exists, true);
  eq(body.full, false);
});

await test('room/:token 404s on an unknown token', async () => {
  const res = await fetch(`${BASE}/api/room/definitely-not-a-real-token`);
  eq(res.status, 404);
});

// ── DO signaling relay ──
await test('host connects and gets role=host + serverTime', async () => {
  const a = openWS(token);
  await a.opened;
  const role = await a.waitFor('role');
  eq(role.role, 'host');
  assert(typeof role.serverTime === 'number', 'serverTime missing');
  a.close();
  await sleep(150);
});

await test('two peers get roles and both receive peer-joined', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const a = openWS(t);
  await a.opened;
  const aRole = await a.waitFor('role');
  eq(aRole.role, 'host');

  const b = openWS(t);
  await b.opened;
  const bRole = await b.waitFor('role');
  eq(bRole.role, 'guest');

  const aJoined = await a.waitFor('peer-joined');
  const bJoined = await b.waitFor('peer-joined');
  assert(typeof aJoined.serverTime === 'number', 'host peer-joined serverTime');
  assert(typeof bJoined.serverTime === 'number', 'guest peer-joined serverTime');

  a.close();
  b.close();
  await sleep(150);
});

await test('signal is relayed host→guest verbatim', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const a = openWS(t);
  await a.opened;
  await a.waitFor('role');
  const b = openWS(t);
  await b.opened;
  await b.waitFor('role');
  await b.waitFor('peer-joined');

  const payload = { sdp: 'v=0 fake-offer', kind: 'offer' };
  a.send$({ type: 'signal', data: payload });
  const got = await b.waitFor('signal');
  eq(JSON.stringify(got.data), JSON.stringify(payload));

  a.close();
  b.close();
  await sleep(150);
});

await test('peer-msg (wrapping vox-start) is relayed guest→host verbatim', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const a = openWS(t);
  await a.opened;
  await a.waitFor('role');
  const b = openWS(t);
  await b.opened;
  await b.waitFor('role');
  await a.waitFor('peer-joined');

  const payload = { type: 'vox-start', t: 123456 };
  b.send$({ type: 'peer-msg', data: payload });
  const got = await a.waitFor('peer-msg');
  eq(got.data.type, 'vox-start');
  eq(got.data.t, 123456);

  a.close();
  b.close();
  await sleep(150);
});

await test('ping is answered with pong echoing clientTime + seq, plus serverTime', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const a = openWS(t);
  await a.opened;
  await a.waitFor('role');

  const clientTime = 1700000000000;
  a.send$({ type: 'ping', clientTime, seq: 7 });
  const pong = await a.waitFor('pong');
  eq(pong.clientTime, clientTime);
  eq(pong.seq, 7);
  assert(typeof pong.serverTime === 'number', 'pong.serverTime missing');

  // Clock-offset math sanity (same algorithm the client uses):
  //   offset = ((serverRecv - clientSend) + (serverSend - clientRecv)) / 2
  // Locally this should be a small, finite number.
  const clientRecv = Date.now();
  const offset = ((pong.serverTime - clientTime) + (pong.serverTime - clientRecv)) / 2;
  assert(Number.isFinite(offset), 'clock offset not finite');

  a.close();
  await sleep(150);
});

await test('room reports full with two peers; third is rejected', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const a = openWS(t);
  await a.opened;
  await a.waitFor('role');
  const b = openWS(t);
  await b.opened;
  await b.waitFor('role');
  await a.waitFor('peer-joined');

  const status = await (await fetch(`${BASE}/api/room/${t}`)).json();
  eq(status.full, true, 'room should report full');

  const c = openWS(t);
  await c.opened;
  const err = await c.waitFor('error');
  eq(err.message, 'Room is full');

  a.close();
  b.close();
  c.close();
  await sleep(150);
});

await test('connecting with an invalid token yields an error', async () => {
  const c = openWS('totally-invalid');
  await c.opened;
  const err = await c.waitFor('error');
  eq(err.message, 'Invalid room token');
  c.close();
  await sleep(150);
});

await test('when a peer disconnects the survivor receives peer-left', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const a = openWS(t);
  await a.opened;
  await a.waitFor('role');
  const b = openWS(t);
  await b.opened;
  await b.waitFor('role');
  await a.waitFor('peer-joined');

  b.close();
  const left = await a.waitFor('peer-left');
  eq(left.type, 'peer-left');

  a.close();
  await sleep(150);
});

// ── R2 recording fallback ──
await test('host can rejoin an occupied room and both sides get peer-joined again', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const a = openWS(t);
  await a.opened;
  await a.waitFor('role'); // host
  const b = openWS(t);
  await b.opened;
  await b.waitFor('role'); // guest
  await b.waitFor('peer-joined');
  const bBefore = b.count('peer-joined');

  // Host drops (simulates a refresh) …
  a.close();
  await b.waitFor('peer-left');
  await sleep(200);

  // … and reconnects: should be reassigned host, and BOTH sides get a fresh peer-joined.
  const a2 = openWS(t);
  await a2.opened;
  const role = await a2.waitFor('role');
  eq(role.role, 'host', 'rejoining host should be assigned host again');
  await a2.waitFor('peer-joined');                        // the rejoined host is told
  await waitUntil(() => b.count('peer-joined') > bBefore); // the existing guest is told again

  a2.close();
  b.close();
  await sleep(150);
});

await test('blob on a free room is gated with 402 Payment Required', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const bytes = new Uint8Array([82, 73, 70, 70]); // "RIFF"
  const put = await fetch(`${BASE}/api/blob/${t}/guest`, {
    method: 'PUT',
    headers: { 'content-type': 'audio/wav' },
    body: bytes,
  });
  eq(put.status, 402, `free PUT should be 402, got ${put.status}`);
  const get = await fetch(`${BASE}/api/blob/${t}/guest`);
  eq(get.status, 402, `free GET should be 402, got ${get.status}`);
  const del = await fetch(`${BASE}/api/blob/${t}/guest`, { method: 'DELETE' });
  eq(del.status, 402, `free DELETE should be 402, got ${del.status}`);
});

await test('blob PUT then GET round-trips bytes through R2 on an entitled room', async () => {
  const t = await createEntitledRoom();
  const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 255, 0, 128]); // "RIFF"+
  const put = await fetch(`${BASE}/api/blob/${t}/guest`, {
    method: 'PUT',
    headers: { 'content-type': 'audio/wav' },
    body: bytes,
  });
  eq(put.status, 200, `PUT status ${put.status}`);

  const get = await fetch(`${BASE}/api/blob/${t}/guest`);
  eq(get.status, 200, `GET status ${get.status}`);
  const back = new Uint8Array(await get.arrayBuffer());
  eq(back.length, bytes.length, 'byte length mismatch');
  for (let i = 0; i < bytes.length; i++) eq(back[i], bytes[i], `byte ${i} mismatch`);

  const del = await fetch(`${BASE}/api/blob/${t}/guest`, { method: 'DELETE' });
  eq(del.status, 200);
  const gone = await fetch(`${BASE}/api/blob/${t}/guest`);
  eq(gone.status, 404, 'blob should be gone after DELETE');
});

await test('create-room with test-entitle header marks the room entitled', async () => {
  const t = await createEntitledRoom();
  const status = await (await fetch(`${BASE}/api/room/${t}`)).json();
  eq(status.entitled, true, 'entitled room should report entitled:true');

  const free = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const freeStatus = await (await fetch(`${BASE}/api/room/${free}`)).json();
  eq(freeStatus.entitled, false, 'free room should report entitled:false');
});

await test('POST /api/room/:token/entitle upgrades a free room (402 without auth)', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;

  const denied = await fetch(`${BASE}/api/room/${t}/entitle`, { method: 'POST' });
  eq(denied.status, 402, `entitle without auth should be 402, got ${denied.status}`);

  const before = await (await fetch(`${BASE}/api/room/${t}`)).json();
  eq(before.entitled, false, 'room should start free');

  const ok = await fetch(`${BASE}/api/room/${t}/entitle`, {
    method: 'POST',
    headers: { 'X-Test-Entitle': ENTITLE_SECRET },
  });
  eq(ok.status, 200, `entitle with bypass should be 200, got ${ok.status}`);

  const after = await (await fetch(`${BASE}/api/room/${t}`)).json();
  eq(after.entitled, true, 'room should be entitled after /entitle');

  // Gate now open: blob PUT succeeds.
  const put = await fetch(`${BASE}/api/blob/${t}/host`, {
    method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1]),
  });
  eq(put.status, 200, `blob PUT after entitle should be 200, got ${put.status}`);
  await fetch(`${BASE}/api/blob/${t}/host`, { method: 'DELETE' });
});

await test('turn-credentials: free room is STUN-only + entitled:false', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const res = await fetch(`${BASE}/api/turn-credentials?token=${t}`);
  eq(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.iceServers), 'iceServers not an array');
  assert(body.iceServers.length >= 1, 'expected at least STUN');
  eq(body.entitled, false, 'free room should be entitled:false');

  // No token at all still returns a valid STUN list (never hard-fails).
  const noTok = await (await fetch(`${BASE}/api/turn-credentials`)).json();
  assert(Array.isArray(noTok.iceServers) && noTok.iceServers.length >= 1, 'STUN fallback');
  eq(noTok.entitled, false, 'no-token should be entitled:false');
});

await test('turn-credentials: entitled room reports entitled:true', async () => {
  const t = await createEntitledRoom();
  const res = await fetch(`${BASE}/api/turn-credentials?token=${t}`);
  eq(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.iceServers), 'iceServers not an array');
  eq(body.entitled, true, 'entitled room should be entitled:true');
});

await test('config exposes a valid authMode', async () => {
  const res = await fetch(`${BASE}/api/config`);
  eq(res.status, 200);
  const body = await res.json();
  assert(['off', 'prelaunch', 'live'].includes(body.authMode), `unexpected authMode: ${body.authMode}`);
});

await test('reconnect with the same nonce reuses the slot (refresh is not "room full")', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const a = openWS(t, 'nonce-a'); await a.opened; const aRole = await a.waitFor('role');
  const b = openWS(t, 'nonce-b'); await b.opened; const bRole = await b.waitFor('role');
  await a.waitFor('peer-joined');
  eq(aRole.role, 'host'); eq(bRole.role, 'guest');

  // Guest "refreshes": reconnect with the SAME nonce → reclaims the guest slot.
  const b2 = openWS(t, 'nonce-b'); await b2.opened;
  const b2msg = await b2.waitFor('role');   // 'role' (not 'error: Room is full')
  eq(b2msg.role, 'guest', 'refreshed client should reclaim its slot, not be rejected');

  a.close(); b.close(); b2.close(); await sleep(150);
});

await test('entitled room relays a binary frame between peers (WS media fallback)', async () => {
  const t = await createEntitledRoom();
  const a = openWS(t); await a.opened; await a.waitFor('role');
  const b = openWS(t); await b.opened; await b.waitFor('role'); await a.waitFor('peer-joined');
  a.send(Buffer.from([1, 2, 3, 4, 5]));
  const got = await b.waitForBinary();
  eq(got.length, 5, 'relayed binary frame length');
  a.close(); b.close(); await sleep(150);
});

await test('free room drops binary frames (no server relay)', async () => {
  const t = (await (await fetch(`${BASE}/api/create-room`)).json()).token;
  const a = openWS(t); await a.opened; await a.waitFor('role');
  const b = openWS(t); await b.opened; await b.waitFor('role'); await a.waitFor('peer-joined');
  a.send(Buffer.from([1, 2, 3, 4, 5]));
  await sleep(400);
  eq(b.binaryCount(), 0, 'free room must not relay binary frames');
  a.close(); b.close(); await sleep(150);
});

// ── Summary ──
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log('Failed: ' + failures.join(', '));
  process.exit(1);
}

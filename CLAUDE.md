# CLAUDE.md — Podcast Studio Handover

This file is a handover document for any future Claude session (or human developer)
picking up this project. It describes every design decision made, why it was made,
what was explicitly ruled out and why, and what the proposed next steps are.

---

## ⚠️ Status: migrated to Cloudflare Workers (July 2026)

This project was originally a self-hosted **Node.js** server (`server.js`) with
Let's Encrypt TLS. It has since been re-hosted as a **single Cloudflare Worker**
with **static assets + a Durable Object per room + R2**. See `README.md` for
current run/deploy instructions. What changed vs. the design below:

- **Signaling** now lives in a `Room` Durable Object (`src/worker.js`) instead of
  the in-memory `Map` + `ws` server. One DO instance per room token holds the two
  peer WebSockets and relays `signal` / `peer-msg` / `ping`→`pong`. Behaviour is
  otherwise identical to the ported `server.js` logic.
- **TLS / cert tooling is obsolete** — Cloudflare terminates TLS at the edge. The
  "TLS / HTTPS" section and `setup-cert.sh` / `import-cert.sh` /
  `self-signed-cert.sh` / `cert.json` are historical; `server.js` is retained
  only for reference.
- **TURN** is provided by **Cloudflare Realtime TURN** (minted in
  `/api/turn-credentials`), which supersedes the Coturn roadmap below.
- **Recording transfer** stays P2P over the data channel, with a new **R2
  store-and-forward fallback** (`/api/blob/:token/…`) when the channel can't
  complete or the peer is offline.
- **PWA**: added a manifest, a service worker (offline shell), self-hosted
  simple-peer + fonts, and `COEP: credentialless` for SharedArrayBuffer.
- **Bugs fixed during live (Layer 1) testing**, both WebRTC signaling races
  invisible to static review: peer creation is now gated on mic-ready *and*
  peer-joined (`maybeInitPeer`), and early-arriving signals are buffered until
  the peer exists.

Everything below this banner is the original design rationale — still accurate
for the client-side recording/stitching/transcription pipeline, and useful for
the "why", but read it through the migration notes above.

---

## What this project is

A self-hosted, two-person podcast recording studio that runs as a Node.js server.
It uses WebRTC for the live audio connection between participants, records each
speaker locally in high quality, exchanges the recordings peer-to-peer after the
session, stitches them into a stereo master WAV, and can produce a speaker-attributed
transcript entirely in the browser using Whisper WASM.

**Nothing is stored on the server.** The server is a signaling relay and a TLS
termination point. No audio, no recordings, no transcripts ever touch it.

---

## File map

```
podcast-studio/
├── server.js              Node.js HTTPS/HTTP server + WebSocket signaling relay
├── package.json           Dependencies: express, ws, nanoid
├── cert.json              (generated, gitignore this) TLS cert paths
├── setup-cert.sh          Let's Encrypt cert acquisition via certbot standalone
├── import-cert.sh         Import an existing cert from any CA
├── self-signed-cert.sh    Generate a self-signed cert for LAN / internal use
├── CLAUDE.md              This file
├── README.md              User-facing setup and usage guide
└── public/
    ├── index.html         Main studio UI (lobby + room)
    ├── client.js          All client-side logic (WebRTC, recording, VOX, transfer)
    └── transcribe.html    Post-session Whisper WASM transcription page
```

---

## Architecture decisions

### Why Node.js + ws, not a hosted service

The server is intentionally minimal — it does two things:

1. Issues short-lived 12-character room tokens via `nanoid`
2. Relays WebSocket messages between the two peers (SimplePeer signaling + VOX events + file transfer metadata)

It has no database, no user accounts, no session storage. Rooms expire from an
in-memory `Map` after 24 hours. This was a deliberate choice: the server is not
in the audio path at all. Everything sensitive is P2P.

### Why SimplePeer instead of raw WebRTC

SimplePeer wraps the browser WebRTC API with a cleaner event interface and handles
the ICE/SDP negotiation boilerplate. The server acts as the signaling relay —
it shuttles `offer`, `answer`, and `candidate` messages between peers via the
`signal` message type. Once the P2P connection is established, signaling traffic
drops to zero.

### The dual-path recording design

This was the most important architectural decision. There are two separate concerns:

**1. The monitoring path (real-time)**
- Opus codec via WebRTC, handled by SimplePeer/browser automatically
- Low latency, good enough for conversation
- This is what you *hear* during the call

**2. The recording path (local, per-speaker)**
Each side runs three simultaneous recorders when recording starts:

| Recorder | Stream source | Codec | Purpose |
|---|---|---|---|
| `hqRecorder` | Local mic (direct) | WAV/PCM @ 256kbps | Lossless master for stitching |
| `localWhisperRecorder` | Local mic (cloned track) | Opus webm @ 32kbps | Own voice → Whisper input |
| `remoteWhisperRecorder` | Incoming peer MediaStream | Opus webm @ 32kbps | Peer voice → Whisper input |

The mic is cloned with `getAudioTracks()[0].clone()` so the HQ and Whisper
recorders are completely independent — they don't share state and stopping one
doesn't affect the other.

The remote Whisper recorder starts from the `peer.on('stream')` event. If the
peer stream arrives after recording has already started, it auto-starts then.
If recording starts after the peer stream is already present, it starts immediately.

**Why 32kbps Opus for Whisper?**
The Whisper model expects 16kHz mono PCM. The WebRTC monitoring path already
transmits Opus in this approximate range. By recording the peer's incoming stream
directly into a MediaRecorder, we get a clean mono Opus file that's already
speaker-separated, already at voice-band quality, and needs only a single
`OfflineAudioContext` decode step before being fed to the model. No resampling
algorithm is needed.

### VOX detection and clock sync

**Why clock sync at all?**
Each browser has its own clock. Over a 60-minute podcast, drift can be tens of
milliseconds. The stitcher relies on `sessionStart` timestamps from both sides
to align the two WAV files. Without sync, the alignment would be off by
however much the clocks have drifted.

**How it works:**
- 4-sample NTP-style ping/pong on connect and every 5 seconds
- Each sample records client send time, server receive time, RTT
- The best half (lowest RTT) are averaged to produce `clockOffset`
- `serverNow() = Date.now() + clockOffset` is used for all timestamps

**VOX detection:**
- `AnalyserNode` sampling the local mic at animation frame rate
- Threshold: -40 dBFS (configurable via `VOX_THRESHOLD_DB` in `client.js`)
- Hold-off: 800ms after signal drops (configurable via `VOX_HOLD_MS`)
- Each speaking segment logged as `{ start, end }` in server-synced ms
- Segments sent to the peer via the server relay as `vox-start` / `vox-end` messages
- Both sides' VOX data saved in `*-meta.json` alongside each recording

VOX data serves two purposes: the stitcher uses it to verify alignment, and the
transcriber could use it in future to avoid running Whisper over silence.

### P2P file transfer

After recording stops, the HQ WAV and meta JSON can be sent to the peer via
SimplePeer's built-in data channel. Transfer uses 16KB chunks with a 5ms delay
between each to avoid flooding the channel. The receiving side reconstructs the
blob from chunks and triggers a download. File metadata (name, mime, size) is
sent via the server relay before the binary chunks begin.

### Stitching

The stitcher runs entirely in the browser using `OfflineAudioContext`. It:

1. Decodes both HQ audio files
2. Computes the time offset between the two sides using `sessionStart` from each meta JSON
3. Creates a stereo `OfflineAudioContext` at 48kHz
4. Pans Host → Left (-1), Guest → Right (+1)
5. Renders and exports as a 32-bit IEEE float WAV

The output is a clean dual-mono-in-stereo file that Audacity (or any DAW) can
split into two independent tracks for editing.

### Whisper WASM transcription

The transcription page (`/transcribe`) uses `@xenova/transformers` v2 loaded via
the jsDelivr CDN as an ES module — no build step, no npm install on the client.

Models available: tiny, tiny.en, base, base.en, small, small.en (75MB–466MB).
All are downloaded from HuggingFace on first use and cached in the browser
(IndexedDB via transformers.js's built-in caching).

The pipeline:
1. Each `*-whisper.webm` file is decoded to 16kHz mono Float32 via `OfflineAudioContext`
2. Fed to the ASR pipeline with `return_timestamps: true` and `chunk_length_s: 30`
3. Segments from both speakers are sorted by `start` time
4. Rendered as an interleaved speaker-attributed transcript
5. Exportable as `.txt`, `.srt`, or `.md`

**Browser requirement:** WASM SIMD is required. Chrome and Edge work. Firefox
works for recording but will fail on the transcription page.

**Why not the official whisper.cpp WASM?**
The official build requires `SharedArrayBuffer`, which in turn requires COOP/COEP
headers (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`).
These headers are already set on the server. However, the official WASM also
requires self-hosting the compiled `.js` and `.wasm` files — there is no CDN
distribution. `@xenova/transformers` uses ONNX Runtime WASM under the hood,
has a CDN-hosted distribution, and handles the same headers transparently.

---

## TLS / HTTPS — why it matters and what we built

### Why HTTPS is required (not optional)

WebRTC peer connections are **blocked by browsers on non-secure origins** except
for `localhost`. This means:

- `http://localhost:3000` → WebRTC works (dev only)
- `http://192.168.1.x:3000` → WebRTC **blocked** (getUserMedia will fail or return no audio)
- `http://yourdomain.com` → WebRTC **blocked**
- `https://yourdomain.com` → WebRTC works

Additionally, `navigator.mediaDevices.getUserMedia()` is gated on secure context.
Visiting the app over HTTP on any non-localhost address will result in a blank
`mediaDevices` object and no microphone access at all.

**The Let's Encrypt integration makes this server fully standalone.** Once
`setup-cert.sh` has been run, the server:
- Terminates TLS itself (no Nginx, no Caddy, no reverse proxy needed)
- Handles HTTP→HTTPS redirects on port 80
- Reloads certs on renewal without a restart
- Has no external runtime dependencies beyond Node.js and the npm packages

This means the entire stack — signaling, HTTPS, cert management, recording
coordination, P2P transfer, stitching, and transcription — runs from a single
`npm start` on a single machine.

### Three cert paths implemented

**`setup-cert.sh` — Let's Encrypt (recommended for public servers)**
- Requires: public domain, port 80 reachable from internet
- Runs `certbot certonly --standalone`
- Installs a post-renewal hook at `/etc/letsencrypt/renewal-hooks/post/`
- The hook touches `fullchain.pem` after each successful renewal
- The server watches `fullchain.pem` with `fs.watchFile` (polling interval: 60s)
- On change, calls `httpsServer.setSecureContext(freshCerts)` — zero downtime

**`import-cert.sh` — existing cert from any CA**
- Validates key/cert pair using openssl modulus comparison
- Checks cert expiry and warns if < 14 days remaining
- Extracts CN from cert for `cert.json`
- Works with wildcard certs, ZeroSSL, Buypass, internal CAs, etc.

**`self-signed-cert.sh` — LAN / internal use**
- Generates 2048-bit RSA cert with correct SANs for all local IPs
- Useful when running on a LAN without a public domain
- Browsers show a warning; clicking through or installing as trusted CA resolves it
- Run with `HTTPS_PORT=3443 npm start` to avoid needing sudo

### Server startup logic

```
cert.json present?
  yes → read key + cert files
    readable? 
      yes → start HTTPS on $HTTPS_PORT (443), redirect HTTP on $HTTP_PORT (80)
            watch fullchain.pem for renewal, reload via setSecureContext()
      no  → log error, fall back to HTTP
  no  → start HTTP on $PORT (3000) — dev mode
```

Port overrides: `HTTPS_PORT=8443 HTTP_PORT=8080 npm start`

---

## TURN server roadmap

### Why TURN is needed

WebRTC uses ICE (Interactive Connectivity Establishment) to find a path between
two peers. The process tries candidates in order:

1. **Host candidates** — direct connection using each peer's local IP
2. **Server Reflexive (STUN)** — the public IP/port as seen by a STUN server
3. **Relay (TURN)** — traffic routed through a TURN server when direct fails

STUN works in most cases. It fails when one or both peers are behind **symmetric NAT**
— common in corporate networks, mobile carriers, and some home routers. In this
case, a TURN server is the only way to establish a connection.

The current implementation uses Google's public STUN servers
(`stun.l.google.com:19302`, `stun1.l.google.com:19302`). No TURN is configured.
This means users behind symmetric NAT will get no audio and no data channel.

### Recommended open source solution: Coturn

**Coturn** (`https://github.com/coturn/coturn`) is the de facto standard open
source TURN server. It is mature, actively maintained, implements RFC 5766 (TURN),
RFC 5389 (STUN), RFC 6156 (IPv6), and RFC 8656 (TURN for WebRTC), and is
available in the package repositories of every major Linux distribution.

### Implementation plan

#### Phase 1 — Install and configure Coturn

```bash
# Ubuntu/Debian
sudo apt-get install coturn

# Enable the service
sudo systemctl enable coturn
```

Minimal `/etc/turnserver.conf`:
```
# Network
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=YOUR_PUBLIC_IP

# TLS — reuse the same Let's Encrypt cert
cert=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
pkey=/etc/letsencrypt/live/yourdomain.com/privkey.pem

# Credentials — use long-term credential mechanism
lt-cred-mech
user=podcaststudio:STRONG_PASSWORD_HERE

# Realm
realm=yourdomain.com

# Logging
log-file=/var/log/coturn/turnserver.log

# Security — restrict relay to audio/data port ranges only
min-port=49152
max-port=65535
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

Firewall rules needed:
```bash
ufw allow 3478/tcp   # TURN/STUN plaintext
ufw allow 3478/udp
ufw allow 5349/tcp   # TURN/STUN TLS
ufw allow 5349/udp
ufw allow 49152:65535/udp  # TURN relay ports
```

#### Phase 2 — Short-lived TURN credentials (recommended over static passwords)

Static TURN credentials are a security risk — anyone who finds them can use your
TURN server as a relay for arbitrary traffic, costing you bandwidth.

The WebRTC spec describes a **time-limited credential mechanism** (RFC 8489 §9.2):

```
username = timestamp:someIdentifier
password = HMAC-SHA1(sharedSecret, username) encoded as base64
```

The credential expires after `timestamp` passes. Coturn supports this natively
with `use-auth-secret` and a `static-auth-secret`.

Implementation in `server.js`:

```javascript
const crypto = require('crypto');

const TURN_SECRET = process.env.TURN_SECRET; // set in environment, never in code
const TURN_HOST   = process.env.TURN_HOST;   // e.g. 'yourdomain.com'
const TURN_TTL    = 3600; // credential valid for 1 hour

function generateTurnCredentials() {
  if (!TURN_SECRET || !TURN_HOST) return null;
  const expiry   = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = `${expiry}:podcaststudio`;
  const password = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');
  return { username, password, ttl: TURN_TTL };
}
```

Add a REST endpoint:
```javascript
app.get('/api/turn-credentials', (req, res) => {
  const creds = generateTurnCredentials();
  if (!creds) return res.json({ iceServers: [] });
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          `turn:${TURN_HOST}:3478`,
          `turn:${TURN_HOST}:3478?transport=tcp`,
          `turns:${TURN_HOST}:5349`,
        ],
        username: creds.username,
        credential: creds.password,
      },
    ],
  });
});
```

Coturn config for HMAC credentials:
```
use-auth-secret
static-auth-secret=SAME_SECRET_AS_TURN_SECRET_ENV
```

#### Phase 3 — Wire into SimplePeer

In `client.js`, replace the hardcoded `iceServers` array:

```javascript
// Fetch short-lived TURN credentials from the server
async function getIceServers() {
  try {
    const res = await fetch('/api/turn-credentials');
    const { iceServers } = await res.json();
    return iceServers.length ? iceServers : defaultIceServers();
  } catch {
    return defaultIceServers();
  }
}

function defaultIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
}

// In initPeer():
const iceServers = await getIceServers();
peer = new SimplePeer({ initiator, stream: localStream, trickle: true,
  config: { iceServers } });
```

#### Phase 4 — TURN cert auto-renewal

Since Coturn is sharing the Let's Encrypt cert, it needs to reload it too.
Add to the post-renewal hook (`/etc/letsencrypt/renewal-hooks/post/podcast-studio-reload.sh`):

```bash
# Reload Coturn after cert renewal
systemctl reload coturn 2>/dev/null || systemctl restart coturn 2>/dev/null || true
echo "[$(date)] Coturn reloaded" >> /var/log/podcast-studio-cert.log
```

#### Phase 5 — Monitoring

Coturn produces verbose logs. Useful things to watch:

```bash
# Live relay activity
tail -f /var/log/coturn/turnserver.log | grep -E "(session|allocation|permission)"

# Count active allocations (proxy for active calls using TURN)
grep "Creating new session" /var/log/coturn/turnserver.log | wc -l
```

For longer-term: Coturn has a Redis integration for distributed deployments and
supports Prometheus metrics via the `prometheus` build flag.

### Alternative TURN implementations

| Project | Language | Notes |
|---|---|---|
| **Coturn** | C | Most widely deployed, full RFC support, production-ready |
| **Pion TURN** | Go | Embeddable, clean API, good if you want TURN logic in a Go service |
| **node-turn** | Node.js | Lightweight, same runtime as this server, limited production use |
| **eturnal** | Erlang | High concurrency, used by Matrix/Element, excellent for scale |

For a two-person podcast tool, Coturn on the same machine as the Node server
is the most practical choice. If you expect many simultaneous sessions or want
geographic distribution, eturnal or a managed TURN service (Twilio, Metered.ca)
are worth considering.

### Cost / bandwidth note

TURN relay doubles the bandwidth for any call that uses it. For a 32kbps Opus
stream (the monitoring path), that's ~64kbps per active relayed call — negligible.
The HQ WAV files are not transmitted via TURN (they go via the P2P data channel
after the call ends, once the TURN allocation may have already closed). If the
data channel also falls back to TURN, a 50MB WAV file would cost ~50MB of TURN
egress — still reasonable but worth being aware of.

---

## Known limitations and future work

### Current limitations

- **Two participants only.** The room model (`host` + `guest`) is hard-coded for
  exactly two people. Extending to N participants would require a mesh or SFU
  architecture. For podcast use this is rarely needed.

- **No reconnection.** If a peer disconnects mid-recording, there is no automatic
  reconnect. The VOX hold-off (800ms) means a brief dropout is bridged, but a
  full disconnection requires re-loading the page.

- **Rooms are in-memory only.** A server restart loses all active rooms. In
  practice this means ongoing calls drop if you restart the server. This is
  acceptable for a single-server setup.

- **No TURN.** See roadmap above.

- **Whisper transcription is Chrome/Edge only.** Firefox does not support WASM
  SIMD which `@xenova/transformers` requires.

- **MediaRecorder codec availability varies by browser.** The HQ recorder tries
  WAV → PCM WebM → Ogg FLAC → Opus WebM in preference order. On Firefox, WAV
  is not supported by MediaRecorder and it falls back to Ogg Opus. The stitcher
  handles all of these via `OfflineAudioContext.decodeAudioData`.

### Potential next steps (beyond TURN)

- **N-party support** via a simple SFU. Mediasoup and Pion are both good options.
  The signaling server would need to become a proper room router.

- **Reconnection logic** — save the `sessionStart` and `voxSegments` state to
  `sessionStorage` so a page reload can resume recording into the same session
  with correct timestamps.

- **Speaker diarization** — the Whisper pipeline in `transcribe.html` sorts
  segments by timestamp but could be improved by using the VOX segment data
  from `meta.json` to assign speaker labels more precisely, rather than relying
  purely on Whisper's timestamp output.

- **Real-time transcription** — the stream mode of `@xenova/transformers` can
  produce rolling transcription during the call. This would require the Whisper
  recorder to feed chunks to the pipeline in real time rather than saving to a
  blob.

- **systemd service file** — for production deployment, a `podcast-studio.service`
  file that starts the server on boot, restarts on crash, and limits filesystem
  access would be appropriate.

- **Rate limiting** — the `/api/create-room` endpoint has no rate limiting.
  A simple token bucket or `express-rate-limit` middleware would prevent abuse.

---

## Roadmap: Editor/Publisher role and asymmetric file exchange

### Motivation

Currently both participants send their uncompressed HQ audio to each other
symmetrically. In practice, podcast workflows are asymmetric: one person is the
editor. They need the guest's raw audio; the guest has no use for the editor's
raw audio — they just want the finished episode.

The proposed model flips the data flow:

```
Current:  Host ──HQ WAV──► Guest
          Host ◄──HQ WAV── Guest

Proposed: Host (editor) ◄──HQ WAV── Guest
          Host (editor) ──MP3──────► Guest  (after processing)
```

The guest's machine never has to upload a large file to a stranger's server,
never has to keep the editor's raw audio around, and gets back a finished file
rather than a raw track.

### Role negotiation

A third role flag needs to be introduced alongside `host`/`guest`: `editor`.
This is independent of who created the room — either participant should be able
to be designated editor. The cleanest approach is a UI toggle in the room,
propagated to the peer via a `peer-msg` once both sides have connected:

```javascript
// New peer message types
{ type: 'role-update', editor: true  }   // "I am the editor"
{ type: 'role-update', editor: false }   // "I am the talent"
```

Both sides maintain a local `peerIsEditor` flag. Only one side should be editor
at a time — the UI should enforce this as a mutual exclusion (selecting editor
on one side automatically signals the other to deselect).

State the server needs to know: **nothing**. This is purely a P2P negotiation.
The signaling server relays the `peer-msg` as normal.

### Editor-side behaviour

When the editor flag is set:

1. **Do not offer to send your own HQ WAV to the peer.** The `exportHQ()` function
   currently prompts `confirm('Send your HQ recording to peer?')`. When the local
   user is editor, suppress this prompt entirely. The editor keeps their own HQ
   audio locally for the stitch but the guest never needs it.

2. **Automatically accept and save the peer's HQ WAV** when it arrives via the
   data channel. No prompt needed — this is expected behaviour.

3. **After processing** (stitching, editing, export to MP3), offer to send the
   finished MP3 back to the guest via the data channel.

### Guest-side behaviour

When the peer is editor:

1. **Send your HQ WAV to the peer** (the editor) automatically after recording
   stops. No prompt — the guest has already implicitly consented by joining a
   session with a nominated editor.

2. **Optionally retain your own HQ WAV locally.** Present a checkbox before
   recording starts: "Keep a local copy of my uncompressed recording." Defaulting
   to `true` is the safe choice — disk space is cheap, and if the editor's
   machine crashes mid-transfer the guest still has the raw audio.

3. **Receive and download the finished MP3** from the editor when it arrives.

### MP3 encoding in the browser

The browser has no native MP3 encoder. Two practical options:

**Option A: lamejs (pure JS, no WASM)**
`lamejs` is a JavaScript port of LAME. It is slow (roughly 10–20x realtime on
a modern machine for a 60-minute episode) but requires no build step and no
server involvement. Suitable for files up to ~30 minutes; longer sessions will
feel sluggish.

```javascript
// CDN: https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js
import lamejs from 'lamejs';

function encodeToMp3(audioBuffer, bitrateKbps = 192) {
  const encoder = new lamejs.Mp3Encoder(
    audioBuffer.numberOfChannels,
    audioBuffer.sampleRate,
    bitrateKbps
  );
  // Convert Float32 [-1,1] to Int16
  const samples = float32ToInt16(audioBuffer.getChannelData(0));
  const chunks  = [];
  const BLOCK   = 1152;
  for (let i = 0; i < samples.length; i += BLOCK) {
    const buf = encoder.encodeBuffer(samples.subarray(i, i + BLOCK));
    if (buf.length > 0) chunks.push(new Int8Array(buf));
  }
  chunks.push(new Int8Array(encoder.flush()));
  return new Blob(chunks, { type: 'audio/mpeg' });
}
```

**Option B: ffmpeg.wasm**
`@ffmpeg/ffmpeg` runs a full FFmpeg build in WASM. Much faster than lamejs,
supports any output format, but the WASM binary is ~30MB and requires the same
`SharedArrayBuffer` headers already set on this server. Good choice if the
server is already configured for WASM (it is — COOP/COEP headers are set).

```javascript
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';
const ffmpeg = createFFmpeg({ log: false });
await ffmpeg.load();
ffmpeg.FS('writeFile', 'input.wav', await fetchFile(wavBlob));
await ffmpeg.run('-i', 'input.wav', '-b:a', '192k', 'output.mp3');
const mp3Data = ffmpeg.FS('readFile', 'output.mp3');
const mp3Blob = new Blob([mp3Data.buffer], { type: 'audio/mpeg' });
```

**Recommendation:** Use ffmpeg.wasm. The WASM headers are already set, the
quality and speed are superior, and it gives the editor the flexibility to
choose bitrate, apply EQ/normalisation flags, or output to other formats
(AAC, Ogg) in future without changing the plumbing.

### Handling the transfer back

The existing `sendFileToPeer` / `handleDataChannel` / `finaliseIncomingFile`
infrastructure handles arbitrary binary files. Sending an MP3 back uses the
same path — just a different mime type (`audio/mpeg`) and filename
(`episode-final.mp3`). No new transport code needed.

---

## Roadmap: VOX-gated transfer with lossless compression

### Motivation

A 60-minute podcast recorded at 48kHz / 32-bit float is approximately:
```
48000 samples/sec × 4 bytes × 3600 sec = ~691 MB
```

Much of that is silence. In a typical two-person podcast, each speaker is active
for perhaps 40–50% of the total duration. The other 50–60% is silence while
listening to the other person. Sending that silence across the P2P data channel
is wasteful and slows the post-session transfer significantly.

The VOX segment data already logged during recording gives us precise knowledge
of exactly which time ranges contain speech. We can use this to:

1. Transfer only the speech regions (plus safety margins) at HQ
2. Reconstruct silence from the low-grade Opus copy already received live
3. Compress the speech segments losslessly before transfer

### The three categories of audio to handle

After recording stops, each time region of the HQ WAV falls into one of three
categories:

| Category | Definition | Transfer strategy |
|---|---|---|
| **Active speech** | Within a VOX segment | Transfer at HQ, compressed losslessly |
| **Near-silence margin** | Within N ms of a VOX segment edge | Transfer at HQ (safety buffer for attacks/decays) |
| **Deep silence** | Beyond the margin from any VOX segment | Do not transfer — reconstruct from Opus |

The margin (call it `VOX_TRANSFER_MARGIN_MS`) should be generous — 500ms either
side of each VOX segment start and end is a reasonable default. This captures
breath sounds, mouth clicks, and the natural envelope of consonant attacks that
VOX detection often clips. It is better to transfer slightly too much at HQ than
to lose the start of a word.

### Segment map construction

Before transfer begins, build a merged list of transfer regions from the
`voxSegments` array in the local `meta.json`:

```javascript
function buildTransferRegions(voxSegments, sessionStart, audioDurationMs, marginMs = 500) {
  // Convert server-synced absolute timestamps to offsets from sessionStart
  const regions = voxSegments
    .filter(s => s.end !== null)
    .map(s => ({
      start: Math.max(0, (s.start - sessionStart) - marginMs),
      end:   Math.min(audioDurationMs, (s.end - sessionStart) + marginMs),
    }));

  // Merge overlapping or adjacent regions
  regions.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of regions) {
    if (merged.length && r.start <= merged.at(-1).end) {
      merged.at(-1).end = Math.max(merged.at(-1).end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;  // [{ start, end }] in ms, relative to sessionStart
}
```

### Extraction and lossless compression

Each region is extracted from the decoded `AudioBuffer` as a raw PCM slice,
then compressed. Three options in increasing complexity:

**Option A: gzip via DecompressionStream (browser-native, no libraries)**

The `CompressionStream` / `DecompressionStream` API (available in Chrome 80+,
Firefox 113+, Safari 16.4+) provides gzip and deflate natively:

```javascript
async function gzipBlob(blob) {
  const stream     = blob.stream().pipeThrough(new CompressionStream('gzip'));
  const compressed = await new Response(stream).blob();
  return compressed;
}

async function gunzipBlob(blob) {
  const stream       = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  const decompressed = await new Response(stream).blob();
  return decompressed;
}
```

For raw PCM audio (32-bit float, essentially random-looking data), gzip typically
achieves 10–20% compression for speech and near-zero for complex audio. It is
better than nothing and requires no dependencies. **Use this as the baseline.**

**Option B: FLAC via flac.wasm**

FLAC is a lossless audio codec specifically designed for PCM. It achieves 40–60%
compression on speech audio by exploiting inter-sample correlations that gzip
cannot see. There is no browser-native FLAC encoder, but `flac.wasm` (a
WebAssembly port) is available:

- `libflac.js` (by Dietrich Ayala): https://github.com/mmig/libflac.js
- Produces standard `.flac` files readable by any audio tool
- Requires the same WASM infrastructure already present (COOP/COEP headers set)

The workflow:
```javascript
// Pseudocode — actual libflac.js API is callback-based
const encoder = Flac.create_libflac_encoder(
  sampleRate,    // 48000
  channels,      // 1
  bitDepth,      // 32 (note: FLAC supports up to 32-bit int, not float)
  compressionLevel, // 5 — good balance of speed vs ratio
  0              // total samples (0 = unknown/streaming)
);
```

**Important:** FLAC operates on integer PCM, not IEEE float. The 32-bit float
samples from `AudioBuffer.getChannelData()` need to be converted to 24-bit
integer before encoding, then back to float on decode. This is lossless for
all practical purposes — 24-bit integer has more dynamic range than any
microphone produces.

**Option C: Shorten / WavPack / SHN**

These are more exotic lossless codecs. No browser WASM ports currently exist.
Not recommended unless building a native app companion.

**Recommendation:** Ship Option A (gzip via `CompressionStream`) first — zero
dependencies, browser-native, catches the easy wins. Add Option B (FLAC) as a
follow-up enhancement behind a settings toggle. The transfer infrastructure is
the same either way; only the compression/decompression step changes.

### Transfer protocol changes

The existing file transfer sends a single monolithic blob. With VOX-gated
transfer, the protocol needs to become segment-aware:

```
Sender                              Receiver
  │                                    │
  ├─── file-meta ────────────────────► │  { name, totalRegions, sessionStart,
  │                                    │    sampleRate, sampleFormat, mime }
  │                                    │
  ├─── segment-meta ─────────────────► │  { index, startMs, endMs,
  │                                    │    compressedSize, uncompressedSize }
  ├─── [binary chunk 0] ─────────────► │
  ├─── [binary chunk 1] ─────────────► │
  ├─── ...                             │
  │                                    │
  ├─── segment-meta ─────────────────► │  { index: 1, startMs, endMs, ... }
  ├─── [binary chunks] ──────────────► │
  ├─── ...                             │
  │                                    │
  ├─── file-done ────────────────────► │  { totalRegions, silenceRegions }
  │                                    │
```

`silenceRegions` in `file-done` tells the receiver which time ranges were
**not** transferred — these are the gaps to fill with reconstructed silence.

### Silence reconstruction

For the silence gaps, the receiver has two options:

**Option A: True silence (zero samples)**
Simplest. Insert zero-valued samples for the duration of the gap. The resulting
file will have abrupt transitions at region boundaries, which is fine since these
gaps will be edited out anyway. This is the correct default.

**Option B: Ambient noise reconstruction from the Opus copy**

The receiver already has `*-whisper.webm` — the 32kbps Opus recording of the
sender's voice received live during the call. This contains the silence periods
too, encoded at low quality. For the silence gaps, decode the corresponding
region from the Opus copy and use it to fill in. This preserves room tone
(background ambience, HVAC hum, subtle reverb) which makes editing easier —
silence that sounds like the room is more forgiving to cut than digital zero.

```javascript
async function reconstructSilenceFromOpus(opusBlob, gapStartMs, gapEndMs, targetSampleRate) {
  // Decode the full Opus file
  const ctx    = new OfflineAudioContext(1,
    Math.ceil((gapEndMs - gapStartMs) / 1000 * targetSampleRate),
    targetSampleRate);
  const fullBuf = await ctx.decodeAudioData(await opusBlob.arrayBuffer());

  // Extract the relevant time region
  const startSample = Math.floor(gapStartMs / 1000 * targetSampleRate);
  const endSample   = Math.floor(gapEndMs   / 1000 * targetSampleRate);
  const sliceLen    = Math.min(endSample - startSample, fullBuf.length - startSample);

  const silence = new AudioBuffer({
    length:           sliceLen,
    numberOfChannels: 1,
    sampleRate:       targetSampleRate,
  });
  silence.copyToChannel(fullBuf.getChannelData(0).slice(startSample, startSample + sliceLen), 0);
  return silence;
}
```

This is the preferred approach when the Opus file is available (it always will
be if both sides completed recording). The quality difference in the silence
regions is imperceptible and the editing experience is meaningfully better.

### Reassembly

After all segments are received and silence gaps are filled, the receiver
assembles the full `AudioBuffer` in order and re-exports it as a WAV (or passes
it directly to the stitcher). The result is indistinguishable from the original
full-quality recording — speech at full 48kHz/32-bit, silence at room-tone
fidelity.

### Estimated transfer savings

For a 60-minute podcast where each speaker talks for ~45% of the total duration:

| Approach | Approx. transfer size |
|---|---|
| Full HQ WAV uncompressed | ~691 MB |
| Full HQ WAV + gzip | ~600–650 MB (10–15% gain on PCM float) |
| VOX-gated PCM + gzip | ~330 MB (speech only, 45% of duration) |
| VOX-gated + FLAC | ~150–200 MB (FLAC ~50% compression on speech PCM) |

The VOX-gated FLAC approach reduces transfer size by roughly **75–80%** compared
to the naive full-file transfer, with zero quality loss on the speech regions
and imperceptible quality in the silence regions.

### Implementation order

1. **Add `buildTransferRegions()`** to `client.js` — pure function, testable in isolation
2. **Add `gzipBlob()` / `gunzipBlob()`** — browser-native, no deps
3. **Modify `exportHQ()` / `sendFileToPeer()`** to extract and compress regions
4. **Modify `handleDataChannel()` / `finaliseIncomingFile()`** to handle the
   segment-aware protocol and reassemble with silence reconstruction
5. **Add FLAC compression** as an optional enhancement behind a settings toggle
6. **Add the editor/publisher role** UI and the MP3 export step

Steps 1–4 are self-contained changes to `client.js` and do not require any
server changes. Step 6 adds a UI element to `index.html` and a small addition
to the peer negotiation protocol.

---

## Roadmap: In-browser session store + direct-to-folder saving

### Motivation

Today, when recording stops the app **auto-downloads** each artifact
(`*-hq.*`, `*-meta.json`, `*-whisper.webm`) to the browser's Downloads folder,
and the `/transcribe` and Stitch flows make the user **re-pick those files with a
file dialog**. After a few sessions the Downloads folder fills with
near-identically named files and it's easy to feed the wrong one into the
transcriber. Two complementary improvements remove the round trip.

### Part A — IndexedDB session store (auto-load transcribe/stitch)

`/transcribe` is a separate document, so in-memory blobs don't survive the
navigation from the room. Persist them in **IndexedDB** instead (it stores large
`Blob`s directly and survives navigation/reload):

- On stop, write each artifact — the local `hq`/`whisper`/`meta` **and** the
  peer's files as they arrive (data channel or R2) — into an object store keyed
  by session, e.g. `${roomToken}/${role}/${kind}`.
- `/transcribe` and Stitch open with a **session picker** (labelled by time +
  participants); selecting one auto-loads the correct files. The manual file
  picker stays as a fallback.
- A small **session manager** (list / delete / clear-all) keeps old recordings
  from piling up.

Client-only; no server changes. Suggested surface: a tiny `idb.js` helper
(`putFile`, `listSessions`, `getSession`, `deleteSession`) shared by `client.js`
and `transcribe.html`.

### Part B — Direct-to-folder saving (File System Access API)

Where supported (Chrome/Edge), let the user **choose an output folder once** and
have recordings written there automatically, instead of dumping into Downloads:

- `showDirectoryPicker()` returns a `FileSystemDirectoryHandle`; persist it in
  IndexedDB so the choice is remembered across sessions (re-prompt for access
  with `handle.requestPermission()` on return).
- On stop: `dirHandle.getFileHandle(name, { create: true })` → `createWritable()`
  → write the blob — no per-file dialog.
- Graceful fallback: browsers without the API (Firefox/Safari) keep the current
  download behaviour, ideally behind an opt-in "Save to disk" button.

Parts A and B compose: IndexedDB is the in-app source of truth for
transcribe/stitch; the folder handle is the optional durable on-disk copy.

---

## Roadmap: WebGPU transcription (WASM fallback)

### Motivation

`/transcribe` currently runs Whisper on **WebAssembly** via
`@xenova/transformers@2.17.2` (ONNX Runtime Web, multi-threaded WASM + SIMD —
CPU-bound). **WebGPU** typically runs Whisper **10–50× faster** and is what makes
on-device transcription practical on **mobile**. v2.17.2 has no production WebGPU
backend, so this is a version bump, not a flag.

### Plan

- **Upgrade the library** from `@xenova/transformers@2.x` to **transformers.js v3
  (`@huggingface/transformers`)**, which has a first-class WebGPU backend. (API is
  largely compatible; verify the `pipeline` + `env` calls in `transcribe.html`.)
- **Select the backend at runtime with a fallback:**
  ```js
  const hasWebGPU = 'gpu' in navigator && !!(await navigator.gpu?.requestAdapter());
  const transcriber = await pipeline('automatic-speech-recognition', model, {
    device: hasWebGPU ? 'webgpu' : 'wasm',
    dtype:  hasWebGPU ? 'q4' : 'q8',   // quantized weights; tune per model/quality
  });
  ```
  Surface which path was chosen in the UI (WebGPU vs WASM) so slow runs are
  explainable.
- **Keep the WASM path fully working** — Firefox and older Safari lack WebGPU, and
  the app already supports WASM. Retain `COOP/COEP` so the WASM fallback stays
  multi-threaded.
- **Re-check cross-origin isolation** — WebGPU itself doesn't need SharedArrayBuffer,
  but the WASM fallback does; `credentialless` already covers both.
- **Note on model/dtype:** WebGPU favours `fp16`/`q4`; validate transcript quality
  vs. the current WASM output on the `tiny`/`base` models before defaulting.

Self-contained to `transcribe.html` (plus the CDN import URL). Pairs naturally
with the mobile-UX pass, since WebGPU is what makes phone transcription usable.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port (dev/no-cert mode only) |
| `HTTP_PORT` | `80` | HTTP redirect port (HTTPS mode) |
| `HTTPS_PORT` | `443` | HTTPS listening port |
| `TURN_SECRET` | — | HMAC secret for short-lived TURN credentials (Phase 2) |
| `TURN_HOST` | — | Hostname of TURN server (Phase 2) |

---

## Dependencies

```json
{
  "express": "^4.18.2",   // HTTP server and static file serving
  "ws":      "^8.16.0",   // WebSocket server
  "nanoid":  "^3.3.7"     // Room token generation (URL-safe, 12 chars)
}
```

Client-side (CDN, no build step):
- `simple-peer@9.11.1` — WebRTC wrapper (cdnjs)
- `@xenova/transformers@2.17.2` — Whisper WASM (jsDelivr)
- Google Fonts — Space Mono + Syne (typography)

Proposed additions (roadmap features):
- `lamejs@1.2.1` or `@ffmpeg/ffmpeg` — MP3 encoding (editor role)
- `libflac.js` — FLAC lossless compression (VOX-gated transfer, optional)
- `CompressionStream` — gzip baseline compression (browser-native, no CDN needed)

---

*Last updated to include editor/publisher role roadmap and VOX-gated lossless
transfer roadmap. All features above this line are fully implemented.*

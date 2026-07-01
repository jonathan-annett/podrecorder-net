# HANDOVER.md — Audit & Onboarding for the Incoming Agent

**To:** Claude Opus 4.8, running as a command-line agent on macOS
**From:** the previous session (browser-based, sandboxed Linux container)
**Purpose:** Get you up to speed on this project, honestly. This is not a
sales pitch for the code — it is an audit. It tells you what works, what is
untested, and what is actually broken, with the evidence for each claim.

Read this file first, then `CLAUDE.md` for the deep design rationale and the
roadmap. Where this file and `CLAUDE.md` disagree, **this file wins** —
`CLAUDE.md` describes intent, this file describes verified reality.

---

## 1. TL;DR of project state

This is a two-person P2P podcast recording studio: a Node.js signaling server
plus a browser client that does WebRTC audio, local high-quality recording,
VOX detection, clock sync, P2P file transfer, browser-side stitching, and
in-browser Whisper transcription. There is also TLS cert tooling
(Let's Encrypt / import / self-signed).

**What I verified actually works** (ran it in the container):
- Server boots cleanly, all REST endpoints respond correctly
- `node --check` passes on `server.js` and `client.js`
- `bash -n` passes on all three cert scripts
- Room creation, room lookup, `/transcribe` routing, COOP/COEP headers all confirmed

**What I could NOT verify** (no browser, no mic, no second peer, CDN blocked in
sandbox): the entire real-time WebRTC path, recording, VOX, stitching,
transcription, and P2P transfer. None of the browser-side logic has ever been
run. Treat all of it as "written but untested".

**What is probably broken** (found by reading, not running — see §3):
1. **COEP header very likely breaks SimplePeer loading on the main page** (high severity)
2. **Mic-before-peer ordering bug** silently prevents WebRTC connection (high severity)
3. **Cert scripts are Linux-only** and you are on a Mac (high severity for those scripts)
4. Several medium/low issues listed in §3

---

## 2. How to run it (macOS specifics)

```bash
cd podcast-studio
npm install
npm start          # → http://localhost:3000
```

Node's built-in APIs are fine on macOS. The **server** has no Linux
dependencies — it will run on your Mac as-is. Only the **cert shell scripts**
are Linux-specific (see §3.3).

WebRTC works on `http://localhost` without HTTPS, so for local dev on the Mac
you do not need any cert. You only need HTTPS to test across two real machines
or over a LAN address.

To actually exercise the app you need **two browser tabs/windows** (or two
devices): one creates a room, the other joins via the room link. A single tab
cannot test the peer connection.

---

## 3. The audit — bugs and risks, most severe first

### 3.1 [HIGH] COEP `require-corp` likely blocks the CDN scripts

`server.js` sets these headers on **every** route:

```js
res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
```

These are required **only** by the `/transcribe` page, because Whisper WASM
needs `SharedArrayBuffer`. But they are applied globally, including to the main
studio page (`/`).

Under `Cross-Origin-Embedder-Policy: require-corp`, every cross-origin
subresource must either be same-origin or explicitly opt in via CORP / a
`crossorigin` attribute on the tag. The main page loads SimplePeer like this:

```html
<!-- index.html line 402 — NO crossorigin attribute -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/simple-peer/9.11.1/simplepeer.min.js"></script>
```

There is no `crossorigin` attribute. **This will very likely be blocked by the
browser**, meaning `SimplePeer` is undefined, meaning `initPeer()` throws, meaning
the entire WebRTC flow never starts. I could not confirm this live because the
sandbox cannot reach cdnjs (both cdnjs and jsDelivr returned 403 from here), so
verify it yourself on the Mac — open the main page, check the console for a
"blocked by CORP" / "ERR_BLOCKED_BY_RESPONSE" error and whether `SimplePeer`
is defined.

**Recommended fixes (pick one):**

- **Best:** scope the COOP/COEP headers to `/transcribe` only. The main studio
  page does not need them. Something like:
  ```js
  app.get('/transcribe', (req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  }, (req, res) => res.sendFile(path.join(__dirname, 'public', 'transcribe.html')));
  ```
  and remove the global middleware. Watch out: the static middleware serves
  `transcribe.html` too, so you may need to also gate the static serve or rename
  the transcribe route so the headers reliably attach.

- **Alternative:** keep global headers but add `crossorigin="anonymous"` to the
  SimplePeer script tag AND confirm cdnjs sends `Access-Control-Allow-Origin: *`
  (it normally does). Same for the jsDelivr import on the transcribe page.

- **Most robust:** vendor both libraries locally (download `simplepeer.min.js`
  and the transformers dist into `public/vendor/`) so everything is same-origin
  and COEP is a non-issue. This also removes the runtime CDN dependency, which
  is good for a self-hosted tool anyway.

### 3.2 [HIGH] Mic-before-peer ordering bug prevents connection

`initPeer()` bails immediately if the mic has not been granted yet:

```js
function initPeer(initiator) {
  if (!localStream) { log('No mic stream — get mic first', 'error'); return; }
  ...
}
```

`initPeer()` is called from the `peer-joined` WebSocket event. That event fires
the moment the second participant's WebSocket connects — which can easily happen
**before** either user has clicked "Get Mic". If `localStream` is null at that
moment, `initPeer` returns early and **there is no retry**. The WebRTC connection
then never forms, with only a red log line as a symptom.

The happy path (both users click Get Mic, then the second joins) works. Any
other ordering silently fails.

**Recommended fix:** make mic acquisition a precondition for joining the room —
e.g. auto-request the mic on room load, or gate the "ready" signal to the server
until the mic is granted, so `peer-joined` only fires when both sides have a
stream. Alternatively, store a `pendingPeerInit` flag and call `initPeer()` from
`getMic()` once the stream arrives if a peer already joined.

### 3.3 [HIGH — for you specifically] Cert scripts are Linux-only

You are on macOS. The cert scripts assume Linux:

- `setup-cert.sh` uses `apt-get`, `systemctl`, `ss -tlnp` — none exist on stock macOS
- `self-signed-cert.sh` uses `hostname -I` (Linux) — macOS uses `ipconfig getifaddr en0` or `ifconfig`
- `import-cert.sh` uses `date -d` but already has a BSD `date -j` fallback, so it's the most portable of the three

`bash -n` passes on all three (syntax is valid), but they will fail at runtime on
macOS at the first Linux-only command.

**Guidance:**
- For local Mac dev you do not need any of these — `http://localhost:3000` is enough.
- `import-cert.sh` will mostly work on macOS (openssl is present; the date logic
  has a BSD fallback).
- `self-signed-cert.sh` needs `hostname -I` replaced with a macOS IP lookup
  (`ipconfig getifaddr en0`) and produces a cert that works fine with macOS openssl.
- `setup-cert.sh` is for a Linux production server. If the intended deployment
  target is Linux, leave it alone. If you'll deploy on the Mac, install certbot
  via Homebrew (`brew install certbot`) and strip the apt/systemctl branches, or
  switch to Homebrew's `brew services` for renewal.

### 3.4 [MEDIUM] `exportHQ` crashes if no MediaRecorder mime matched

```js
const hqMime = hqMimes.find(m => MediaRecorder.isTypeSupported(m)) || '';
...
hqRecorder.onstop = () => exportHQ(hqMime);   // hqMime can be ''
...
async function exportHQ(mime) {
  ...
  const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'webm';
```

If no candidate mime is supported, `hqMime` is `''`. `''.includes('wav')` is
`false` so `ext` resolves to `'webm'` — that part is safe. But if `mime` were
ever `undefined` (not the case today, but fragile), `.includes` would throw.
Low blast radius now, worth hardening if you touch this. The real-world risk is
different per browser: Chrome supports `audio/webm;codecs=opus` but **not**
`audio/wav` in MediaRecorder, so the HQ "lossless WAV" is in practice an Opus
webm on Chrome. See §3.7.

### 3.5 [MEDIUM] Stitcher decodes at 48 kHz regardless of source rate

```js
const tmpCtx  = new OfflineAudioContext(1, 1, 48000);
const hostBuf = await tmpCtx.decodeAudioData(...);
```

`decodeAudioData` resamples to the context's rate (48 kHz), which is the intent.
But if a recording came in at another rate, the resample happens silently. Fine
in practice, just be aware alignment math assumes 48 kHz throughout.

### 3.6 [MEDIUM] "Lossless" HQ recording is codec-dependent

`CLAUDE.md` and the UI describe the HQ path as lossless WAV/PCM. On Chrome,
`MediaRecorder` does **not** support `audio/wav` or PCM — it will fall through
the preference list to `audio/webm;codecs=opus`, which is **lossy**. Firefox
supports Ogg but also not WAV. So the "lossless master" claim is only true on
browsers that support a lossless MediaRecorder mime, which in practice is
rare-to-none for MediaRecorder today.

If true lossless capture matters, the recording path needs to move to an
`AudioWorklet` capturing raw Float32 frames and encoding WAV/FLAC manually —
this is a meaningful rework, not a config tweak. Flag this expectation with the
user before promising lossless output.

### 3.7 [LOW] `transcribe.html` uses `callback_function` — may be a no-op

The transcribe pipeline passes `callback_function` for streaming progress. This
option name has changed across `@xenova/transformers` versions and may be
ignored in 2.17.2. Non-fatal — worst case the per-chunk progress bar doesn't
update. Verify against the installed version's API if you rely on it.

### 3.8 [LOW] No reconnection / in-memory rooms

Documented in `CLAUDE.md` §Known limitations and true: rooms live in a `Map`,
a server restart drops all sessions, and a mid-call disconnect has no auto
reconnect. Acceptable for the current scope; don't be surprised by it.

### 3.9 [LOW] `pickFile` has no cancel handling

The stitcher's `pickFile()` resolves only on `change`. If the user cancels the
file dialog, the promise never resolves and the stitch flow hangs. Minor UX bug.

---

## 4. What each file is, and how much to trust it

| File | Verified? | Trust | Notes |
|---|---|---|---|
| `server.js` | Ran it | High | Boots, endpoints work, headers set. Only concern is the global COEP scope (§3.1). |
| `public/client.js` | Syntax only | Low | Never executed in a browser. Contains §3.1, §3.2, §3.6 issues. |
| `public/index.html` | Read only | Low | SimplePeer script tag missing `crossorigin` (§3.1). |
| `public/transcribe.html` | Read only | Low | Whole Whisper path unexecuted. §3.7. |
| `setup-cert.sh` | `bash -n` only | Low on macOS | Linux-only commands (§3.3). |
| `import-cert.sh` | `bash -n` only | Medium | Most portable; has BSD date fallback. |
| `self-signed-cert.sh` | `bash -n` only | Low on macOS | `hostname -I` is Linux-only (§3.3). |
| `package.json` | Ran `npm install` | High | Deps install clean. `nanoid ^3.3.7` is correct (v3 is CJS; v4+ is ESM-only and would break `require`). Keep it pinned to v3. |
| `CLAUDE.md` | Read only | Design intent, not verified reality | Roadmap is sound; treat feature descriptions as "intended", cross-check against this file. |

---

## 5. Suggested first moves for you (the incoming agent)

Do these in order — they turn "written but unverified" into "known good":

1. **`npm install && npm start`, open two browser tabs**, create a room in one,
   join in the other. Open both consoles. This one test surfaces §3.1 and §3.2
   immediately.

2. **If SimplePeer is undefined / CORP-blocked (§3.1):** apply the header-scoping
   fix or vendor the libraries locally. This is almost certainly your first real
   task.

3. **Test the mic ordering (§3.2):** try joining *before* clicking Get Mic on
   either side. If the connection fails, implement the mic-precondition fix.

4. **Only then** test recording → stop → the four downloaded files → stitch →
   transcribe, end to end. Expect the "lossless" claim (§3.6) to actually be
   Opus on Chrome; decide with the user whether that matters.

5. **Ignore the cert scripts** unless/until you deploy off-localhost. When you
   do, confirm the deploy target OS — if Linux, the scripts are fine; if macOS,
   port them per §3.3.

6. When you fix things, keep `CLAUDE.md`'s roadmap in mind — the user has
   already specced an editor/publisher role and a VOX-gated compressed-transfer
   feature. Those are the intended next big features once the base path is
   verified working. Details are in `CLAUDE.md` under "Roadmap".

---

## 6. Environment notes for the sandbox this came from

The previous session ran in a restricted Linux container:
- No browser, no audio devices, no second peer — so nothing browser-side was ever run
- Outbound network was allowlisted; cdnjs and jsDelivr were **not** reachable
  (both returned 403), which is why the CDN/COEP interaction could not be tested
- Everything was developed by reasoning + syntax checks, not by execution

You have a real macOS machine with a real browser. You can verify everything the
previous session could only reason about. Please do — the browser-side code has
never once been run.

---

## 7. One-line status per subsystem

- **Signaling server:** verified working.
- **REST API (rooms):** verified working.
- **TLS/HTTPS server logic:** boots in HTTP mode verified; HTTPS path unexecuted (no certs in sandbox).
- **WebRTC / SimplePeer:** unverified; blocked by two likely-high-severity bugs (§3.1, §3.2).
- **Recording (HQ + 2× Whisper):** unverified; "lossless" claim is optimistic (§3.6).
- **VOX + clock sync:** unverified; logic reads correctly.
- **P2P file transfer:** unverified; logic reads correctly.
- **Stitching:** unverified; minor sample-rate + cancel caveats.
- **Whisper transcription:** unverified; depends on CDN + COEP (§3.1) and a possibly-stale callback option (§3.7).
- **Cert scripts:** syntax-valid; Linux-only, need porting for macOS (§3.3).

Good luck. The architecture is sound and the design docs are genuinely useful —
but treat the browser client as a first draft that compiles, not as working
software, until you've run it.

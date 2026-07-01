# 🎙 podrecorder.net

A two-person, peer-to-peer podcast recording studio that runs on **Cloudflare
Workers**. Each speaker records locally in high quality; audio flows directly
between the two browsers over WebRTC. Recordings are stitched into a stereo
master and transcribed with Whisper — **all in the browser**. The server relays
signaling only; it is never in the audio path.

## Architecture

```
                 podrecorder.net  —  one Cloudflare Worker
  ┌───────────────────────────────────────────────────────────┐
  │  Static PWA assets (index.html, client.js, transcribe.html) │
  │  GET  /ws?token=…          → Room Durable Object (signaling) │
  │  GET  /api/create-room     → new room token                 │
  │  GET  /api/room/:token     → exists / full check            │
  │  GET  /api/turn-credentials→ short-lived Cloudflare TURN     │
  │  PUT/GET /api/blob/:token/… → R2 recording fallback          │
  └───────────────────────────────────────────────────────────┘
        │ one DO per room               │ transient, TTL
   holds the 2 peer                 recording store-and-forward
   WebSockets, relays               (only if the P2P data
   signal / peer-msg / ping          channel can't complete)

  Browser A ◄──────── WebRTC (audio + data channel) ────────► Browser B
            direct, or relayed via Cloudflare Realtime TURN
```

| Path | Codec | Purpose |
|------|-------|---------|
| Monitor | Opus via WebRTC | Live conversation (low-latency) |
| HQ record | WAV/PCM (local) | Master recording for stitching |
| Whisper (local) | 32 kbps Opus webm | Own voice → transcription |
| Whisper (remote) | 32 kbps Opus webm | Peer voice → transcription |
| Transfer | P2P data channel (R2 fallback) | Post-call file exchange |

## Develop

```bash
npm install
npm run dev        # wrangler dev → http://localhost:8787
```

`wrangler dev` runs the real Workers runtime locally, including the Durable
Object and R2 (in local mode) — no Cloudflare account needed for development.

## Test

```bash
npm run dev        # in one terminal
npm test           # headless signaling + storage tests (Layer 0)
```

`test/run.mjs` exercises the whole Worker surface against the running dev server:
room lifecycle, the DO signaling relay (roles, `peer-joined`, `signal`/`peer-msg`
relay, `ping`/`pong` clock sync, room-full / invalid-token / `peer-left`), the R2
blob round-trip, and the TURN endpoint.

Browser testing (WebRTC, recording, transcription) is manual — open two tabs at
`http://localhost:8787`, create a room in one, open the link in the other.

## Deploy

Provide a Cloudflare API token with **Workers Scripts:Edit**, **Workers R2
Storage:Edit**, and **Account Settings:Read** (never commit it):

```bash
export CLOUDFLARE_API_TOKEN=…            # e.g. from an untracked cf-token.env
export CLOUDFLARE_ACCOUNT_ID=…
wrangler r2 bucket create podcast-studio-recordings
npm run deploy                            # → https://<worker>.workers.dev
```

TURN (for peers behind symmetric NAT) uses Cloudflare Realtime. Create a TURN key
in the dashboard and set its credentials as secrets — without them, ICE falls
back to STUN only:

```bash
wrangler secret put TURN_TOKEN_ID
wrangler secret put TURN_API_TOKEN
```

Set a short lifecycle rule (e.g. 24h) on the R2 bucket so fallback recordings
auto-expire.

## Recording flow

1. Host creates a room, shares the link.
2. Both click **Get Mic** (48 kHz mono, no processing) — the P2P call connects.
3. Both click **Start Recording** — three recorders run at once: HQ (your mic,
   lossless), local Whisper (cloned track, 32 kbps Opus), remote Whisper
   (incoming peer stream).
4. **Stop** → files saved; HQ + meta sent to the peer over the data channel
   (or via the R2 relay if the channel can't complete).
5. **Stitch WAVs** → `podcast-stitched.wav` (Host = Left, Guest = Right).
6. **Open Transcriber** (`/transcribe`) → per-speaker transcript; export
   `.txt` / `.srt` / `.md`.

## Notes

- **Whisper transcription requires Chrome or Edge** (WASM SIMD). Firefox works
  for recording but not the transcription page.
- Cross-origin isolation uses `COOP: same-origin` + `COEP: credentialless`
  (enables SharedArrayBuffer without blocking cross-origin CDN resources).
- Room tokens expire after 24h. Nothing is stored server-side except the
  transient R2 fallback (token-keyed, short TTL).
- The device selectors let you choose input mic and output device; **🔊 Test
  Sound** verifies your output independent of the call.

## Roadmap

See `CLAUDE.md` for the full design rationale and roadmap, including the
editor/publisher role, VOX-gated lossless transfer, and an IndexedDB session
store with direct-to-folder saving (File System Access API).

---

> **Legacy:** `server.js` and the `*-cert.sh` scripts are the original
> self-hosted Node + Let's Encrypt implementation, retained for reference. The
> Cloudflare Worker (`src/worker.js`) supersedes them — edge TLS makes the cert
> tooling unnecessary.

// ─── Config ───────────────────────────────────────────────────────────────────
const VOX_THRESHOLD_DB    = -40;   // dBFS silence floor
const VOX_HOLD_MS         = 800;   // hold-off after signal drops
const CLOCK_SYNC_INTERVAL = 5000;  // ms between NTP sync rounds
const SYNC_SAMPLES        = 4;     // pings per round

// Whisper wants 16kHz mono Opus at low bitrate — good enough for ASR,
// tiny file size, zero resampling needed at transcription time.
const WHISPER_MIME    = 'audio/webm;codecs=opus';
const WHISPER_BITRATE = 32000; // 32 kbps

// ─── State ────────────────────────────────────────────────────────────────────
let ws, peer;
let myRole      = null;
let peerJoined  = false;   // has the other participant joined the room?
let pendingSignals = [];   // signals that arrived before the peer was constructed
let clockOffset = 0;
let syncSeq     = 0;
let pingSamples = [];

let localStream = null;

// Selected audio devices (empty = system default)
let selectedMicId    = '';
let selectedOutputId = '';

// ── HQ recorder (own mic → lossless for stitching) ───────────────────────────
let hqRecorder = null;
let hqChunks   = [];

// ── Whisper recorders ─────────────────────────────────────────────────────────
// localWhisperRecorder  : own mic  → 32kbps Opus webm  (speaker: me)
// remoteWhisperRecorder : peer stream → 32kbps Opus webm (speaker: peer)
// Each is a clean mono stream — no resampling needed at transcription time.
let localWhisperRecorder  = null;
let localWhisperChunks    = [];
let remoteWhisperRecorder = null;
let remoteWhisperChunks   = [];
let remoteStream          = null;

let sessionStart   = null;
let voxSegments    = [];
let voxState       = false;
let voxHoldTimer   = null;
let audioCtx       = null;
let analyser       = null;
let peerVoxSegments = [];

// P2P file transfer
let incomingFile = null;

// Current room token (used for the R2 store-and-forward fallback)
let roomToken = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const serverNow = () => Date.now() + clockOffset;

function log(msg, cls = '') {
  const el   = document.getElementById('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  const t = new Date().toLocaleTimeString('en', { hour12: false });
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setStatus(txt, cls = '') {
  const el = document.getElementById('status');
  el.textContent = txt;
  el.className   = 'status ' + cls;
}

// ─── Clock sync ───────────────────────────────────────────────────────────────
function doClockSync() {
  pingSamples = [];
  for (let i = 0; i < SYNC_SAMPLES; i++) setTimeout(sendPing, i * 150);
}

function sendPing() {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now(), seq: syncSeq++ }));
}

function handlePong(msg) {
  const rtt    = Date.now() - msg.clientTime;
  const offset = msg.serverTime - msg.clientTime - rtt / 2;
  pingSamples.push({ rtt, offset });

  if (pingSamples.length >= SYNC_SAMPLES) {
    pingSamples.sort((a, b) => a.rtt - b.rtt);
    const best  = pingSamples.slice(0, Math.ceil(SYNC_SAMPLES / 2));
    clockOffset = best.reduce((s, x) => s + x.offset, 0) / best.length;
    document.getElementById('rtt').textContent =
      `RTT ${pingSamples[0].rtt}ms | offset ${clockOffset.toFixed(1)}ms`;
  }
}

// ─── VOX (local mic only) ────────────────────────────────────────────────────
function startVox(stream) {
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(stream).connect(analyser);

  const buf = new Float32Array(analyser.fftSize);

  (function tick() {
    if (!hqRecorder) return;
    analyser.getFloatTimeDomainData(buf);
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    const db       = 20 * Math.log10(Math.max(Math.sqrt(rms / buf.length), 1e-10));
    const speaking = db > VOX_THRESHOLD_DB;

    if (speaking && !voxState) {
      voxState = true;
      if (voxHoldTimer) { clearTimeout(voxHoldTimer); voxHoldTimer = null; }
      const seg = { start: serverNow(), end: null };
      voxSegments.push(seg);
      document.getElementById('vox').classList.add('active');
      sendPeerMsg({ type: 'vox-start', t: seg.start });
    }

    if (!speaking && voxState && !voxHoldTimer) {
      voxHoldTimer = setTimeout(() => {
        voxState     = false;
        voxHoldTimer = null;
        const seg    = voxSegments[voxSegments.length - 1];
        if (seg) { seg.end = serverNow(); sendPeerMsg({ type: 'vox-end', t: seg.end }); }
        document.getElementById('vox').classList.remove('active');
      }, VOX_HOLD_MS);
    }

    requestAnimationFrame(tick);
  })();
}

// ─── Audio device selection (input + output) ─────────────────────────────────
const outputSupported = () => {
  const a = document.getElementById('remoteAudio');
  return !!(a && typeof a.setSinkId === 'function');
};

async function populateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }

  const fill = (sel, kind, current, fallbackLabel) => {
    if (!sel) return;
    const keep = current || sel.value;
    sel.innerHTML = '';
    devices
      .filter(d => d.kind === kind)
      .forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
        sel.appendChild(opt);
      });
    if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
  };

  fill(document.getElementById('micSelect'), 'audioinput',  selectedMicId,    'Microphone');
  fill(document.getElementById('spkSelect'), 'audiooutput', selectedOutputId, 'Output');

  // Hide the output selector on browsers without setSinkId (e.g. Firefox).
  const spkLabel = document.getElementById('spkLabel');
  if (spkLabel) spkLabel.style.display = outputSupported() ? '' : 'none';
}

// Route the peer's audio (and the test beep) to the chosen output device.
async function applyOutputDevice() {
  if (!outputSupported() || !selectedOutputId) return;
  try {
    await document.getElementById('remoteAudio').setSinkId(selectedOutputId);
  } catch (e) {
    log(`Could not set output device: ${e.message}`, 'warn');
  }
}

function micConstraints() {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl:  false,
    sampleRate:       48000,
    channelCount:     1,
  };
  if (selectedMicId) audio.deviceId = { exact: selectedMicId };
  return { audio, video: false };
}

// Hot-swap the microphone on an already-live stream (and on the peer, if connected).
async function changeMic() {
  if (hqRecorder) { log('Stop recording before switching microphone', 'warn'); return; }
  try {
    const oldStream = localStream;
    const newStream = await navigator.mediaDevices.getUserMedia(micConstraints());
    const newTrack  = newStream.getAudioTracks()[0];
    if (peer && oldStream) {
      try { peer.replaceTrack(oldStream.getAudioTracks()[0], newTrack, oldStream); }
      catch (e) { log(`replaceTrack failed: ${e.message}`, 'warn'); }
    }
    oldStream?.getAudioTracks().forEach(t => t.stop());
    localStream = newStream;
    startVox(localStream);
    log('Switched microphone', 'success');
  } catch (e) {
    log(`Mic switch failed: ${e.message}`, 'error');
  }
}

// ─── Output test (beep on the playback device) ───────────────────────────────
// Diagnostic: confirms the speakers/headphones work, independent of WebRTC.
async function testBeep() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    // Route the beep to the selected output device where supported (Chrome 110+).
    if (selectedOutputId && typeof ctx.setSinkId === 'function') {
      try { await ctx.setSinkId(selectedOutputId); } catch { /* default output */ }
    }
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);  // soft attack, no click
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.42);
    osc.onended = () => ctx.close();
    log('Test beep played on output device — hear it?', 'info');
  } catch (e) {
    log(`Beep failed: ${e.message}`, 'error');
  }
}

// ─── Mic acquisition ─────────────────────────────────────────────────────────
async function getMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia(micConstraints());
    log('Microphone acquired (48kHz mono, raw)', 'success');
    document.getElementById('btnMic').classList.add('active');
    document.getElementById('btnRecord').disabled = false;
    startVox(localStream);
    await populateDevices();   // device labels are available now that permission is granted
    maybeInitPeer();
  } catch (e) {
    log(`Mic error: ${e.message}`, 'error');
  }
}

// ─── Whisper recorder factory ─────────────────────────────────────────────────
function makeWhisperRecorder(stream, chunkArray) {
  const supported = MediaRecorder.isTypeSupported(WHISPER_MIME);
  if (!supported) log('Opus webm not supported — Whisper files will use browser default', 'warn');
  const rec = new MediaRecorder(stream, {
    mimeType:           supported ? WHISPER_MIME : undefined,
    audioBitsPerSecond: WHISPER_BITRATE,
  });
  rec.ondataavailable = e => { if (e.data.size > 0) chunkArray.push(e.data); };
  return rec;
}

// ─── Recording ───────────────────────────────────────────────────────────────
function startRecording() {
  if (!localStream) { log('Get mic first', 'error'); return; }

  // ── HQ recorder ──────────────────────────────────────────────────────────
  const hqMimes = [
    'audio/wav',
    'audio/webm;codecs=pcm',
    'audio/ogg;codecs=flac',
    'audio/webm;codecs=opus',
    'audio/webm',
  ];
  const hqMime = hqMimes.find(m => MediaRecorder.isTypeSupported(m)) || '';
  hqChunks    = [];
  voxSegments = [];
  hqRecorder  = new MediaRecorder(localStream, {
    mimeType:           hqMime || undefined,
    audioBitsPerSecond: 256000,
  });
  hqRecorder.ondataavailable = e => { if (e.data.size > 0) hqChunks.push(e.data); };
  hqRecorder.onstop = () => exportHQ(hqMime);
  hqRecorder.start(100);
  log(`HQ recorder started [${hqMime || 'browser default'}]`, 'success');

  // ── Local Whisper recorder ─────────────────────────────────────────────────
  // Clone the track — independent from the HQ recorder, won't interfere.
  const localWhisperStream = new MediaStream([localStream.getAudioTracks()[0].clone()]);
  localWhisperChunks       = [];
  localWhisperRecorder     = makeWhisperRecorder(localWhisperStream, localWhisperChunks);
  localWhisperRecorder.start(100);
  log('Whisper recorder (local mic) started [32kbps Opus]', 'success');

  // ── Remote Whisper recorder ────────────────────────────────────────────────
  // remoteStream may already be set if peer connected before record was pressed.
  if (remoteStream) {
    startRemoteWhisperRecorder(remoteStream);
  } else {
    log('Remote Whisper recorder will auto-start when peer stream arrives', 'info');
  }

  document.getElementById('btnRecord').textContent = '⏹ Stop Recording';
  document.getElementById('btnRecord').onclick     = stopRecording;
  document.getElementById('vox').classList.remove('hidden');
}

function startRemoteWhisperRecorder(stream) {
  remoteWhisperChunks   = [];
  remoteWhisperRecorder = makeWhisperRecorder(stream, remoteWhisperChunks);
  remoteWhisperRecorder.start(100);
  log('Whisper recorder (remote stream) started [32kbps Opus]', 'success');
}

function stopRecording() {
  if (hqRecorder            && hqRecorder.state !== 'inactive')            hqRecorder.stop();
  if (localWhisperRecorder  && localWhisperRecorder.state !== 'inactive')  localWhisperRecorder.stop();
  if (remoteWhisperRecorder && remoteWhisperRecorder.state !== 'inactive') remoteWhisperRecorder.stop();

  document.getElementById('btnRecord').textContent = '⏺ Start Recording';
  document.getElementById('btnRecord').onclick     = startRecording;
  document.getElementById('vox').classList.add('hidden');
}

// ─── Export ───────────────────────────────────────────────────────────────────
async function exportHQ(mime) {
  const blob = new Blob(hqChunks, { type: mime || 'audio/webm' });
  const ext  = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'webm';
  const name = `${myRole}-hq.${ext}`;

  const meta = {
    role: myRole,
    sessionStart,
    voxSegments,
    codec:      mime,
    exportedAt: serverNow(),
  };
  const metaBlob = new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' });

  downloadBlob(blob,     name);
  downloadBlob(metaBlob, `${myRole}-meta.json`);
  log(`Saved ${name} + ${myRole}-meta.json`, 'success');

  // Give Whisper recorders a moment to flush their final chunks then export
  setTimeout(() => exportWhisperFiles(), 400);

  document.getElementById('btnStitch').disabled = false;

  if (peer && peer.connected) {
    if (confirm('Send your HQ recording + meta to peer for stitching?')) {
      await sendFileToPeer(blob,     name,                   mime || 'audio/webm');
      await sendFileToPeer(metaBlob, `${myRole}-meta.json`,  'application/json');
    }
  } else if (confirm('Peer not connected. Upload recording to the server relay so they can fetch it?')) {
    await uploadToR2(blob,     name,                  mime || 'audio/webm');
    await uploadToR2(metaBlob, `${myRole}-meta.json`, 'application/json');
  }
}

function exportWhisperFiles() {
  const ext = 'webm';

  if (localWhisperChunks.length) {
    const blob = new Blob(localWhisperChunks,
      { type: MediaRecorder.isTypeSupported(WHISPER_MIME) ? WHISPER_MIME : 'audio/webm' });
    downloadBlob(blob, `${myRole}-whisper.${ext}`);
    log(`Saved ${myRole}-whisper.${ext} (${(blob.size / 1024).toFixed(0)} KB) — own voice for Whisper`, 'success');
  }

  if (remoteWhisperChunks.length) {
    const peerRole = myRole === 'host' ? 'guest' : 'host';
    const blob     = new Blob(remoteWhisperChunks,
      { type: MediaRecorder.isTypeSupported(WHISPER_MIME) ? WHISPER_MIME : 'audio/webm' });
    downloadBlob(blob, `${peerRole}-whisper.${ext}`);
    log(`Saved ${peerRole}-whisper.${ext} (${(blob.size / 1024).toFixed(0)} KB) — peer voice for Whisper`, 'success');
  }

  log('All files saved. Open /transcribe to generate transcript →', 'info');
  document.getElementById('transcribeLink').classList.remove('hidden');
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWS(token) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);

  ws.onopen = () => {
    log('Connected to signaling server');
    doClockSync();
    setInterval(doClockSync, CLOCK_SYNC_INTERVAL);
  };

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'role':
        myRole      = msg.role;
        clockOffset = msg.serverTime - Date.now();
        log(`Joined as ${myRole}`, 'info');
        setStatus(myRole === 'host' ? 'Waiting for guest…' : 'Connected — waiting for host', 'waiting');
        if (myRole === 'host') document.getElementById('controls').classList.remove('hidden');
        break;
      case 'peer-joined':
        log('Peer connected!', 'success');
        setStatus('Peer connected', 'connected');
        document.getElementById('controls').classList.remove('hidden');
        peerJoined = true;
        if (!localStream) log('Click “Get Mic” to start the call', 'info');
        maybeInitPeer();
        break;
      case 'peer-left':
        log('Peer disconnected', 'warn');
        setStatus('Peer disconnected', 'error');
        peerJoined = false;
        pendingSignals = [];
        if (peer) { peer.destroy(); peer = null; }
        break;
      case 'signal':
        // Buffer signals that arrive before our peer exists (initiator may send
        // its offer before the answerer has constructed its peer). Flushed in initPeer().
        if (peer) peer.signal(msg.data);
        else pendingSignals.push(msg.data);
        break;
      case 'pong':
        handlePong(msg);
        break;
      case 'peer-msg':
        handlePeerMsg(msg.data);
        break;
      case 'error':
        log(`Server error: ${msg.message}`, 'error');
        setStatus('Error: ' + msg.message, 'error');
        break;
    }
  };

  ws.onclose = () => log('Signaling disconnected', 'warn');
}

function sendPeerMsg(data) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'peer-msg', data }));
}

// ─── ICE servers (STUN + short-lived Cloudflare TURN) ─────────────────────────
function defaultIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
}

async function getIceServers() {
  try {
    // Pass the room token so the Worker can resolve entitlement: an entitled
    // (Pro) room gets real TURN; a free room transparently gets STUN-only.
    const qs = roomToken ? `?token=${encodeURIComponent(roomToken)}` : '';
    const res = await fetch(`/api/turn-credentials${qs}`);
    const { iceServers } = await res.json();
    if (Array.isArray(iceServers) && iceServers.length) return iceServers;
  } catch { /* fall through to STUN-only */ }
  return defaultIceServers();
}

// Create the peer connection only once BOTH sides are ready: the mic is live
// AND the other participant has joined. Either can happen first, so this is
// called from both getMic() and the 'peer-joined' handler.
function maybeInitPeer() {
  if (localStream && peerJoined && !peer) initPeer(myRole === 'host');
}

// ─── SimplePeer ───────────────────────────────────────────────────────────────
async function initPeer(initiator) {
  if (!localStream) { log('No mic stream — get mic first', 'error'); return; }

  const iceServers = await getIceServers();
  peer = new SimplePeer({
    initiator,
    stream: localStream,
    trickle: true,
    config: { iceServers },
  });

  peer.on('signal', data => ws.send(JSON.stringify({ type: 'signal', data })));

  peer.on('connect', () => {
    log('P2P data channel open', 'success');
    if (myRole === 'host') {
      sessionStart = serverNow();
      sendPeerMsg({ type: 'session-start', t: sessionStart });
      log(`Session start synchronised: ${sessionStart}`);
    }
  });

  peer.on('stream', stream => {
    log('Remote audio stream received', 'success');
    remoteStream = stream;
    const audio = document.getElementById('remoteAudio');
    audio.srcObject = stream;
    audio.play();
    applyOutputDevice();

    // Auto-start remote Whisper recorder if recording is already in progress
    if (hqRecorder && hqRecorder.state === 'recording' && !remoteWhisperRecorder) {
      startRemoteWhisperRecorder(stream);
    }
  });

  peer.on('data',  handleDataChannel);
  peer.on('error', err => log(`Peer error: ${err.message}`, 'error'));
  peer.on('close', ()  => log('P2P connection closed', 'warn'));
  peer.on('iceStateChange', (state) => log(`ICE: ${state}`, 'info'));

  // Flush any signals that arrived before this peer was constructed.
  if (pendingSignals.length) {
    log(`Applying ${pendingSignals.length} buffered signal(s)`, 'info');
    for (const s of pendingSignals) peer.signal(s);
    pendingSignals = [];
  }
}

// ─── Peer messages ────────────────────────────────────────────────────────────
function handlePeerMsg(data) {
  switch (data.type) {
    case 'session-start':
      sessionStart = data.t;
      log(`Session start received: ${sessionStart}`);
      break;
    case 'vox-start':
      peerVoxSegments.push({ start: data.t, end: null });
      break;
    case 'vox-end': {
      const seg = peerVoxSegments[peerVoxSegments.length - 1];
      if (seg) seg.end = data.t;
      break;
    }
    case 'file-meta':
      incomingFile = { chunks: [], total: data.size, received: 0, name: data.name, mime: data.mime };
      log(`Receiving ${data.name} (${(data.size / 1024).toFixed(1)} KB)…`);
      break;
    case 'file-done':
      finaliseIncomingFile();
      break;
    case 'blob-available':
      fetchBlobFromR2(data.name, data.mime);
      break;
  }
}

// ─── P2P file transfer ────────────────────────────────────────────────────────
// Primary path: WebRTC data channel with a bufferedAmount high-water gate so a
// large WAV (~700MB ≈ 43k chunks) can't overflow the SCTP send buffer and drop
// the channel. If the channel isn't open or fails mid-transfer, fall back to the
// R2 store-and-forward relay.
async function sendFileToPeer(blob, name, mime) {
  const CHUNK = 16384;
  const HIGH_WATER = 1 << 20; // 1 MB — pause sending above this
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const channel = peer && peer._channel;

  try {
    if (!peer || !peer.connected) throw new Error('data channel not open');
    sendPeerMsg({ type: 'file-meta', name, mime, size: blob.size });
    for (let i = 0; i < bytes.length; i += CHUNK) {
      if (!peer || !peer.connected) throw new Error('data channel closed mid-transfer');
      // Backpressure: wait while the send buffer is above the high-water mark.
      while (channel && channel.bufferedAmount > HIGH_WATER) {
        await new Promise(r => setTimeout(r, 20));
        if (!peer || !peer.connected) throw new Error('data channel closed mid-transfer');
      }
      peer.send(bytes.slice(i, i + CHUNK));
    }
    sendPeerMsg({ type: 'file-done', name });
    log(`Sent ${name} to peer`, 'success');
  } catch (e) {
    log(`P2P transfer failed (${e.message}) — using server relay`, 'warn');
    await uploadToR2(blob, name, mime);
  }
}

// ─── R2 store-and-forward fallback ────────────────────────────────────────────
async function uploadToR2(blob, name, mime) {
  if (!roomToken) { log('No room token — cannot use server relay', 'error'); return; }
  try {
    const res = await fetch(`/api/blob/${roomToken}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': mime || 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    sendPeerMsg({ type: 'blob-available', name, mime, size: blob.size });
    log(`Uploaded ${name} to server relay — peer will fetch`, 'success');
  } catch (e) {
    log(`Server relay upload failed: ${e.message}`, 'error');
  }
}

async function fetchBlobFromR2(name, mime) {
  if (!roomToken) return;
  try {
    log(`Fetching ${name} from server relay…`);
    const res = await fetch(`/api/blob/${roomToken}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const blob = await res.blob();
    downloadBlob(blob, `peer-${name}`);
    log(`Received & saved peer-${name} (via server relay)`, 'success');
    document.getElementById('btnStitch').disabled = false;
  } catch (e) {
    log(`Failed to fetch ${name} from relay: ${e.message}`, 'error');
  }
}

function handleDataChannel(rawData) {
  if (!incomingFile) return;
  const chunk = new Uint8Array(
    rawData instanceof ArrayBuffer ? rawData : (rawData.buffer || rawData)
  );
  incomingFile.chunks.push(chunk);
  incomingFile.received += chunk.length;
  const pct = ((incomingFile.received / incomingFile.total) * 100).toFixed(0);
  document.getElementById('transferProgress').textContent =
    `Receiving ${incomingFile.name}: ${pct}%`;
}

function finaliseIncomingFile() {
  if (!incomingFile) return;
  const total  = incomingFile.chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const chunk of incomingFile.chunks) { merged.set(chunk, off); off += chunk.length; }
  const blob = new Blob([merged], { type: incomingFile.mime });
  downloadBlob(blob, `peer-${incomingFile.name}`);
  log(`Received & saved peer-${incomingFile.name}`, 'success');
  document.getElementById('transferProgress').textContent = '';
  document.getElementById('btnStitch').disabled = false;
  incomingFile = null;
}

// ─── Stitching ────────────────────────────────────────────────────────────────
async function stitchRecordings() {
  log('Select HOST HQ audio file…');
  const hostAudio = await pickFile('audio/*');
  log('Select HOST meta.json…');
  const hostMeta  = JSON.parse(await pickFile('application/json').then(f => f.text()));

  log('Select GUEST HQ audio file…');
  const guestAudio = await pickFile('audio/*');
  log('Select GUEST meta.json…');
  const guestMeta  = JSON.parse(await pickFile('application/json').then(f => f.text()));

  const tmpCtx   = new OfflineAudioContext(1, 1, 48000);
  const hostBuf  = await tmpCtx.decodeAudioData(await hostAudio.arrayBuffer());
  const guestBuf = await tmpCtx.decodeAudioData(await guestAudio.arrayBuffer());

  const guestOffsetSec = (guestMeta.sessionStart - hostMeta.sessionStart) / 1000;
  const totalSamples   = Math.max(
    Math.ceil(hostBuf.duration * 48000),
    Math.ceil((guestOffsetSec + guestBuf.duration) * 48000)
  );

  const ctx = new OfflineAudioContext(2, totalSamples, 48000);

  const addTrack = (buf, offsetSec, pan) => {
    const src        = ctx.createBufferSource();
    src.buffer       = buf;
    const panner     = ctx.createStereoPanner();
    panner.pan.value = pan;
    src.connect(panner).connect(ctx.destination);
    src.start(Math.max(0, offsetSec));
  };

  addTrack(hostBuf,  0,              -1);  // Host  → Left
  addTrack(guestBuf, guestOffsetSec,  1);  // Guest → Right

  log('Rendering stitched audio…');
  const rendered = await ctx.startRendering();
  downloadBlob(audioBufferToWav(rendered), 'podcast-stitched.wav');
  log('Saved podcast-stitched.wav — Host=Left, Guest=Right', 'success');
}

function pickFile(accept) {
  return new Promise(resolve => {
    const input  = document.createElement('input');
    input.type   = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0]);
    input.click();
  });
}

// ─── WAV encoder (32-bit IEEE float) ─────────────────────────────────────────
function audioBufferToWav(buffer) {
  const numCh   = buffer.numberOfChannels;
  const rate    = buffer.sampleRate;
  const samples = buffer.length;
  const data    = new DataView(new ArrayBuffer(44 + samples * numCh * 4));
  const str     = (off, s) => [...s].forEach((c, i) => data.setUint8(off + i, c.charCodeAt(0)));

  str(0, 'RIFF'); data.setUint32(4, 36 + samples * numCh * 4, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 3, true);
  data.setUint16(22, numCh, true); data.setUint32(24, rate, true);
  data.setUint32(28, rate * numCh * 4, true); data.setUint16(32, numCh * 4, true);
  data.setUint16(34, 32, true); str(36, 'data');
  data.setUint32(40, samples * numCh * 4, true);

  let off = 44;
  for (let i = 0; i < samples; i++)
    for (let ch = 0; ch < numCh; ch++) { data.setFloat32(off, buffer.getChannelData(ch)[i], true); off += 4; }

  return new Blob([data.buffer], { type: 'audio/wav' });
}

function downloadBlob(blob, name) {
  const a      = document.createElement('a');
  a.href       = URL.createObjectURL(blob);
  a.download   = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(location.search);
  const token  = params.get('token');

  if (!token) {
    document.getElementById('lobby').classList.remove('hidden');
    return;
  }

  roomToken = token;

  try {
    const { exists, full } = await fetch(`/api/room/${encodeURIComponent(token)}`).then(r => r.json());
    if (!exists) { alert('Room not found or expired.'); location.href = '/'; return; }
    if (full)    { alert('Room is full.'); return; }
  } catch { alert('Cannot reach server.'); return; }

  document.getElementById('room').classList.remove('hidden');
  document.getElementById('roomToken').textContent = token;
  document.getElementById('shareLink').value       = location.href;

  connectWS(token);
}

async function createRoom() {
  const headers = {};
  // If signed in with a Pro plan, authorize the new room so it unlocks TURN + R2.
  // Free (signed-out) rooms are created STUN-only, pure P2P — no account needed.
  try {
    if (window.Clerk?.session) {
      const jwt = await window.Clerk.session.getToken();
      if (jwt) headers.Authorization = `Bearer ${jwt}`;
    }
  } catch { /* fall through — create a free room */ }

  const { token } = await fetch('/api/create-room', { method: 'POST', headers })
    .then(r => r.json());
  location.href = `/?token=${token}`;
}

// ─── Clerk auth + billing (Pro unlock) ────────────────────────────────────────
// The free P2P tier needs no account — Clerk only gates the Pro TURN/R2 unlock.
// If Clerk isn't configured (placeholder publishable key), the loader never sets
// window.Clerk, this all no-ops, and the app stays free-tier only.
function waitForClerk(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      if (window.Clerk) return resolve(window.Clerk);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(poll, 100);
    })();
  });
}

async function initClerk() {
  // Only surface the auth/billing UI when the Worker says billing is enabled
  // (BILLING_ENABLED=true). Defaults off, so a public deploy stays free-only and
  // never shows a checkout that can't succeed until production billing is live.
  let billingEnabled = false;
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    billingEnabled = !!cfg.billingEnabled;
  } catch { /* default off — free tier only */ }
  if (!billingEnabled) return;

  const clerk = await waitForClerk();
  if (!clerk) return; // not configured — free tier only
  try {
    await clerk.load();
  } catch (e) {
    console.warn('Clerk failed to load — staying free-tier', e);
    return;
  }
  const account = document.getElementById('account');
  if (account) account.classList.remove('hidden');

  document.getElementById('btnSignIn')?.addEventListener('click',
    () => clerk.openSignIn({ afterSignInUrl: location.href }));
  document.getElementById('btnGoPro')?.addEventListener('click',
    () => openGoPro(clerk));
  document.getElementById('btnProClose')?.addEventListener('click',
    () => closeGoPro(clerk));

  renderClerk(clerk);
  clerk.addListener(() => renderClerk(clerk));
}

function hasPro(clerk) {
  try { return !!clerk.session?.checkAuthorization?.({ plan: 'pro' }); }
  catch { return false; }
}

function renderClerk(clerk) {
  const badge    = document.getElementById('planBadge');
  const signIn   = document.getElementById('btnSignIn');
  const goPro    = document.getElementById('btnGoPro');
  const userBtn  = document.getElementById('userButton');
  const signedIn = !!clerk.user;
  const pro      = signedIn && hasPro(clerk);

  if (signIn) signIn.classList.toggle('hidden', signedIn);
  if (userBtn) {
    userBtn.classList.toggle('hidden', !signedIn);
    if (signedIn && !userBtn.dataset.mounted) {
      clerk.mountUserButton(userBtn);
      userBtn.dataset.mounted = '1';
    }
  }
  if (badge) {
    badge.classList.toggle('hidden', !signedIn);
    badge.classList.toggle('pro', pro);
    badge.textContent = pro ? 'Pro' : 'Free';
  }
  if (goPro) goPro.classList.toggle('hidden', pro); // already Pro → nothing to buy
}

function openGoPro(clerk) {
  if (!clerk.user) {
    clerk.openSignIn({ afterSignInUrl: location.href });
    return;
  }
  // Show Clerk's PricingTable in an OPAQUE full-page view (#proModal) — not a
  // translucent overlay. That way Clerk's checkout drawer (card entry) opens over a
  // plain page, exactly like sign-in did, and can't be masked by a backdrop of ours.
  const modal = document.getElementById('proModal');
  const host  = document.getElementById('pricingHost');
  if (!modal || !host || typeof clerk.mountPricingTable !== 'function') {
    clerk.openUserProfile(); // fallback if this Clerk build lacks PricingTable
    return;
  }
  host.replaceChildren();
  modal.classList.remove('hidden');
  try {
    clerk.mountPricingTable(host);
  } catch (e) {
    console.warn('PricingTable mount failed', e);
    modal.classList.add('hidden');
    clerk.openUserProfile();
  }
}

function closeGoPro(clerk) {
  const modal = document.getElementById('proModal');
  const host  = document.getElementById('pricingHost');
  try { clerk.unmountPricingTable?.(host); } catch { /* ignore */ }
  if (host) host.replaceChildren();
  modal?.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW register failed', e));

  initClerk();

  document.getElementById('btnCreate').onclick   = createRoom;
  document.getElementById('btnJoin').onclick     = () => {
    let code = document.getElementById('joinCode').value.trim();
    if (!code) return;
    // Accept either a bare room code or a full share link pasted in.
    try {
      if (code.includes('token=')) {
        const qs = code.includes('?') ? code.slice(code.indexOf('?') + 1) : code;
        code = new URLSearchParams(qs).get('token') || code;
      }
    } catch { /* fall back to the raw value */ }
    location.href = `/?token=${encodeURIComponent(code)}`;
  };
  document.getElementById('btnBeep').onclick     = testBeep;
  document.getElementById('btnMic').onclick      = getMic;

  // Audio device selectors
  const micSelect = document.getElementById('micSelect');
  const spkSelect = document.getElementById('spkSelect');
  if (micSelect) micSelect.onchange = () => { selectedMicId = micSelect.value; if (localStream) changeMic(); };
  if (spkSelect) spkSelect.onchange = () => { selectedOutputId = spkSelect.value; applyOutputDevice(); };
  populateDevices();
  if (navigator.mediaDevices)
    navigator.mediaDevices.addEventListener?.('devicechange', populateDevices);
  document.getElementById('btnRecord').onclick   = startRecording;
  document.getElementById('btnStitch').onclick   = stitchRecordings;
  document.getElementById('btnCopyLink').onclick = () => {
    navigator.clipboard.writeText(document.getElementById('shareLink').value);
    document.getElementById('btnCopyLink').textContent = 'Copied!';
    setTimeout(() => document.getElementById('btnCopyLink').textContent = 'Copy', 2000);
  };

  init();
});

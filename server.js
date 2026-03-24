'use strict';

const fastify = require('fastify')({ logger: false });
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const OpenAI = require('openai');
const https = require('https');

const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '8kvxG72xUMYnIFhZYwWj';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are an AI assistant for Tom Fuselier at QuotingFast, an insurance lead generation company. You know his business — live transfers, ping/post lead validation, AI dialer, Jangl integration, lead scoring, BLA blacklist checks. Be direct and concise. Voice conversation — keep responses to 1-3 sentences max. No bullet points or markdown.`;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>QF Voice</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0e17;--surface:#111827;--border:#1f2937;--accent:#3b82f6;--green:#10b981;--yellow:#f59e0b;--red:#ef4444;--text:#f9fafb;--muted:#6b7280}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;padding:24px;text-align:center}
.logo{font-size:56px}
h1{font-size:24px;font-weight:700}
.sub{font-size:13px;color:var(--muted);margin-top:4px}
.orb{width:110px;height:110px;border-radius:50%;background:var(--accent);border:none;color:#fff;font-size:42px;cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;transition:background .2s;display:flex;align-items:center;justify-content:center}
.orb.listening{background:var(--red);animation:pulse 1.5s infinite}
.orb.thinking{background:var(--yellow)}
.orb.speaking{background:var(--green);animation:breathe .8s infinite ease-in-out}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}70%{box-shadow:0 0 0 22px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
.status{font-size:17px;font-weight:600;min-height:26px}
.transcript{font-size:14px;color:var(--muted);max-width:300px;line-height:1.6;min-height:44px}
.hint{font-size:12px;color:var(--muted)}
#err{display:none;position:fixed;bottom:20px;left:16px;right:16px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.4);color:#fca5a5;padding:10px 14px;font-size:13px;border-radius:10px}
</style>
</head>
<body>
<div>
  <div class="logo">🎙</div>
  <h1>QF Voice</h1>
  <div class="sub">QuotingFast AI</div>
</div>

<button class="orb" id="orb">🎙</button>

<div>
  <div class="status" id="status">Tap to start</div>
  <div class="transcript" id="transcript"> </div>
</div>

<div class="hint">Tap once to start · tap again to stop</div>
<div id="err"></div>

<script>
// ── State ─────────────────────────────────────────────────────────────────
let ws = null;
let state = 'idle';
let running = false;
let mediaStream = null;
let micCtx = null;
let processor = null;

// ── Audio playback (key: create AudioContext on first user tap) ───────────
let playCtx = null;

function getPlayCtx() {
  if (!playCtx) {
    playCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (playCtx.state === 'suspended') playCtx.resume();
  return playCtx;
}

let mp3Chunks = [];
let playQueue = [];
let isPlaying = false;

function onAudioChunk(b64) {
  mp3Chunks.push(b64);
}

async function onAudioFinal() {
  if (!mp3Chunks.length) return;
  const combined = mp3Chunks.join('');
  mp3Chunks = [];
  // Decode base64 to ArrayBuffer
  const bin = atob(combined);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  playQueue.push(buf.buffer);
  if (!isPlaying) drainQueue();
}

async function drainQueue() {
  if (!playQueue.length) { isPlaying = false; return; }
  isPlaying = true;
  const buf = playQueue.shift();
  try {
    const ctx = getPlayCtx();
    const decoded = await ctx.decodeAudioData(buf);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    src.onended = drainQueue;
    src.start(0);
  } catch(e) {
    console.error('decode err', e);
    // Fallback: Audio element
    const blob = new Blob([new Uint8Array(buf)], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); drainQueue(); };
    audio.onerror = drainQueue;
    try { await audio.play(); } catch(e2) { drainQueue(); }
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onopen = () => console.log('ws open');
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => { setTimeout(connect, 2000); };
  ws.onerror = e => console.error('ws err', e);
}

function wsSend(o) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
}

function handle(m) {
  switch(m.type) {
    case 'status': setStatus(m.state); break;
    case 'transcript':
      document.getElementById('transcript').textContent = m.text;
      break;
    case 'userMessage':
      document.getElementById('transcript').textContent = 'You: ' + m.text;
      break;
    case 'assistantChunk':
      const t = document.getElementById('transcript');
      if (!t.dataset.ai) { t.textContent = ''; t.dataset.ai = '1'; }
      t.textContent += m.text;
      break;
    case 'assistantDone':
      delete document.getElementById('transcript').dataset.ai;
      break;
    case 'audio':
      if (m.final) onAudioFinal();
      else if (m.data) onAudioChunk(m.data);
      break;
    case 'error': showErr(m.message); break;
  }
}

// ── UI ────────────────────────────────────────────────────────────────────
function setStatus(s) {
  state = s;
  const orb = document.getElementById('orb');
  const status = document.getElementById('status');
  orb.className = 'orb' + (s !== 'idle' ? ' ' + s : '');
  if (s === 'listening') { orb.textContent = '🔴'; status.textContent = 'Listening...'; }
  else if (s === 'thinking') { orb.textContent = '⏳'; status.textContent = 'Thinking...'; }
  else if (s === 'speaking') { orb.textContent = '🔊'; status.textContent = 'Speaking...'; }
  else { orb.textContent = '🎙'; status.textContent = 'Tap to start'; }
}

function showErr(msg) {
  const el = document.getElementById('err');
  el.textContent = '⚠️ ' + msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 8000);
}

// ── Mic ───────────────────────────────────────────────────────────────────
const PCM_WORKLET = \`
class P extends AudioWorkletProcessor {
  constructor() { super(); this._b = []; this._s = 4096; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) this._b.push(ch[i]);
    while (this._b.length >= this._s) {
      const chunk = this._b.splice(0, this._s);
      const i16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        i16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage(i16, [i16.buffer]);
    }
    return true;
  }
}
registerProcessor('p', P);
\`;

async function startMic() {
  // CRITICAL: AudioContext must be created/resumed during this user gesture
  getPlayCtx();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      video: false
    });
  } catch(e) {
    showErr('Microphone: ' + e.message);
    return false;
  }

  micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

  // Load worklet from blob URL (avoids needing a separate file)
  const blob = new Blob([PCM_WORKLET], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await micCtx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const src = micCtx.createMediaStreamSource(mediaStream);
  processor = new AudioWorkletNode(micCtx, 'p');
  src.connect(processor);

  processor.port.onmessage = e => {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(e.data.buffer)));
    wsSend({ type: 'audio', data: b64 });
  };

  wsSend({ type: 'start' });
  return true;
}

function stopMic() {
  if (processor) { processor.disconnect(); processor = null; }
  if (micCtx) { micCtx.close(); micCtx = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  wsSend({ type: 'stop' });
}

// ── Toggle ────────────────────────────────────────────────────────────────
document.getElementById('orb').addEventListener('click', async () => {
  if (!running) {
    running = true;
    const ok = await startMic();
    if (!ok) { running = false; }
  } else {
    running = false;
    stopMic();
    setStatus('idle');
    document.getElementById('transcript').textContent = ' ';
  }
});

connect();
</script>
</body>
</html>`;

fastify.register(require('@fastify/websocket'));
fastify.register(async function(f) {
  f.get('/ws', { websocket: true }, (sock) => handleClient(sock));
});

function handleClient(sock) {
  const history = [];
  let dg = null, lastTranscript = '', timer = null, busy = false;

  function send(o) {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(o));
  }

  function startDG() {
    if (dg) { try { dg.finish(); } catch(e){} dg = null; }
    lastTranscript = '';
    const client = createClient(DEEPGRAM_API_KEY);
    dg = client.listen.live({
      model: 'nova-2', language: 'en-US', smart_format: true,
      encoding: 'linear16', sample_rate: 16000, channels: 1,
      interim_results: true, utterance_end_ms: 800, vad_events: true, endpointing: 300,
    });
    dg.on('open', () => send({ type: 'status', state: 'listening' }));
    dg.on('Results', data => {
      const t = data.channel?.alternatives?.[0]?.transcript || '';
      if (!t) return;
      send({ type: 'transcript', text: t });
      if (data.is_final) lastTranscript = t;
      if (data.speech_final && lastTranscript && !busy) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const txt = lastTranscript; lastTranscript = '';
          if (txt) process(txt);
        }, 150);
      }
    });
    dg.on('UtteranceEnd', () => {
      if (lastTranscript && !busy) {
        const txt = lastTranscript; lastTranscript = '';
        process(txt);
      }
    });
    dg.on('error', e => { const msg = typeof e === 'string' ? e : (e?.message || JSON.stringify(e)); console.error('DG error:', msg); send({ type: 'error', message: 'STT: ' + msg }); });
  }

  async function process(text) {
    if (busy) return;
    busy = true;
    send({ type: 'userMessage', text });
    send({ type: 'status', state: 'thinking' });
    history.push({ role: 'user', content: text });
    try {
      let full = '';
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o', stream: true, max_tokens: 200, temperature: 0.7,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      });
      send({ type: 'status', state: 'speaking' });
      for await (const chunk of stream) {
        const d = chunk.choices[0]?.delta?.content || '';
        if (d) { full += d; send({ type: 'assistantChunk', text: d }); }
      }
      history.push({ role: 'assistant', content: full });
      send({ type: 'assistantDone' });
      await tts(full, send);
    } catch(e) {
      console.error('process:', e.message);
      send({ type: 'error', message: e.message });
    } finally {
      busy = false;
      send({ type: 'status', state: 'listening' });
    }
  }

  function tts(text, sendFn) {
    return new Promise(resolve => {
      const body = JSON.stringify({
        text, model_id: 'eleven_flash_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      });
      const req = https.request({
        hostname: 'api.elevenlabs.io',
        path: '/v1/text-to-speech/' + ELEVENLABS_VOICE_ID + '/stream',
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'audio/mpeg',
        },
      }, res => {
        if (res.statusCode !== 200) {
          let e = ''; res.on('data', d => e += d);
          res.on('end', () => { console.error('TTS', res.statusCode, e); resolve(); });
          return;
        }
        res.on('data', c => sendFn({ type: 'audio', data: c.toString('base64'), final: false }));
        res.on('end', () => { sendFn({ type: 'audio', data: '', final: true }); resolve(); });
      });
      req.on('error', e => { console.error('TTS req:', e); resolve(); });
      req.write(body); req.end();
    });
  }

  sock.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'start') { busy = false; startDG(); }
      else if (m.type === 'stop') {
        const txt = lastTranscript.trim(); lastTranscript = '';
        if (dg) { try { dg.finish(); } catch(e){} dg = null; }
        if (txt && !busy) process(txt);
        else send({ type: 'status', state: 'idle' });
      }
      else if (m.type === 'audio') {
        if (dg && dg.getReadyState() === 1) dg.send(Buffer.from(m.data, 'base64'));
      }
    } catch(e) { console.error(e); }
  });

  sock.on('close', () => { if (dg) { try { dg.finish(); } catch(e){} } });
}

fastify.get('/', async (req, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8');
  return reply.send(HTML);
});

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log('Port', PORT))
  .catch(e => { console.error(e); process.exit(1); });

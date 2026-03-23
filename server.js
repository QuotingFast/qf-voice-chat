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

const SYSTEM_PROMPT = `You are an AI assistant for Tom Fuselier at QuotingFast, an insurance lead generation company. You know his business well — live transfers, ping/post lead validation, AI dialer, Jangl integration, lead scoring, BLA blacklist checks. Be direct and concise. This is a voice conversation — keep responses short, 1-3 sentences max. No bullet points or markdown.`;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>QF Voice</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0e17;--surface:#111827;--border:#1f2937;--accent:#3b82f6;--green:#10b981;--yellow:#f59e0b;--red:#ef4444;--text:#f9fafb;--muted:#6b7280}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
header{padding:14px 16px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0}
.logo{width:34px;height:34px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
h1{font-size:16px;font-weight:700}
.sub{font-size:11px;color:var(--muted)}
.badge{margin-left:auto;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.badge.idle{background:rgba(107,114,128,.2);color:var(--muted)}
.badge.listening{background:rgba(16,185,129,.2);color:var(--green)}
.badge.thinking{background:rgba(245,158,11,.2);color:var(--yellow)}
.badge.speaking{background:rgba(59,130,246,.2);color:var(--accent)}
#chat{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;-webkit-overflow-scrolling:touch}
.msg{max-width:82%;padding:9px 13px;border-radius:12px;font-size:15px;line-height:1.5;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:3px}
.msg.ai{align-self:flex-start;background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:3px}
.msg.interim{align-self:flex-end;background:rgba(59,130,246,.1);border:1px dashed rgba(59,130,246,.3);color:var(--muted);font-style:italic;border-bottom-right-radius:3px}
.dots{align-self:flex-start;padding:11px 14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;border-bottom-left-radius:3px;display:flex;gap:5px;align-items:center}
.dot{width:7px;height:7px;background:var(--muted);border-radius:50%;animation:bonce 1.4s infinite}
.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
@keyframes bonce{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-7px);opacity:1}}
.controls{padding:16px;background:var(--surface);border-top:1px solid var(--border);display:flex;flex-direction:column;gap:12px;align-items:center;flex-shrink:0}
#micbtn{width:76px;height:76px;border-radius:50%;border:none;background:var(--accent);color:#fff;font-size:28px;cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;display:flex;align-items:center;justify-content:center;transition:background .2s}
#micbtn.listening{background:var(--red);animation:pulse 1.5s infinite}
#micbtn.thinking,#micbtn.speaking{background:var(--yellow)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}70%{box-shadow:0 0 0 16px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
.hint{font-size:12px;color:var(--muted);text-align:center}
#err{display:none;background:rgba(239,68,68,.15);border-top:1px solid rgba(239,68,68,.3);color:#fca5a5;padding:8px 14px;font-size:13px;text-align:center;flex-shrink:0}
</style>
</head>
<body>
<header>
  <div class="logo">🎙</div>
  <div><h1>QF Voice</h1><div class="sub">QuotingFast AI</div></div>
  <div class="badge idle" id="badge">Idle</div>
</header>
<div id="err"></div>
<div id="chat"><div class="msg ai">Tap and hold the mic — I'll speak back to you.</div></div>
<div class="controls">
  <button id="micbtn" aria-label="Hold to talk">🎙</button>
  <div class="hint" id="hint">Hold to talk</div>
</div>

<script>
// Audio context — must be created on user gesture
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// WebSocket
let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onopen = () => console.log('ws open');
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 2000);
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

// State
let state = 'idle';
let interimEl = null, thinkingEl = null, aiEl = null;
let mp3Buf = [];

function handle(m) {
  if (m.type === 'status') setState(m.state);
  else if (m.type === 'transcript') showInterim(m.text, m.isFinal);
  else if (m.type === 'userMessage') { showInterim(null); addMsg('user', m.text); showDots(true); }
  else if (m.type === 'assistantChunk') { showDots(false); appendAI(m.text); }
  else if (m.type === 'assistantDone') { aiEl = null; }
  else if (m.type === 'audio') {
    if (m.final) playMp3();
    else if (m.data) mp3Buf.push(m.data);
  } else if (m.type === 'error') showErr(m.message);
}

// Play accumulated MP3 using AudioContext (bypasses iOS autoplay restrictions
// because AudioContext was created inside the user's touchstart gesture)
function playMp3() {
  if (!mp3Buf.length) return;
  const b64 = mp3Buf.join('');
  mp3Buf = [];
  try {
    const raw = atob(b64);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    const ctx = getAudioCtx();
    ctx.decodeAudioData(buf.buffer, decoded => {
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(ctx.destination);
      src.start(0);
    }, err => {
      console.error('decode err', err);
      // Fallback: blob URL
      const blob = new Blob([buf], {type:'audio/mpeg'});
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      a.play().catch(console.error);
    });
  } catch(e) { showErr('Audio error: ' + e.message); }
}

function setState(s) {
  state = s;
  const b = document.getElementById('badge');
  const btn = document.getElementById('micbtn');
  const hint = document.getElementById('hint');
  b.className = 'badge ' + s;
  b.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  btn.className = s !== 'idle' ? s : '';
  if (s === 'listening') { btn.textContent = '🔴'; hint.textContent = 'Release to send'; }
  else if (s === 'thinking') { btn.textContent = '⏳'; hint.textContent = 'Thinking...'; }
  else if (s === 'speaking') { btn.textContent = '🔊'; hint.textContent = 'Speaking...'; }
  else { btn.textContent = '🎙'; hint.textContent = 'Hold to talk'; }
}

function showErr(msg) {
  const el = document.getElementById('err');
  el.textContent = '⚠️ ' + msg; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 7000);
}

function showInterim(text) {
  const c = document.getElementById('chat');
  if (!text) { if (interimEl) { interimEl.remove(); interimEl = null; } return; }
  if (!interimEl) { interimEl = document.createElement('div'); interimEl.className = 'msg interim'; c.appendChild(interimEl); }
  interimEl.textContent = text;
  c.scrollTop = c.scrollHeight;
}

function showDots(show) {
  const c = document.getElementById('chat');
  if (show && !thinkingEl) {
    thinkingEl = document.createElement('div'); thinkingEl.className = 'dots';
    thinkingEl.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
    c.appendChild(thinkingEl); c.scrollTop = c.scrollHeight;
  } else if (!show && thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

function addMsg(role, text) {
  const c = document.getElementById('chat');
  const d = document.createElement('div');
  d.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  d.textContent = text;
  c.appendChild(d); c.scrollTop = c.scrollHeight;
  return d;
}

function appendAI(chunk) {
  if (!aiEl) aiEl = addMsg('ai', '');
  aiEl.textContent += chunk;
  document.getElementById('chat').scrollTop = 99999;
}

// Mic
let mediaStream = null, audioCtxMic = null, processor = null;

async function startMic() {
  if (state === 'listening') return;
  
  // Create/resume AudioContext on this user gesture (iOS requirement)
  getAudioCtx();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }, video: false
    });
  } catch(e) { showErr('Mic: ' + e.message); return; }

  audioCtxMic = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  await audioCtxMic.audioWorklet.addModule('/pcm.js');
  const src = audioCtxMic.createMediaStreamSource(mediaStream);
  processor = new AudioWorkletNode(audioCtxMic, 'pcm-processor');
  src.connect(processor);
  processor.port.onmessage = e => {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(e.data.buffer)));
    send({ type: 'audio', data: b64 });
  };
  send({ type: 'start' });
}

function stopMic() {
  if (processor) { processor.disconnect(); processor = null; }
  if (audioCtxMic) { audioCtxMic.close(); audioCtxMic = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (state === 'listening') { send({ type: 'stop' }); setState('idle'); }
}

// Button
const btn = document.getElementById('micbtn');
let ptt = false;

btn.addEventListener('touchstart', e => {
  e.preventDefault();
  ptt = true;
  startMic();
}, { passive: false });

btn.addEventListener('touchend', e => {
  e.preventDefault();
  if (ptt) { ptt = false; stopMic(); }
}, { passive: false });

btn.addEventListener('mousedown', e => { ptt = true; startMic(); });
btn.addEventListener('mouseup', e => { if (ptt) { ptt = false; stopMic(); } });
btn.addEventListener('mouseleave', e => { if (ptt) { ptt = false; stopMic(); } });

connect();
</script>
</body>
</html>`;

// Serve PCM worklet inline
const PCM_JS = `class PCMProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._buf = []; this._size = 2048; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);
    while (this._buf.length >= this._size) {
      const chunk = this._buf.splice(0, this._size);
      const i16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(i16, [i16.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);`;

fastify.get('/', async (req, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8');
  return reply.send(HTML);
});

fastify.get('/pcm.js', async (req, reply) => {
  reply.header('Content-Type', 'application/javascript');
  return reply.send(PCM_JS);
});

fastify.register(require('@fastify/websocket'));
fastify.register(async function(fastify) {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    handleClient(socket);
  });
});

function handleClient(sock) {
  const history = [];
  let dg = null, transcript = '', timer = null, busy = false;

  function send(o) {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(o));
  }

  function startDG() {
    if (dg) { try { dg.finish(); } catch(e){} dg = null; }
    transcript = '';
    const client = createClient(DEEPGRAM_API_KEY);
    dg = client.listen.live({
      model: 'nova-2', language: 'en-US', smart_format: true,
      encoding: 'linear16', sample_rate: 16000, channels: 1,
      interim_results: true, utterance_end_ms: 1000, vad_events: true, endpointing: 400,
    });
    dg.on('open', () => send({ type: 'status', state: 'listening' }));
    dg.on('Results', data => {
      const t = data.channel?.alternatives?.[0]?.transcript || '';
      if (!t) return;
      send({ type: 'transcript', text: t, isFinal: data.is_final || data.speech_final });
      if (data.is_final) transcript = t;
      if (data.speech_final && transcript && !busy) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { const txt = transcript; transcript = ''; if (txt) process(txt); }, 200);
      }
    });
    dg.on('UtteranceEnd', () => {
      if (transcript && !busy) { const txt = transcript; transcript = ''; process(txt); }
    });
    dg.on('error', e => { console.error('DG err', e); send({ type: 'error', message: 'STT error' }); });
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
        model: 'gpt-4o',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        stream: true, max_tokens: 250, temperature: 0.7,
      });
      send({ type: 'status', state: 'speaking' });
      for await (const chunk of stream) {
        const d = chunk.choices[0]?.delta?.content || '';
        if (d) { full += d; send({ type: 'assistantChunk', text: d }); }
      }
      history.push({ role: 'assistant', content: full });
      send({ type: 'assistantDone' });
      await speakTTS(full, send);
    } catch(e) {
      console.error('process err', e);
      send({ type: 'error', message: e.message });
    } finally {
      busy = false;
      send({ type: 'status', state: 'listening' });
    }
  }

  function speakTTS(text, sendFn) {
    return new Promise(resolve => {
      const body = JSON.stringify({
        text,
        model_id: 'eleven_flash_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
        output_format: 'mp3_44100_128',
      });
      const opts = {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'audio/mpeg',
        },
      };
      const req = https.request(opts, res => {
        if (res.statusCode !== 200) {
          let err = ''; res.on('data', d => err += d);
          res.on('end', () => { console.error('TTS err', res.statusCode, err); resolve(); });
          return;
        }
        res.on('data', chunk => sendFn({ type: 'audio', data: chunk.toString('base64'), final: false }));
        res.on('end', () => { sendFn({ type: 'audio', data: '', final: true }); resolve(); });
      });
      req.on('error', e => { console.error('TTS req err', e); resolve(); });
      req.write(body); req.end();
    });
  }

  sock.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'start') { busy = false; startDG(); }
      else if (m.type === 'stop') {
        // On PTT release: use whatever transcript we have
        const txt = transcript.trim();
        transcript = '';
        if (dg) { try { dg.finish(); } catch(e){} dg = null; }
        if (txt && !busy) { process(txt); }
        else { send({ type: 'status', state: 'idle' }); }
      }
      else if (m.type === 'audio') {
        if (dg && dg.getReadyState() === 1) dg.send(Buffer.from(m.data, 'base64'));
      }
    } catch(e) { console.error(e); }
  });

  sock.on('close', () => { if (dg) { try { dg.finish(); } catch(e){} } });
}

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log('Listening on', PORT))
  .catch(e => { console.error(e); process.exit(1); });

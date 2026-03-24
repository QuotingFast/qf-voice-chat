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

// Returns signed URL for ElevenLabs conversational AI WebSocket
async function getElevenLabsSignedUrl(agentId) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      method: 'GET',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY }
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          resolve(d.signed_url);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID || 'agent_2901kme8psk8ff1a364rtt1p77ag';

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>QF Voice</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0e17;--surface:#111827;--border:#1f2937;--accent:#3b82f6;--green:#10b981;--yellow:#f59e0b;--red:#ef4444;--text:#f9fafb;--muted:#6b7280}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:32px;padding:24px}
.header{text-align:center}
.logo{font-size:48px;margin-bottom:8px}
h1{font-size:22px;font-weight:700}
.sub{font-size:13px;color:var(--muted);margin-top:4px}
.orb-wrap{position:relative;display:flex;align-items:center;justify-content:center}
.orb{width:120px;height:120px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:44px;cursor:pointer;border:none;color:white;transition:all .3s;-webkit-tap-highlight-color:transparent;user-select:none;box-shadow:0 0 0 0 rgba(59,130,246,.4)}
.orb.listening{background:var(--red);animation:ripple 1.5s infinite}
.orb.thinking{background:var(--yellow);animation:breathe 1s infinite}
.orb.speaking{background:var(--green);animation:breathe .8s infinite}
@keyframes ripple{0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}70%{box-shadow:0 0 0 24px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
.status-text{font-size:16px;font-weight:600;text-align:center;min-height:24px}
.transcript{max-width:320px;text-align:center;font-size:14px;color:var(--muted);line-height:1.6;min-height:40px}
.hint{font-size:12px;color:var(--muted);text-align:center}
#err{display:none;position:fixed;bottom:20px;left:16px;right:16px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.4);color:#fca5a5;padding:10px 14px;font-size:13px;text-align:center;border-radius:8px}
</style>
</head>
<body>
<div class="header">
  <div class="logo">🎙</div>
  <h1>QF Voice</h1>
  <div class="sub">QuotingFast AI Assistant</div>
</div>

<button class="orb" id="orb" onclick="toggle()">🎙</button>

<div>
  <div class="status-text" id="status">Tap to start</div>
  <div class="transcript" id="transcript"></div>
</div>

<div class="hint">Tap to start · tap again to stop</div>
<div id="err"></div>

<script src="https://cdn.jsdelivr.net/npm/@11labs/client@latest/dist/index.umd.js"></script>
<script>
let conv = null;
let running = false;

function setUI(state, statusText, transcriptText) {
  const orb = document.getElementById('orb');
  const status = document.getElementById('status');
  const transcript = document.getElementById('transcript');
  orb.className = 'orb' + (state ? ' ' + state : '');
  if (state === 'listening') orb.textContent = '🔴';
  else if (state === 'thinking') orb.textContent = '⏳';
  else if (state === 'speaking') orb.textContent = '🔊';
  else orb.textContent = '🎙';
  if (statusText) status.textContent = statusText;
  if (transcriptText !== undefined) transcript.textContent = transcriptText;
}

function showErr(msg) {
  const el = document.getElementById('err');
  el.textContent = '⚠️ ' + msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 8000);
}

async function toggle() {
  if (running) {
    // Stop
    running = false;
    if (conv) { await conv.endSession(); conv = null; }
    setUI('', 'Tap to start', '');
    return;
  }

  running = true;
  setUI('thinking', 'Connecting...', '');

  try {
    // Get signed URL from our server (keeps API key private)
    const res = await fetch('/signed-url');
    const { signed_url } = await res.json();

    conv = await ElevenLabsClient.Conversation.startSession({
      signedUrl: signed_url,
      onConnect: () => setUI('listening', 'Listening...', ''),
      onDisconnect: () => {
        running = false;
        conv = null;
        setUI('', 'Tap to start', '');
      },
      onModeChange: ({ mode }) => {
        if (mode === 'speaking') setUI('speaking', 'Speaking...', '');
        else if (mode === 'listening') setUI('listening', 'Listening...', '');
      },
      onMessage: ({ message, source }) => {
        const transcript = document.getElementById('transcript');
        if (source === 'user') transcript.textContent = 'You: ' + message;
        else transcript.textContent = 'AI: ' + message;
      },
      onError: (err) => {
        showErr(typeof err === 'string' ? err : JSON.stringify(err));
        running = false;
        conv = null;
        setUI('', 'Tap to start', '');
      }
    });
  } catch(e) {
    showErr(e.message || String(e));
    running = false;
    conv = null;
    setUI('', 'Tap to start', '');
  }
}
</script>
</body>
</html>`;

// Signed URL endpoint — keeps API key server-side
fastify.get('/signed-url', async (req, reply) => {
  try {
    const signed_url = await getElevenLabsSignedUrl(AGENT_ID);
    return { signed_url };
  } catch(e) {
    reply.code(500).send({ error: e.message });
  }
});

fastify.get('/', async (req, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8');
  return reply.send(HTML);
});

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log('Listening on', PORT))
  .catch(e => { console.error(e); process.exit(1); });

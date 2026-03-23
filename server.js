'use strict';

const fastify = require('fastify')({ logger: true });
const path = require('path');
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

const SYSTEM_PROMPT = `You are an AI assistant for Tom Fuselier at QuotingFast, an insurance lead generation company. You have full context of his business — live transfers, ping/post lead validation, AI dialer, CRM. Be direct, helpful, and concise. Voice responses should be 1-3 sentences max unless asked for more detail.`;

fastify.register(require('@fastify/static'), { root: path.join(__dirname, 'public') });
fastify.register(require('@fastify/websocket'));

fastify.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    handleClientConnection(socket);
  });
});

function handleClientConnection(clientSocket) {
  console.log('Client connected');
  const conversationHistory = [];
  let deepgramLive = null;
  let currentTranscript = '';
  let latestTranscript = ''; // tracks most recent (interim or final)
  let speechTimer = null;
  let isProcessing = false;

  function send(data) {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify(data));
    }
  }

  function startDeepgram() {
    if (deepgramLive) { try { deepgramLive.finish(); } catch (e) {} deepgramLive = null; }
    currentTranscript = '';
    const dg = createClient(DEEPGRAM_API_KEY);
    deepgramLive = dg.listen.live({
      model: 'nova-2', language: 'en-US', smart_format: true,
      interim_results: true, utterance_end_ms: 1000, vad_events: true, endpointing: 400,
      encoding: 'linear16', sample_rate: 16000,
    });

    deepgramLive.on('open', () => { console.log('Deepgram open'); send({ type: 'status', state: 'listening' }); });

    deepgramLive.on('Results', (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript || '';
      const isFinal = data.is_final;
      const speechFinal = data.speech_final;
      if (!transcript.trim()) return;
      send({ type: 'transcript', text: transcript, isFinal: isFinal || speechFinal });
      latestTranscript = transcript; // track most recent regardless of finality
      if (isFinal) currentTranscript = transcript;
      if (speechFinal && currentTranscript.trim() && !isProcessing) {
        if (speechTimer) clearTimeout(speechTimer);
        speechTimer = setTimeout(() => {
          const text = currentTranscript.trim();
          currentTranscript = '';
          if (text) processUserInput(text);
        }, 200);
      }
    });

    deepgramLive.on('UtteranceEnd', () => {
      if (currentTranscript.trim() && !isProcessing) {
        if (speechTimer) clearTimeout(speechTimer);
        const text = currentTranscript.trim();
        currentTranscript = '';
        processUserInput(text);
      }
    });

    deepgramLive.on('error', (err) => { console.error('Deepgram error:', err); send({ type: 'error', message: 'STT error' }); });
    deepgramLive.on('close', () => console.log('Deepgram closed'));
  }

  async function processUserInput(text) {
    if (isProcessing) return;
    isProcessing = true;
    console.log('User:', text);
    send({ type: 'status', state: 'thinking' });
    send({ type: 'userMessage', text });
    conversationHistory.push({ role: 'user', content: text });

    try {
      let fullResponse = '';
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...conversationHistory],
        stream: true, max_tokens: 300, temperature: 0.7,
      });

      send({ type: 'status', state: 'speaking' });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) { fullResponse += delta; send({ type: 'assistantChunk', text: delta }); }
      }
      conversationHistory.push({ role: 'assistant', content: fullResponse });
      send({ type: 'assistantDone' });

      await speakWithElevenLabs(fullResponse, send);
    } catch (err) {
      console.error('Processing error:', err);
      send({ type: 'error', message: err.message });
    } finally {
      isProcessing = false;
      send({ type: 'status', state: 'listening' });
    }
  }

  function speakWithElevenLabs(text, sendFn) {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
      });
      const options = {
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
      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let err = ''; res.on('data', d => err += d);
          res.on('end', () => { console.error('ElevenLabs', res.statusCode, err); resolve(); });
          return;
        }
        res.on('data', (chunk) => sendFn({ type: 'audio', data: chunk.toString('base64'), final: false }));
        res.on('end', () => { sendFn({ type: 'audio', data: '', final: true }); resolve(); });
      });
      req.on('error', (err) => { console.error('ElevenLabs req error:', err); resolve(); });
      req.write(body); req.end();
    });
  }

  clientSocket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'start') { isProcessing = false; startDeepgram(); }
      else if (msg.type === 'stop') {
        // Use best available transcript: prefer is_final result, fall back to latest interim
        const pendingText = (currentTranscript || latestTranscript).trim();
        if (deepgramLive) {
          try { deepgramLive.finalize(); } catch (e) {}
          try { deepgramLive.finish(); } catch (e) {}
          deepgramLive = null;
        }
        currentTranscript = '';
        latestTranscript = '';
        if (pendingText && !isProcessing) {
          processUserInput(pendingText);
        } else if (!isProcessing) {
          send({ type: 'status', state: 'idle' });
        }
      } else if (msg.type === 'audio') {
        if (deepgramLive && deepgramLive.getReadyState() === 1) {
          deepgramLive.send(Buffer.from(msg.data, 'base64'));
        }
      } else if (msg.type === 'clearHistory') {
        conversationHistory.length = 0;
        send({ type: 'historyCleared' });
      }
    } catch (e) { console.error('msg error:', e); }
  });

  clientSocket.on('close', () => { if (deepgramLive) { try { deepgramLive.finish(); } catch (e) {} } });
}

async function start() {
  try { await fastify.listen({ port: PORT, host: '0.0.0.0' }); console.log(`Port ${PORT}`); }
  catch (err) { console.error(err); process.exit(1); }
}
start();

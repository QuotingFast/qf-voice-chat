'use strict';

const fastify = require('fastify')({ logger: false });
const path = require('path');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const OpenAI = require('openai');

const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '8kvxG72xUMYnIFhZYwWj';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are an AI assistant for Tom Fuselier at QuotingFast, an insurance lead generation company. You have full context of his business — live transfers, ping/post lead validation, AI dialer, CRM. Be direct, helpful, and concise. Voice responses should be 1-3 sentences max unless asked for more detail.`;

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
});

fastify.register(require('@fastify/websocket'));

fastify.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    handleClientConnection(socket);
  });
});

function handleClientConnection(clientSocket) {
  console.log('Client connected');
  
  const conversationHistory = [];
  let deepgramSocket = null;
  let currentTranscript = '';
  let transcriptTimer = null;
  let isProcessing = false;

  function sendToClient(data) {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify(data));
    }
  }

  function startDeepgram() {
    if (deepgramSocket) {
      try { deepgramSocket.finish(); } catch(e) {}
      deepgramSocket = null;
    }

    const dgClient = createClient(DEEPGRAM_API_KEY);
    
    deepgramSocket = dgClient.listen.live({
      model: 'nova-2',
      language: 'en-US',
      smart_format: true,
      interim_results: true,
      utterance_end_ms: 1200,
      vad_events: true,
      endpointing: 500,
    });

    deepgramSocket.on('open', () => {
      console.log('Deepgram connected');
      sendToClient({ type: 'status', state: 'listening' });
    });

    deepgramSocket.on('Results', (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      const isFinal = data.is_final;
      const speechFinal = data.speech_final;

      if (transcript && transcript.trim()) {
        currentTranscript = transcript;
        sendToClient({ type: 'transcript', text: transcript, isFinal: isFinal || speechFinal });
        
        if (speechFinal && transcript.trim().length > 0) {
          if (transcriptTimer) clearTimeout(transcriptTimer);
          transcriptTimer = setTimeout(() => {
            if (currentTranscript.trim() && !isProcessing) {
              processUserInput(currentTranscript.trim());
              currentTranscript = '';
            }
          }, 300);
        }
      }
    });

    deepgramSocket.on('UtteranceEnd', (data) => {
      if (currentTranscript.trim() && !isProcessing) {
        if (transcriptTimer) clearTimeout(transcriptTimer);
        processUserInput(currentTranscript.trim());
        currentTranscript = '';
      }
    });

    deepgramSocket.on('error', (err) => {
      console.error('Deepgram error:', err);
      sendToClient({ type: 'error', message: 'STT error: ' + err.message });
    });

    deepgramSocket.on('close', () => {
      console.log('Deepgram closed');
    });

    return deepgramSocket;
  }

  async function processUserInput(text) {
    if (isProcessing) return;
    isProcessing = true;
    
    console.log('Processing:', text);
    sendToClient({ type: 'status', state: 'thinking' });
    sendToClient({ type: 'userMessage', text });

    conversationHistory.push({ role: 'user', content: text });

    try {
      let fullResponse = '';
      let buffer = '';

      const stream = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...conversationHistory,
        ],
        stream: true,
        max_tokens: 200,
        temperature: 0.7,
      });

      sendToClient({ type: 'status', state: 'speaking' });

      let ttsSocket = null;
      try {
        ttsSocket = await startElevenLabsTTS();
      } catch(e) {
        console.error('TTS connect failed:', e.message);
      }
      
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullResponse += delta;
          buffer += delta;
          sendToClient({ type: 'assistantChunk', text: delta });
          
          if (ttsSocket && ttsSocket.readyState === WebSocket.OPEN) {
            if (buffer.length > 50 || /[.!?]/.test(delta)) {
              ttsSocket.send(JSON.stringify({ text: buffer, flush: false }));
              buffer = '';
            }
          }
        }
      }

      if (ttsSocket && ttsSocket.readyState === WebSocket.OPEN) {
        ttsSocket.send(JSON.stringify({ text: buffer || '', flush: true }));
      }

      conversationHistory.push({ role: 'assistant', content: fullResponse });
      sendToClient({ type: 'assistantMessage', text: fullResponse });

      if (ttsSocket) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 20000);
          ttsSocket.on('close', () => { clearTimeout(timeout); resolve(); });
          if (ttsSocket.readyState === WebSocket.CLOSED) { clearTimeout(timeout); resolve(); }
        });
      }

    } catch (err) {
      console.error('Processing error:', err);
      sendToClient({ type: 'error', message: 'Processing error: ' + err.message });
    } finally {
      isProcessing = false;
      sendToClient({ type: 'status', state: 'listening' });
    }
  }

  function startElevenLabsTTS() {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_flash_v2_5&output_format=mp3_44100_128`;
      
      const ttsSocket = new WebSocket(wsUrl, {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY }
      });

      const connectTimer = setTimeout(() => reject(new Error('TTS connection timeout')), 10000);

      ttsSocket.on('open', () => {
        clearTimeout(connectTimer);
        ttsSocket.send(JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: 1.0,
          },
          xi_api_key: ELEVENLABS_API_KEY,
        }));
        resolve(ttsSocket);
      });

      ttsSocket.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.audio) {
            sendToClient({ type: 'audio', data: msg.audio });
          }
          if (msg.isFinal) {
            ttsSocket.close();
          }
        } catch (e) {}
      });

      ttsSocket.on('error', (err) => {
        clearTimeout(connectTimer);
        console.error('ElevenLabs TTS error:', err.message);
        reject(err);
      });
    });
  }

  clientSocket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      
      if (msg.type === 'start') {
        currentTranscript = '';
        isProcessing = false;
        startDeepgram();
      } else if (msg.type === 'stop') {
        if (deepgramSocket) {
          try { deepgramSocket.finish(); } catch(e) {}
          deepgramSocket = null;
        }
        sendToClient({ type: 'status', state: 'idle' });
      } else if (msg.type === 'audio') {
        if (deepgramSocket && deepgramSocket.getReadyState() === 1) {
          deepgramSocket.send(Buffer.from(msg.data, 'base64'));
        }
      } else if (msg.type === 'clearHistory') {
        conversationHistory.length = 0;
        sendToClient({ type: 'historyCleared' });
      }
    } catch (e) {
      console.error('Message parse error:', e);
    }
  });

  clientSocket.on('close', () => {
    console.log('Client disconnected');
    if (deepgramSocket) {
      try { deepgramSocket.finish(); } catch(e) {}
    }
  });
}

async function start() {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server running on port ${PORT}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();

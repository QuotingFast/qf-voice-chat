'use strict';

const fastify = require('fastify')({ logger: false });
const PORT = process.env.PORT || 3000;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>QF Voice</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0a0e17; color: #f9fafb;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  min-height: 100dvh; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 24px; padding: 24px;
}
.logo { font-size: 52px; text-align: center; margin-bottom: 6px; }
h1 { font-size: 24px; font-weight: 700; text-align: center; }
.sub { font-size: 14px; color: #6b7280; text-align: center; margin-top: 4px; }
.box {
  width: 100%; max-width: 420px; background: #111827;
  border: 1px solid #1f2937; border-radius: 20px;
  padding: 28px 24px; display: flex; flex-direction: column;
  align-items: center; gap: 16px;
}
.hint { font-size: 12px; color: #6b7280; text-align: center; }
</style>
</head>
<body>
  <div>
    <div class="logo">🎙</div>
    <h1>QF Voice</h1>
    <div class="sub">QuotingFast AI Assistant</div>
  </div>
  <div class="box">
    <elevenlabs-convai agent-id="agent_2901kme8psk8ff1a364rtt1p77ag"></elevenlabs-convai>
    <div class="hint">Tap the mic · speak naturally · AI talks back</div>
  </div>
  <script src="https://elevenlabs.io/convai-widget/index.js" async type="text/javascript"></script>
</body>
</html>`;

fastify.get('/', async (req, reply) => {
  reply.header('Content-Type', 'text/html; charset=utf-8');
  return reply.send(HTML);
});

fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log('Port', PORT))
  .catch(e => { console.error(e); process.exit(1); });

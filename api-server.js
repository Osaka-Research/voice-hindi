const http = require('http');
const { normalizeAndExtract, transcribeAudio } = require('./pipeline');
const { checkAndConsume } = require('./keystore');

const PORT = process.env.PORT || 8082;
const MAX_BODY = 20 * 1024 * 1024; // 20MB cap — a few minutes of webm audio

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/v1/bill') {
    try {
      const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing API key — pass X-API-Key or Authorization: Bearer <key>' }));
        return;
      }
      const check = checkAndConsume(apiKey);
      if (!check.ok) {
        const status = check.reason === 'invalid_key' ? 401 : 429;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: check.reason }));
        return;
      }

      const audioBuffer = await readBody(req);
      if (!audioBuffer.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'empty audio body — send raw audio bytes (webm/wav/mp3/etc)' }));
        return;
      }

      const language = req.headers['x-language'] || 'hi';
      const rawTranscript = await transcribeAudio(audioBuffer, { language });
      if (!rawTranscript) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ transcript: '', items: [] }));
        return;
      }
      const { transcript, items } = await normalizeAndExtract(rawTranscript);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transcript, items }));
    } catch (err) {
      const status = err.status === 429 ? 429 : (err.status || 500);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.status === 429 ? 'upstream_rate_limited' : err.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`public API listening on :${PORT}`);
});

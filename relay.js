const http = require('http');
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { normalize, extractBilling, appendFeedback, saveAudioSample } = require('./pipeline');

const execFileP = promisify(execFile);

const PORT = process.env.PORT || 8081;

// Real ASR models present on this device (excludes whisper.cpp's for-tests-*
// stub weights, which produce garbage on real audio, and the VAD-only silero
// model — neither is a transcription model).
const WHISPER_CLI = path.join(os.homedir(), 'whisper.cpp/build/bin/whisper-cli');
const MODELS_DIR = path.join(os.homedir(), 'whisper.cpp/models');
const COMPARE_MODELS = [
  { tag: 'base', file: 'ggml-base.bin', lang: 'hi' },
  { tag: 'base.en', file: 'ggml-base.en.bin', lang: 'en' },
  { tag: 'small', file: 'ggml-small.bin', lang: 'hi' }
];

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/compare') {
    (async () => {
      const id = 'cmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const rawPath = path.join(os.tmpdir(), id + '.webm');
      const wavPath = path.join(os.tmpdir(), id + '.wav');
      try {
        const audioBuffer = await readRawBody(req);
        if (!audioBuffer.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'empty audio body' }));
          return;
        }
        await fsp.writeFile(rawPath, audioBuffer);
        await execFileP('ffmpeg', ['-y', '-i', rawPath, '-ar', '16000', '-ac', '1', wavPath]);

        const results = [];
        for (const m of COMPARE_MODELS) {
          const start = Date.now();
          try {
            const { stdout } = await execFileP(
              WHISPER_CLI,
              ['-m', path.join(MODELS_DIR, m.file), '-f', wavPath, '-l', m.lang, '-nt', '-np'],
              { maxBuffer: 10 * 1024 * 1024 }
            );
            results.push({ tag: m.tag, language: m.lang, transcript: stdout.trim(), seconds: +((Date.now() - start) / 1000).toFixed(1) });
          } catch (err) {
            results.push({ tag: m.tag, language: m.lang, transcript: '', error: err.message, seconds: +((Date.now() - start) / 1000).toFixed(1) });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } finally {
        fsp.unlink(rawPath).catch(() => {});
        fsp.unlink(wavPath).catch(() => {});
      }
    })();
    return;
  }

  if (req.method === 'POST' && req.url === '/normalize') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || !text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'empty text' }));
          return;
        }
        const normalized = await normalize(text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: normalized }));
      } catch (err) {
        console.error(err);
        res.writeHead(err.status === 429 ? 429 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.status === 429 ? 'rate_limited' : err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/billing') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text, model } = JSON.parse(body);
        if (!text || !text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'empty text' }));
          return;
        }
        const items = await extractBilling(text, model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items }));
      } catch (err) {
        console.error(err);
        res.writeHead(err.status === 429 ? 429 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.status === 429 ? 'rate_limited' : err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/feedback') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);
        if (!entry.type || (entry.type !== 'transcript' && entry.type !== 'billing')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'type must be "transcript" or "billing"' }));
          return;
        }
        appendFeedback(entry);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/audio-sample') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { id, audioBase64, rawTranscript, correctedTranscript } = JSON.parse(body);
        saveAudioSample({ id, audioBase64, rawTranscript, correctedTranscript });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`normalize relay listening on :${PORT}`);
});

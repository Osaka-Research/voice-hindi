const fs = require('fs');
const os = require('os');
const path = require('path');

function loadGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  // Local Termux fallback — not present in cloud deployments, which must set the env var.
  const envPath = path.join(os.homedir(), '.config', 'voice-hindi.env');
  if (fs.existsSync(envPath)) {
    const match = fs.readFileSync(envPath, 'utf8').match(/^GEMINI_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  }
  throw new Error('GEMINI_API_KEY not set — export it or create ~/.config/voice-hindi.env');
}
const GEMINI_API_KEY = loadGeminiKey();

const MODEL = 'gemini-flash-lite-latest';
const WHISPER_SERVER_URL = process.env.WHISPER_SERVER_URL || 'http://127.0.0.1:8080/inference';

// All persistent state lives under DATA_DIR — defaults to this file's own directory for
// local Termux use, but should be pointed at a mounted volume in any container deployment
// so it survives rebuilds/restarts.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TRAINING_LOG = path.join(DATA_DIR, 'training_data.jsonl');
const MAX_EXAMPLES = 5;

// Audio + ground-truth-transcript pairs — the actual input needed for real
// Whisper fine-tuning later. training_data.jsonl above only holds text-level
// corrections (used for Gemini few-shot), not audio.
const AUDIO_DIR = path.join(DATA_DIR, 'training_audio');
const AUDIO_MANIFEST = path.join(AUDIO_DIR, 'manifest.jsonl');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

function saveAudioSample({ id, audioBase64, rawTranscript, correctedTranscript }) {
  if (!id) throw new Error('id required');
  let audioFile = null;
  if (audioBase64) {
    audioFile = id + '.webm';
    fs.writeFileSync(path.join(AUDIO_DIR, audioFile), Buffer.from(audioBase64, 'base64'));
  }
  const entry = { id, audioFile, rawTranscript, correctedTranscript, at: new Date().toISOString() };
  fs.appendFileSync(AUDIO_MANIFEST, JSON.stringify(entry) + '\n');
}

function appendFeedback(entry) {
  fs.appendFileSync(TRAINING_LOG, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n');
}

function loadRecentExamples(type) {
  if (!fs.existsSync(TRAINING_LOG)) return [];
  const lines = fs.readFileSync(TRAINING_LOG, 'utf8').trim().split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.type === type) entries.push(e);
    } catch {}
  }
  return entries.slice(-MAX_EXAMPLES);
}

function fewShotBlock(type) {
  const examples = loadRecentExamples(type);
  if (!examples.length) return '';
  const rendered = examples.map(e => {
    if (type === 'transcript') return `Input: "${e.raw}"\nCorrect output: "${e.corrected}"`;
    return `Input: "${e.text}"\nCorrect output: ${JSON.stringify(e.corrected)}`;
  }).join('\n\n');
  return `\n\nHere are recent user-corrected examples — match this style/behavior on similar inputs:\n\n${rendered}`;
}

const SYSTEM_PROMPT = `You normalize spoken Hindi/Hinglish transcripts. Convert Hindi number words (spelled in Devanagari or Latin script, e.g. "chalis", "चालीस") to digits (e.g. "40"). Combine compound Indian-style numbers into one final digit — "सौ"/"hundred", "हज़ार"/"thousand", "लाख"/"lakh", "करोड़"/"crore" must be merged with their surrounding number words into a single number, e.g. "दो हज़ार पांच सौ" → "2500", "एक सौ चालीस" → "140". Never leave सौ/हज़ार/लाख/करोड़ as standalone words in the output when they are part of a number phrase. Use sentence context to resolve ambiguous words like "दो"/"do" (could mean "two" or the verb "give") — only convert when it is clearly a number. Leave everything else in the text completely unchanged: no translation, no rephrasing, no punctuation changes. Output ONLY the normalized transcript text, nothing else.`;

async function normalize(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT + fewShotBlock('transcript') }] },
    contents: [{ parts: [{ text }] }],
    generationConfig: { temperature: 0 }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini API ${res.status}: ${errText}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const out = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) throw new Error('No text in Gemini response: ' + JSON.stringify(data));
  return out.trim();
}

const BILLING_PROMPT = `You are a billing assistant for a small Indian kirana/grocery shop. The input is a spoken Hindi/Hinglish transcript describing items bought and their prices, e.g. "40 ki maggi 2 50 ka kanda" means: one Maggi at ₹40, and 2 kanda (onion) at ₹50 each. Extract each line item as {product, price, qty}: price = per-unit price in rupees, qty = quantity/count (default 1 if not stated explicitly). Common spoken patterns:
- "<price> ki/ka <product>" → qty=1
- "<qty> <price> ka <product>" or "<product> <qty> <price> ka" → qty units at that price each
Keep product names as spoken, transliterated to simple lowercase Latin (e.g. "kanda", "maggi", "aloo", "tamatar"). If a phrase is unclear or not a billing item, skip it. Return structured JSON matching the schema only.`;

const ALLOWED_MODELS = ['gemini-flash-lite-latest', 'gemma-4-26b-a4b-it'];

async function extractBilling(text, model = MODEL) {
  if (!ALLOWED_MODELS.includes(model)) model = MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    system_instruction: { parts: [{ text: BILLING_PROMPT + fewShotBlock('billing') }] },
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                product: { type: 'STRING' },
                price: { type: 'NUMBER' },
                qty: { type: 'NUMBER' }
              },
              required: ['product', 'price', 'qty']
            }
          }
        },
        required: ['items']
      }
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini API ${res.status}: ${errText}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const out = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) throw new Error('No text in Gemini response: ' + JSON.stringify(data));
  const parsed = JSON.parse(out);
  return parsed.items || [];
}

const COMBINED_PROMPT = `You process spoken Hindi/Hinglish billing transcripts in one pass. First normalize the transcript, then extract billing line items from the normalized text.

Step 1 — normalize: Convert Hindi number words (spelled in Devanagari or Latin script, e.g. "chalis", "चालीस") to digits (e.g. "40"). Combine compound Indian-style numbers into one final digit — "सौ"/"hundred", "हज़ार"/"thousand", "लाख"/"lakh", "करोड़"/"crore" must be merged with their surrounding number words into a single number, e.g. "दो हज़ार पांच सौ" → "2500", "एक सौ चालीस" → "140". Never leave सौ/हज़ार/लाख/करोड़ as standalone words in the output when they are part of a number phrase. Use sentence context to resolve ambiguous words like "दो"/"do" (could mean "two" or the verb "give") — only convert when it is clearly a number. Leave everything else in the text completely unchanged: no translation, no rephrasing, no punctuation changes.

Step 2 — extract: This is a billing assistant for a small Indian kirana/grocery shop. The normalized transcript describes items bought and their prices, e.g. "40 ki maggi 2 50 ka kanda" means: one Maggi at ₹40, and 2 kanda (onion) at ₹50 each. Extract each line item as {product, price, qty}: price = per-unit price in rupees, qty = quantity/count (default 1 if not stated explicitly). Common spoken patterns:
- "<price> ki/ka <product>" → qty=1
- "<qty> <price> ka <product>" or "<product> <qty> <price> ka" → qty units at that price each
Keep product names as spoken, transliterated to simple lowercase Latin (e.g. "kanda", "maggi", "aloo", "tamatar"). If a phrase is unclear or not a billing item, skip it.

Return structured JSON matching the schema only: the normalized transcript plus the extracted items.`;

async function normalizeAndExtract(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    system_instruction: { parts: [{ text: COMBINED_PROMPT + fewShotBlock('transcript') + fewShotBlock('billing') }] },
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          transcript: { type: 'STRING' },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                product: { type: 'STRING' },
                price: { type: 'NUMBER' },
                qty: { type: 'NUMBER' }
              },
              required: ['product', 'price', 'qty']
            }
          }
        },
        required: ['transcript', 'items']
      }
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini API ${res.status}: ${errText}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const out = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) throw new Error('No text in Gemini response: ' + JSON.stringify(data));
  const parsed = JSON.parse(out);
  return { transcript: parsed.transcript || '', items: parsed.items || [] };
}

async function transcribeAudio(buffer, { language = 'hi' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), 'audio.webm');
  form.append('language', language);
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  form.append('translate', 'false');
  form.append('prompt', 'शून्य एक दो तीन चार पांच छह सात आठ नौ दस बीस तीस चालीस पचास साठ सत्तर अस्सी नब्बे सौ हज़ार लाख रुपये किलो');
  const res = await fetch(WHISPER_SERVER_URL, { method: 'POST', body: form });
  if (!res.ok) throw new Error('whisper-server ' + res.status);
  const data = await res.json();
  return (data.text || '').trim();
}

module.exports = {
  normalize,
  extractBilling,
  normalizeAndExtract,
  transcribeAudio,
  appendFeedback,
  saveAudioSample
};

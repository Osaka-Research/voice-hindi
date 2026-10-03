const recBtn = document.getElementById('recBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const spinnerEl = document.getElementById('spinner');
const keyInput = document.getElementById('keyInput');
const keySave = document.getElementById('keySave');
const keyClear = document.getElementById('keyClear');
const keyStatus = document.getElementById('keyStatus');

const TAG_CLASS = { 'base': 'base', 'base.en': 'base-en', 'small': 'small', 'openai-whisper-1': 'openai' };
const KEY_STORAGE = 'vh_compare_openai_key';

function maskKey(k) { return k.length > 8 ? k.slice(0, 5) + '…' + k.slice(-4) : '••••'; }

function refreshKeyStatus() {
  const k = sessionStorage.getItem(KEY_STORAGE);
  keyStatus.textContent = k ? ('Key set: ' + maskKey(k)) : '';
}
refreshKeyStatus();

keySave.addEventListener('click', () => {
  const k = keyInput.value.trim();
  if (!k) return;
  sessionStorage.setItem(KEY_STORAGE, k);
  keyInput.value = '';
  refreshKeyStatus();
});
keyClear.addEventListener('click', () => {
  sessionStorage.removeItem(KEY_STORAGE);
  refreshKeyStatus();
});

let recording = false;
let micStream = null;
let mediaRecorder = null;
let chunks = [];
let recordStart = 0;

recBtn.addEventListener('click', async () => {
  if (!recording) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      mediaRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
      chunks = [];
      mediaRecorder.ondataavailable = e => chunks.push(e.data);
      mediaRecorder.onstop = () => {
        micStream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const durationSec = (Date.now() - recordStart) / 1000;
        runCompare(blob, durationSec);
      };
      recordStart = Date.now();
      mediaRecorder.start();
      recording = true;
      recBtn.textContent = '⏹️';
      recBtn.classList.add('recording');
      statusEl.textContent = 'Listening… tap again to stop.';
    } catch (err) {
      statusEl.textContent = 'Mic error: ' + err.message;
    }
  } else {
    recording = false;
    recBtn.textContent = '🎙️';
    recBtn.classList.remove('recording');
    mediaRecorder.stop();
  }
});

function timingClass(seconds) {
  if (seconds == null) return 'pending';
  if (seconds < 5) return 'fast';
  if (seconds < 15) return 'mid';
  return 'slow';
}

function cardEl(tag) {
  const div = document.createElement('div');
  div.className = 'card';
  div.dataset.tag = tag;
  return div;
}

function paintCard(div, r) {
  const tagCls = TAG_CLASS[r.tag] || '';
  const timingHtml = r.seconds == null
    ? `<span class="timing pending">running…</span>`
    : `<span class="timing ${timingClass(r.seconds)}">${r.seconds}s</span>`;
  const costHtml = r.cost != null ? `<span class="cost">$${r.cost}</span>` : '';
  const transcriptCls = r.error ? 'transcript err' : (r.transcript ? 'transcript' : (r.seconds == null ? 'transcript empty' : 'transcript empty'));
  const transcriptText = r.error ? ('Error: ' + r.error) : (r.transcript || (r.seconds == null ? 'transcribing…' : '(no speech detected)'));
  div.innerHTML = `
    <div class="card-head">
      <span><span class="tag ${tagCls}">${r.tag}</span><span class="lang">lang=${r.language}</span></span>
      <span>${timingHtml}${costHtml}</span>
    </div>
    <div class="${transcriptCls}"></div>
  `;
  div.querySelector('.transcript').textContent = transcriptText;
}

async function fetchLocal(blob) {
  const res = await fetch('http://' + location.hostname + ':8081/compare', { method: 'POST', body: blob });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || ('relay ' + res.status));
  }
  const data = await res.json();
  return data.results;
}

async function fetchOpenAI(blob, key, durationSec) {
  const start = Date.now();
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', 'whisper-1');
  form.append('language', 'hi');
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key },
      body: form
    });
    const seconds = +((Date.now() - start) / 1000).toFixed(1);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return { tag: 'openai-whisper-1', language: 'hi', error: errData.error?.message || ('HTTP ' + res.status), seconds };
    }
    const data = await res.json();
    const cost = durationSec != null ? +(durationSec / 60 * 0.006).toFixed(5) : null;
    return { tag: 'openai-whisper-1', language: 'hi', transcript: (data.text || '').trim(), seconds, cost };
  } catch (err) {
    const seconds = +((Date.now() - start) / 1000).toFixed(1);
    return { tag: 'openai-whisper-1', language: 'hi', error: err.message + ' (network/CORS)', seconds };
  }
}

async function runCompare(blob, durationSec) {
  statusEl.textContent = 'Uploading…';
  statusEl.classList.add('busy');
  spinnerEl.classList.add('on');
  resultsEl.innerHTML = '';
  recBtn.disabled = true;

  const key = sessionStorage.getItem(KEY_STORAGE);
  let openaiCard = null;
  if (key) {
    openaiCard = cardEl('openai-whisper-1');
    paintCard(openaiCard, { tag: 'openai-whisper-1', language: 'hi', seconds: null });
    resultsEl.appendChild(openaiCard);
    fetchOpenAI(blob, key, durationSec).then(r => paintCard(openaiCard, r));
  }

  try {
    const results = await fetchLocal(blob);
    for (const r of results) {
      const div = cardEl(r.tag);
      paintCard(div, r);
      resultsEl.insertBefore(div, openaiCard || null);
    }
    statusEl.textContent = 'Done. Tap the button to record another phrase.';
  } catch (err) {
    const div = document.createElement('div');
    div.id = 'placeholder';
    div.textContent = 'Local models failed: ' + err.message;
    resultsEl.insertBefore(div, openaiCard || null);
    statusEl.textContent = 'Failed.';
  } finally {
    statusEl.classList.remove('busy');
    spinnerEl.classList.remove('on');
    recBtn.disabled = false;
  }
}

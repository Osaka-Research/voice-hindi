const statusEl = document.getElementById('status');
const billArea = document.getElementById('billArea');
const transcriptEl = document.getElementById('transcript');
const recBtn = document.getElementById('recBtn');
const clearBtn = document.getElementById('clearBtn');
const printBtn = document.getElementById('printBtn');
const speakBtn = document.getElementById('speakBtn');
const modelSel = document.getElementById('modelSel');

let mediaRecorder, chunks = [], recording = false, billItems = [];
let micStream = null, audioCtx = null, analyser = null, vadTimer = null, pendingCount = 0;
let vadSpeaking = false, vadSilenceStart = null, vadSpeechStart = null;

// Tunable per-device — mic sensitivity and room noise vary a lot. If phrases cut off
// too early/late, adjust these.
const VAD_RMS_THRESHOLD = 0.02;
const VAD_SILENCE_MS = 900;   // pause length that ends a phrase
const VAD_MIN_SPEECH_MS = 300; // ignore blips shorter than this
const MIN_CLIP_BYTES = 3000;   // skip near-empty phrase recordings

const HI_NUMS = {
  'शून्य':0,'एक':1,'दो':2,'तीन':3,'चार':4,'पांच':5,'पाँच':5,'छह':6,'छः':6,'सात':7,'आठ':8,'नौ':9,
  'दस':10,'ग्यारह':11,'बारह':12,'तेरह':13,'चौदह':14,'पंद्रह':15,'पन्द्रह':15,'सोलह':16,'सत्रह':17,'अठारह':18,'उन्नीस':19,
  'बीस':20,'इक्कीस':21,'बाईस':22,'तेईस':23,'चौबीस':24,'पच्चीस':25,'छब्बीस':26,'सत्ताईस':27,'अट्ठाईस':28,'उनतीस':29,
  'तीस':30,'इकतीस':31,'बत्तीस':32,'तैंतीस':33,'चौंतीस':34,'पैंतीस':35,'छत्तीस':36,'सैंतीस':37,'अड़तीस':38,'उनतालीस':39,
  'चालीस':40,'इकतालीस':41,'बयालीस':42,'तैंतालीस':43,'चवालीस':44,'पैंतालीस':45,'छियालीस':46,'सैंतालीस':47,'अड़तालीस':48,'उनचास':49,
  'पचास':50,'इक्यावन':51,'बावन':52,'तिरेपन':53,'चौवन':54,'पचपन':55,'छप्पन':56,'सत्तावन':57,'अट्ठावन':58,'उनसठ':59,
  'साठ':60,'इकसठ':61,'बासठ':62,'तिरसठ':63,'चौंसठ':64,'पैंसठ':65,'छियासठ':66,'सड़सठ':67,'अड़सठ':68,'उनहत्तर':69,
  'सत्तर':70,'इकहत्तर':71,'बहत्तर':72,'तिहत्तर':73,'चौहत्तर':74,'पचहत्तर':75,'छिहत्तर':76,'सतहत्तर':77,'अठहत्तर':78,'उनासी':79,
  'अस्सी':80,'इक्यासी':81,'बयासी':82,'तिरासी':83,'चौरासी':84,'पचासी':85,'छियासी':86,'सत्तासी':87,'अट्ठासी':88,'नवासी':89,
  'नब्बे':90,'इक्यानवे':91,'बानवे':92,'तिरानवे':93,'चौरानवे':94,'पंचानवे':95,'छियानवे':96,'सत्तानवे':97,'अट्ठानवे':98,'निन्यानवे':99
};
const HI_MULT = { 'सौ': 100, 'हज़ार': 1000, 'हजार': 1000, 'लाख': 100000, 'करोड़': 10000000, 'करोड': 10000000 };

function numbersToDigits(text) {
  const words = text.split(/\s+/).filter(w => w.length);
  const out = [];
  let result = 0, current = 0, active = false;
  function flush() {
    if (active) { out.push(String(result + current)); result = 0; current = 0; active = false; }
  }
  for (const w of words) {
    const stripped = w.replace(/[।,.!?]/g, '');
    const trail = stripped.length < w.length ? w.slice(stripped.length) : '';
    if (Object.prototype.hasOwnProperty.call(HI_NUMS, stripped)) {
      current += HI_NUMS[stripped];
      active = true;
      if (trail) { flush(); out[out.length - 1] += trail; }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(HI_MULT, stripped)) {
      current = (active ? current : 1) * HI_MULT[stripped];
      result += current;
      current = 0;
      active = true;
      if (trail) { flush(); out[out.length - 1] += trail; }
      continue;
    }
    flush();
    out.push(w);
  }
  flush();
  return out.join(' ');
}

function computeRMS(dataArray) {
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / dataArray.length);
}

function vadTick() {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  const rms = computeRMS(data);
  const now = Date.now();
  if (rms > VAD_RMS_THRESHOLD) {
    if (!vadSpeaking) { vadSpeaking = true; vadSpeechStart = now; }
    vadSilenceStart = null;
  } else if (vadSpeaking) {
    if (!vadSilenceStart) vadSilenceStart = now;
    else if (now - vadSilenceStart > VAD_SILENCE_MS && now - vadSpeechStart > VAD_MIN_SPEECH_MS) {
      vadSpeaking = false;
      vadSilenceStart = null;
      vadSpeechStart = null;
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    }
  }
}

function startPhraseRecorder() {
  chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  mediaRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
  mediaRecorder.ondataavailable = e => chunks.push(e.data);
  mediaRecorder.onstop = () => {
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (blob.size > MIN_CLIP_BYTES) {
      pendingCount++;
      runPipeline(blob).finally(() => {
        pendingCount--;
        if (recording) statusEl.textContent = pendingCount > 0 ? `Listening… (${pendingCount} processing)` : 'Listening…';
      });
    }
    if (recording) startPhraseRecorder();
  };
  mediaRecorder.start();
}

recBtn.addEventListener('click', async () => {
  if (!recording) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      recording = true;
      recBtn.textContent = '⏹️';
      recBtn.classList.add('recording');
      statusEl.textContent = 'Listening…';
      vadTimer = setInterval(vadTick, 100);
      startPhraseRecorder();
    } catch (err) {
      statusEl.textContent = 'Mic error: ' + err.message;
    }
  } else {
    recording = false;
    clearInterval(vadTimer);
    recBtn.textContent = '🎙️';
    recBtn.classList.remove('recording');
    statusEl.textContent = pendingCount > 0 ? `Stopped — finishing ${pendingCount} phrase(s)…` : 'Stopped.';
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    micStream.getTracks().forEach(t => t.stop());
    audioCtx.close();
  }
});

async function saveAudioSample(payload) {
  fetch('http://' + location.hostname + ':8081/audio-sample', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

let currentRecId = null;

async function runPipeline(blob) {
  const recId = 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  try {
    statusEl.textContent = 'Transcribing…';
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('language', 'hi');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('translate', 'false');
    form.append('prompt', 'शून्य एक दो तीन चार पांच छह सात आठ नौ दस बीस तीस चालीस पचास साठ सत्तर अस्सी नब्बे सौ हज़ार लाख रुपये किलो');
    const res = await fetch('/inference', { method: 'POST', body: form });
    if (!res.ok) throw new Error('Server error ' + res.status);
    const data = await res.json();
    let text = (data.text || '').trim();
    if (!text) { statusEl.textContent = 'No speech detected.'; return; }

    const audioBytes = new Uint8Array(await blob.arrayBuffer());
    saveAudioSample({ id: recId, audioBase64: bytesToBase64(audioBytes), rawTranscript: text });

    statusEl.textContent = 'Normalizing numbers…';
    try {
      const nres = await fetch('http://' + location.hostname + ':8081/normalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!nres.ok) throw new Error('relay ' + nres.status);
      const ndata = await nres.json();
      if (ndata.text) text = ndata.text;
    } catch (err) {
      text = numbersToDigits(text);
    }
    // Set alongside the displayed transcript, not at call start — with overlapping phrases
    // in flight, this keeps currentRecId pointing at whatever text is actually on screen.
    transcriptEl.textContent = text;
    lastTranscriptText = text;
    rawTranscriptText = text;
    currentRecId = recId;

    await extractBillFromText(text, modelSel.value);
    statusEl.textContent = 'Done.';
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
}

function postFeedback(entry) {
  fetch('http://' + location.hostname + ':8081/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry)
  }).catch(() => {});
}

function logBillingCorrection(i) {
  const src = billItems[i]?._src;
  if (!src) return; // manually-added rows have nothing to compare against
  const corrected = billItems
    .filter(it => it._src === src)
    .map(it => ({ product: it.product, qty: it.qty, price: it.price }));
  postFeedback({ type: 'billing', text: src, corrected });
}

async function extractBillFromText(text, model) {
  statusEl.textContent = 'Building bill…';
  const bres = await fetch('http://' + location.hostname + ':8081/billing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model })
  });
  if (bres.status === 429) throw new Error('Gemini rate limit hit — wait a minute and try again.');
  if (!bres.ok) throw new Error('relay ' + bres.status);
  const bdata = await bres.json();
  const items = (bdata.items || []).map(it => ({ ...it, _src: text, _model: model }));
  billItems = billItems.concat(items);
  renderBill();
}

let lastTranscriptText = '', rawTranscriptText = '';
transcriptEl.addEventListener('blur', async () => {
  const edited = transcriptEl.textContent.trim();
  if (!edited || edited === lastTranscriptText) return;
  const previous = lastTranscriptText;
  lastTranscriptText = edited;
  postFeedback({ type: 'transcript', raw: rawTranscriptText || previous, corrected: edited });
  if (currentRecId) saveAudioSample({ id: currentRecId, correctedTranscript: edited });
  try {
    await extractBillFromText(edited, modelSel.value);
    statusEl.textContent = 'Bill updated from edited text.';
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
});

modelSel?.addEventListener('change', async () => {
  if (!lastTranscriptText) return;
  billItems = billItems.filter(it => it._src !== lastTranscriptText);
  renderBill();
  try {
    statusEl.textContent = `Re-running with ${modelSel.options[modelSel.selectedIndex].text}…`;
    await extractBillFromText(lastTranscriptText, modelSel.value);
    statusEl.textContent = 'Done.';
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
});

clearBtn.addEventListener('click', () => {
  billItems = [];
  transcriptEl.textContent = '';
  lastTranscriptText = '';
  rawTranscriptText = '';
  currentRecId = null;
  statusEl.textContent = 'Bill cleared.';
  renderBill();
});

function buildReceiptBytes(items) {
  const bytes = [];
  const push = str => { for (const ch of str) bytes.push(ch.charCodeAt(0) & 0xff); };
  const ESC = 0x1B, GS = 0x1D;
  bytes.push(ESC, 0x40); // init
  bytes.push(ESC, 0x61, 0x01); // center align
  push('VOICE BILLING\n');
  bytes.push(ESC, 0x61, 0x00); // left align
  push(new Date().toLocaleString() + '\n');
  push('--------------------------------\n');
  let total = 0;
  for (const it of items) {
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    const lineTotal = qty * price;
    total += lineTotal;
    const name = String(it.product || '').slice(0, 18);
    const left = `${name} x${qty}`;
    const right = lineTotal.toFixed(2);
    const pad = Math.max(1, 32 - left.length - right.length);
    push(left + ' '.repeat(pad) + right + '\n');
  }
  push('--------------------------------\n');
  bytes.push(ESC, 0x45, 0x01); // bold on
  const totalLine = 'TOTAL';
  const totalRight = total.toFixed(2);
  push(totalLine + ' '.repeat(Math.max(1, 32 - totalLine.length - totalRight.length)) + totalRight + '\n');
  bytes.push(ESC, 0x45, 0x00); // bold off
  push('\n\n\n');
  bytes.push(GS, 0x56, 0x00); // full cut
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Common write-service UUIDs used by generic BLE ESC/POS thermal printer modules.
// No universal standard across vendors, so we probe a shortlist, then fall back to
// scanning every discovered service for any writable characteristic.
const PRINTER_SERVICE_GUESSES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ffe0-0000-1000-8000-00805f9b34fb'
];

let printerDevice = null, printerChar = null;

async function findWritableChar(server) {
  const services = await server.getPrimaryServices();
  const candidates = [];
  for (const svc of services) {
    const chars = await svc.getCharacteristics();
    for (const ch of chars) {
      if (ch.properties.write || ch.properties.writeWithoutResponse) candidates.push(ch);
    }
  }
  if (!candidates.length) return null;
  for (const guess of PRINTER_SERVICE_GUESSES) {
    const hit = candidates.find(c => c.service.uuid === guess);
    if (hit) return hit;
  }
  return candidates[0];
}

async function connectPrinter() {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth unavailable — open this page as http://localhost:8080 on this phone (Bluetooth needs a secure context).');
  }
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: PRINTER_SERVICE_GUESSES
  });
  const server = await device.gatt.connect();
  const ch = await findWritableChar(server);
  if (!ch) throw new Error(`No writable Bluetooth service found on "${device.name || 'device'}" — likely a classic-only printer, not BLE.`);
  device.addEventListener('gattserverdisconnected', () => { printerChar = null; });
  printerDevice = device;
  printerChar = ch;
  localStorage.setItem('printerDeviceName', device.name || '');
  return device;
}

async function writeChunked(ch, bytes) {
  const CHUNK = 20;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = new Uint8Array(bytes.slice(i, i + CHUNK));
    if (ch.properties.writeWithoutResponse) await ch.writeValueWithoutResponse(chunk);
    else await ch.writeValue(chunk);
    await new Promise(r => setTimeout(r, 15));
  }
}

printBtn.addEventListener('click', async () => {
  if (longPressFired) { longPressFired = false; return; }
  if (!billItems.length) return;
  const bytes = buildReceiptBytes(billItems);
  printBtn.disabled = true;
  try {
    if (!printerChar) {
      statusEl.textContent = 'Choose your printer…';
      await connectPrinter();
    }
    statusEl.textContent = 'Printing…';
    await writeChunked(printerChar, bytes);
    statusEl.textContent = `Printed to ${printerDevice?.name || 'printer'}.`;
  } catch (err) {
    console.warn('BLE print failed:', err);
    const useRawbt = confirm(
      'Direct Bluetooth print failed (' + err.message + ').\n\n' +
      'Try the RawBT app instead? (requires RawBT installed + printer set as default there)'
    );
    if (useRawbt) {
      window.location.href = 'rawbt:base64,' + bytesToBase64(bytes);
    } else {
      statusEl.textContent = 'Print cancelled: ' + err.message;
    }
  } finally {
    printBtn.disabled = !billItems.length;
  }
});

let pressTimer = null, longPressFired = false;
printBtn.addEventListener('pointerdown', () => {
  pressTimer = setTimeout(async () => {
    pressTimer = null;
    longPressFired = true;
    if (printerDevice?.gatt?.connected) printerDevice.gatt.disconnect();
    printerChar = null;
    printerDevice = null;
    statusEl.textContent = 'Pick a different printer…';
    try { await connectPrinter(); statusEl.textContent = `Connected to ${printerDevice?.name || 'printer'}.`; }
    catch (err) { statusEl.textContent = 'Printer switch cancelled: ' + err.message; }
  }, 600);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(evt =>
  printBtn.addEventListener(evt, () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } })
);

function wireAddRow() {
  document.getElementById('addRow').addEventListener('click', () => {
    billItems.push({ product: '', qty: 1, price: 0 });
    renderBill();
    const inputs = billArea.querySelectorAll('.f-product');
    inputs[inputs.length - 1]?.focus();
  });
}

function renderBill() {
  clearBtn.disabled = !billItems.length;
  printBtn.disabled = !billItems.length;
  speakBtn.disabled = !billItems.length;
  if (!billItems.length) {
    billArea.innerHTML = '<div id="placeholder">Bill will appear here after recording.</div><button id="addRow">+ Add row</button>';
    wireAddRow();
    return;
  }
  let total = 0;
  const rows = billItems.map((it, i) => {
    const lineTotal = (Number(it.price) || 0) * (Number(it.qty) || 0);
    total += lineTotal;
    return `<tr data-i="${i}">
      <td><input type="text" class="f-product" value="${escapeAttr(it.product)}"></td>
      <td class="qty-cell">
        <button class="qty-btn qty-minus" type="button">−</button>
        <input type="number" class="f-qty" value="${it.qty}" min="0" step="1">
        <button class="qty-btn qty-plus" type="button">+</button>
      </td>
      <td><input type="number" class="f-price" value="${it.price}" min="0" step="0.01"></td>
      <td>₹${lineTotal.toFixed(2).replace(/\.00$/, '')}</td>
      <td><button class="rm-row" title="Remove row">✕</button></td>
    </tr>`;
  }).join('');
  billArea.innerHTML = `<table>
    <thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">Grand Total</td><td colspan="2">₹${total.toFixed(2).replace(/\.00$/, '')}</td></tr></tfoot>
  </table>
  <button id="addRow">+ Add row</button>`;
  wireAddRow();

  billArea.querySelectorAll('tbody tr').forEach(tr => {
    const i = Number(tr.dataset.i);
    const productEl = tr.querySelector('.f-product');
    const qtyEl = tr.querySelector('.f-qty');
    const priceEl = tr.querySelector('.f-price');
    productEl.addEventListener('input', e => { billItems[i].product = e.target.value; });
    qtyEl.addEventListener('input', e => { billItems[i].qty = Number(e.target.value) || 0; updateTotals(); });
    priceEl.addEventListener('input', e => { billItems[i].price = Number(e.target.value) || 0; updateTotals(); });
    [productEl, qtyEl, priceEl].forEach(el => el.addEventListener('blur', () => logBillingCorrection(i)));
    tr.querySelector('.qty-minus').addEventListener('click', () => {
      billItems[i].qty = Math.max(0, (Number(billItems[i].qty) || 0) - 1);
      qtyEl.value = billItems[i].qty;
      updateTotals();
      logBillingCorrection(i);
    });
    tr.querySelector('.qty-plus').addEventListener('click', () => {
      billItems[i].qty = (Number(billItems[i].qty) || 0) + 1;
      qtyEl.value = billItems[i].qty;
      updateTotals();
      logBillingCorrection(i);
    });
    tr.querySelector('.rm-row').addEventListener('click', () => { billItems.splice(i, 1); renderBill(); });
  });
}

function updateTotals() {
  let total = 0;
  billArea.querySelectorAll('tbody tr').forEach(tr => {
    const i = Number(tr.dataset.i);
    const lineTotal = (Number(billItems[i].price) || 0) * (Number(billItems[i].qty) || 0);
    total += lineTotal;
    tr.children[3].textContent = '₹' + lineTotal.toFixed(2).replace(/\.00$/, '');
  });
  const footCell = billArea.querySelector('tfoot td:last-child');
  if (footCell) footCell.textContent = '₹' + total.toFixed(2).replace(/\.00$/, '');
}

function escapeAttr(s) {
  return String(s).replace(/[&"'<>]/g, c => ({ '&':'&amp;','"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;' }[c]));
}

// --- Read bill aloud (on-device speech synthesis) ---
function billSpeechText() {
  if (!billItems.length) return '';
  const lines = billItems.map(it => {
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    return `${qty} ${it.product}, ${qty * price}.`;
  });
  const grand = billItems.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
  lines.push(`hua ${grand}.`);
  return lines.join(' ');
}

speakBtn?.addEventListener('click', () => {
  if (!('speechSynthesis' in window)) {
    statusEl.textContent = 'Speech synthesis not supported on this device.';
    return;
  }
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    speakBtn.classList.remove('speaking');
    return;
  }
  const text = billSpeechText();
  if (!text) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'hi-IN';
  utter.onend = () => speakBtn.classList.remove('speaking');
  utter.onerror = () => speakBtn.classList.remove('speaking');
  speakBtn.classList.add('speaking');
  speechSynthesis.speak(utter);
});

// --- Share link, capped at 10 mints (client-side counter) ---
const shareBtn = document.getElementById('shareBtn');
const SHARE_LIMIT = 10;
const SHARE_KEY = 'shareMintCount';

function getShareCount() {
  return Math.min(SHARE_LIMIT, Number(localStorage.getItem(SHARE_KEY)) || 0);
}

function renderShareBtn() {
  const count = getShareCount();
  shareBtn.textContent = count >= SHARE_LIMIT ? '🔗 Limit reached (10/10)' : `🔗 Share (${count}/${SHARE_LIMIT})`;
  shareBtn.disabled = count >= SHARE_LIMIT;
}
renderShareBtn();

shareBtn?.addEventListener('click', async () => {
  const count = getShareCount();
  if (count >= SHARE_LIMIT) return;
  const url = location.href;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Voice Billing', url });
    } else {
      await navigator.clipboard.writeText(url);
      statusEl.textContent = 'Link copied.';
    }
    localStorage.setItem(SHARE_KEY, String(count + 1));
    renderShareBtn();
  } catch (err) {
    if (err.name !== 'AbortError') statusEl.textContent = 'Share failed: ' + err.message;
  }
});

// --- PWA install + update handling ---
const installBtn = document.getElementById('installBtn');
let deferredInstallPrompt = null;

if (installBtn && (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone)) {
  installBtn.style.display = 'none';
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.style.display = 'inline-flex';
});

installBtn?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  installBtn.disabled = true;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.style.display = 'none';
  statusEl.textContent = outcome === 'accepted' ? 'App installed.' : 'Install dismissed.';
});

window.addEventListener('appinstalled', () => {
  installBtn.style.display = 'none';
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          statusEl.textContent = 'Update ready — reload to apply.';
        }
      });
    });
  }).catch(() => {});
}

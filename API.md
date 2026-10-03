# Voice Billing API

Speech (Hindi/Hinglish) → normalized transcript → structured bill line items, in one call.

**Status: not publicly exposed yet.** Runs on `:8082`, reachable on LAN/localhost only. Needs a tunnel (`cloudflared`/`ngrok`) or real hosting before it can serve external traffic — this phone is a single device with no uptime guarantees.

## Auth

Every request needs an API key, via either header:

```
X-API-Key: vb_...
Authorization: Bearer vb_...
```

Keys are managed locally (no public signup yet):

```
node manage-keys.js create <name> [dailyLimit=100]   # prints the key
node manage-keys.js list
node manage-keys.js revoke <key>
```

Each key has a daily request quota (default 100/day), enforced server-side. Exceeding it returns `429 {"error":"limit_exceeded"}`.

## Endpoint

`POST /v1/bill`

- Body: raw audio bytes (webm/wav/mp3/etc — anything ffmpeg can decode). No multipart wrapper needed, just the file bytes.
- Optional header `X-Language: hi` (default `hi`; use `auto` to detect).
- Response:
  ```json
  { "transcript": "40 की मैगी, 20 की कांदा", "items": [
    { "product": "maggi", "qty": 1, "price": 40 },
    { "product": "kanda", "qty": 1, "price": 20 }
  ]}
  ```

### Example

```bash
curl -X POST http://<host>:8082/v1/bill \
  -H "X-API-Key: vb_..." \
  -H "X-Language: hi" \
  --data-binary @recording.webm
```

## Why it's cheaper than an OpenAI-based equivalent

Same task built on OpenAI: Whisper API for transcription + GPT-4o-mini for structured extraction. Ours: whisper.cpp running locally (zero marginal cost — no per-minute transcription fee at all) + Gemini 2.5 Flash-Lite for the two small text calls (normalize, extract).

Pricing sourced directly from OpenAI's and Google's current pricing pages (Aug 2026):

| | OpenAI | Ours |
|---|---|---|
| Transcription | Whisper API: $0.006/min | whisper.cpp, self-hosted: $0 marginal |
| Text extraction | GPT-4o-mini: $0.15/1M in, $0.60/1M out | Gemini 2.5 Flash-Lite: $0.10/1M in, $0.40/1M out |

**Worked example** — a typical ~10-second billing utterance (~20 words):

| | OpenAI equivalent | Ours |
|---|---|---|
| Transcription (10s audio) | $0.001 | $0 |
| Extraction (~700 tok in, ~80 tok out) | $0.000153 | $0.000156 (two calls: normalize + billing) |
| **Total per request** | **≈ $0.00115** | **≈ $0.00016** |

**≈ 7× cheaper per request**, almost entirely because the transcription step is free when self-hosted instead of metered per-minute. At volume (say 10,000 requests/month) that's roughly $11.50 vs $1.60 — a real, not marginal, difference.

Caveats to keep this honest: doesn't include hosting/compute cost for running whisper.cpp itself (currently a phone, effectively free but not infinitely scalable), assumes similar token counts for a similar extraction task, and Gemini's free tier can push the real cost to $0 at low volume (OpenAI has no free tier for these endpoints).

## What's NOT built yet

- No public hosting/tunnel — LAN only.
- No self-serve signup or payment — keys are created by hand via `manage-keys.js`.
- No per-key spend tracking, only request-count limits.
- No landing page — this file is the whole "marketing site" for now.

# Deploying to AWS Mumbai (ap-south-1)

This moves the **public API** (`api-server.js` + a GPU-accelerated `whisper-server`) off this phone onto a real GPU instance close to India. Your own local billing webapp (`relay.js` + the phone's `whisper-server` + `public/`) stays exactly as-is on this device — nothing here touches that.

**I can't do the AWS steps myself** — no AWS credentials or account access from here, and this is real infrastructure/spend, so it needs you at the console. Everything below is written so you (or I, walking through it with you interactively) can execute it directly.

## 1. Launch the instance

- **Region**: ap-south-1 (Mumbai) — closest AWS region to India.
- **Instance type**: `g4dn.xlarge` (1× T4 GPU, 4 vCPU, 16GB RAM) — right-sized for whisper-server; `g5.xlarge` (A10G) if you want more headroom later. Ballpark on-demand cost: roughly **$0.7–0.8/hr** for g4dn.xlarge in Mumbai, **~$1.3–1.5/hr** for g5.xlarge — these are approximate, I couldn't pull AWS's live pricing table from here, so check the [AWS Pricing Calculator](https://calculator.aws) before committing.
- **AMI**: an AWS Deep Learning AMI (has NVIDIA drivers + Docker + `nvidia-container-toolkit` preinstalled — saves you the manual CUDA driver setup, which is the most common way this kind of deploy goes wrong).
- **Storage**: 30GB+ EBS (whisper.cpp build + CUDA base image + model add up to several GB).
- **Security group**: open `22` (SSH, restrict to your IP) and `8082` (the public API). Do **not** open `8080` — that's whisper-server, internal-only, only `api-server` should talk to it.

## 2. Get the code onto the instance

```bash
scp -r ~/projects/voice-hindi ubuntu@<instance-ip>:~/voice-hindi
# or: git clone your repo if you push this project to one
```

## 3. Set the Gemini key

```bash
ssh ubuntu@<instance-ip>
cd ~/voice-hindi
echo "GEMINI_API_KEY=AIzaSy..." > .env
```

`docker-compose.yml` reads `GEMINI_API_KEY` from this `.env` file — never bake it into the image.

## 4. Build and run

```bash
docker compose up -d --build
```

First build compiles whisper.cpp with CUDA (`-DGGML_CUDA=ON`) — takes a few minutes. Verify GPU is actually being used:

```bash
docker compose logs whisper | grep -i "device 0"
# should show your GPU name, not "CPU (type: 0)" like it did on the phone
```

## 5. Create an API key and test

```bash
docker compose exec api node manage-keys.js create first-customer 1000
curl -X POST http://localhost:8082/v1/bill \
  -H "X-API-Key: vb_..." \
  --data-binary @some_recording.webm
```

Compare the response time to what you saw on the phone (5+ minutes) — should be well under a second now.

## 6. Before calling this "production"

- **HTTPS**: right now it's raw HTTP on `:8082`. Put an ALB or Nginx with an ACM cert in front before giving this URL to real customers.
- **Domain**: point a subdomain (e.g. `api.yourdomain.com`) at the instance/ALB via Route53.
- **Persistence**: `./data` on the host holds `api_keys.json`, `training_data.jsonl`, `training_audio/` — back it up; it's the only copy.
- **Model choice**: currently `ggml-small.bin` (same as your phone). On a GPU this runs fast enough that you could reasonably move up to `medium` for better accuracy — edit `Dockerfile.whisper`'s `download-ggml-model.sh` line and the `CMD`'s `-m` path.
- **Reproducible builds**: `Dockerfile.whisper` clones whisper.cpp's `master` branch — pin a specific commit/tag before you depend on this for real traffic, so a whisper.cpp update upstream can't silently change your build.

# t-scan — deployment

Self-contained copy of the police saga application. Dependencies are included,
so there is nothing to install: both Python virtualenvs and both `node_modules`
trees came with it and were verified from this path.

## Start

```powershell
ollama serve            # in its own window, first
.\start-all.ps1         # opens one window per service
.\start-all.ps1 -Check  # until everything says "up"
.\verify.ps1            # proves the chain end to end
```

The two Python services load models before they answer: **sentiment ~2 minutes**
(IndicTrans2 + NLLB + RoBERTa), **rag ~30 seconds** (embedder + LLM prewarm).
`-Check` will show them down until that finishes. This is normal.

## Services

| Service | Port | Why that port |
|---|---|---|
Ollama | 11434 | default |
Sentiment | 8003 | `SENTIMENT_SERVICE_URL` in `backend/.env` |
RAG / AI assistant | 8100 | `RAG_API_URL` in `backend/.env`. **Not 8099** — `run.ps1` and the RAG README say 8099, the backend expects 8100 |
Node backend | 8000 | `PORT` in `backend/.env` |
Frontend | 3000 | `serve -s build` |

Both Python services run `--workers 1`, and neither is arbitrary:

- **RAG**: progressive analysis keeps job state in process memory, so a second
  worker serves polls for jobs it never saw. The service refuses to boot with
  more than one.
- **Sentiment**: the tenant-fair LLM queue needs one process-wide gate; two
  uvicorn workers are two processes with two gates and no fairness.

## Log in

| Account | Role | Scope |
|---|---|---|
`admin@tscan.com` | admin | all districts — use this for the demo |
`hyd@tscan.com` | level-1 | Hyderabad only |
`mulugu@tscan.com` | level-1 | Mulugu only |

The district accounts are worth showing: ask the same question as each and the
answers differ, which demonstrates the isolation rather than asserting it.

## The one GPU constraint

This machine has **8 GB** of GPU memory. The assistant and the sentiment
service's intelligence stage both use **`qwen2.5-7b-8k`** (5.5 GB) on purpose.

Sentiment was configured for `qwen2.5:14b-instruct-q4_K_M`, which is 9 GB.
Ollama refused it outright — `CUDA error: out of memory` — and every post came
back `category: Unknown, risk_score: 0, source: error` after a 30-second
timeout, while deterministic sentiment stayed correct. That is why the failure
was invisible without reading the intelligence object.

**Do not point the two services at different models on this hardware.** They
would evict each other on every alternating request, 20–30 seconds each way.

## Content fetching

`CONTENT_PROVIDER` in `backend/.env`:

- `blugate` (current) — via the gateway, per-tenant credentials, quota metered
  per tenant. Verified working.
- `rapidapi` — the **same** upstream providers called directly on one shared
  key. Keys are already present. No per-tenant metering on this path.

Switching is one line plus a backend restart. The providers are identical
either way, so payload shapes and parsers are unaffected.

## Data currency

The newest record is from **23 September**. `AI_SITUATION_WINDOW_DAYS=45` in
`RAG_pipline_saga/.env` compensates, so "what is happening" questions answer
with real volume instead of reporting zero.

To collect new content, set `INGEST_SCHEDULER_ENABLED=true` in
`RAG_pipline_saga/.env` and restart the RAG service. This starts recurring
work on the shared GPU, so turn it on deliberately — not during a demo.

Once ingestion is current, put `AI_SITUATION_WINDOW_DAYS` back to `7`.

## If something is wrong

| Symptom | Look at |
|---|---|
Every answer says "0 matching records" | `AI_SITUATION_WINDOW_DAYS`; the data is a month old |
Assistant calls fail with nothing in the UI | RAG on 8100? `RAG_API_URL` agrees? |
Risk scores all 0, categories all "Unknown" | `VLLM_MODEL` does not fit in GPU memory |
Login fails | tenant `status` must be `trial` or `active`; `JWT_SECRET` must be set |
Assistant slow on the first question only | model prewarm; it is one-off per restart |
Sentiment returns 413 | a post over `SENTIMENT_MAX_TEXT_CHARS`; the backend truncates first |

Health and metrics:

```powershell
curl http://127.0.0.1:8100/api/rag/v2/metrics   # retrieval strategy, pools, degraded collections
curl http://127.0.0.1:8003/health               # sentiment stages and device
```

`degraded_collections` in the RAG metrics names any collection falling back to
local cosine instead of the Atlas index — useful if semantic search feels poor.

## What is NOT in this copy

`.git`, caches (`__pycache__`, `.vector_cache`), logs and `outputs/`. The
vector cache rebuilds itself; everything else is disposable.

## Secrets

Every `.env` here contains live credentials — database, JWT signing key,
provider API keys. There is a `.gitignore` at the root to keep them out of
version control. Rotate the provider keys after the deployment.

# workflow

## Quick start (self-host)

Clone, run — Mongo, NATS and the Docker step-runner are all wired into compose
(secrets live in Mongo, no extra storage service). It boots with **no config**
(email/password auth, a dev secret):

```bash
git clone https://github.com/flowbaker/mergN.git && cd mergN
docker compose up -d --build       # starts in the background (no log wall)
# → open http://localhost:8787
```

Follow just the app's logs (without the Mongo/infra noise) when you want them:

```bash
docker compose logs -f app
```

To use the AI you need a model. **Easiest:** open the app, sign up, and use the
**gear icon → AI model** to pick a provider + key — stored in the DB, **no `.env`
needed**. Or set it via env (add **one** to a `.env`, `cp .env.example .env`):

```bash
GOOGLE_GENERATIVE_AI_API_KEY=...                       # default (Gemini)
# — or —
LLM_PROVIDER=openai
LLM_API_KEY=sk-...
# — or fully local, no key (run Ollama on the host) —
LLM_PROVIDER=local
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_MODEL=llama3.1
```

Workflow steps run in throwaway Docker containers on your host — no extra setup.
For real use (not just local), set your own `BETTER_AUTH_SECRET` in `.env`.

## Setup

```bash
npm install
```

## Usage

```bash
npm run server          # backend (loads .env) — http://localhost:8787
cd web && npm run dev   # frontend (Vite) — http://localhost:5173
```

## Deployment (Docker)

A single image serves the backend + built web on one port (8787).

```bash
docker compose up --build   # app + mongo + nats → http://localhost:8787
```

The stack is self-contained: workflow state AND secrets live in MongoDB
(`DocStore` + `doc` vault), and the app is stateless — if the server changes,
data stays in the volume / managed Mongo.

Storage is selected via env (see `.env.example`):

| env | default (compose) | other mode |
|-----|---------|---------------|
| `STORE_DRIVER` | `mongo` | `file` |
| `VAULT_DRIVER` | `doc` (secrets in Mongo) | `s3` (+ `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`, AWS creds — point at R2/S3 or add a MinIO service) |

### AI model (LLM)

The agent + chat model provider is selected via env. If `LLM_PROVIDER` is empty,
**google** is used (our managed deploy keeps working this way). Self-hosters can
use their own model:

| Mode | env |
|-----|-----|
| Local model | `LLM_PROVIDER=local` · `LLM_BASE_URL=http://host:11434/v1` · `LLM_MODEL=llama3.1` (Ollama/LM Studio/vLLM) |
| OpenAI | `LLM_PROVIDER=openai` · `LLM_API_KEY=sk-…` · `LLM_MODEL=gpt-4o` |
| Anthropic | `LLM_PROVIDER=anthropic` · `LLM_API_KEY=…` · `LLM_MODEL=claude-3-5-sonnet-latest` |
| Google (own key) | `LLM_PROVIDER=google` · `GOOGLE_GENERATIVE_AI_API_KEY=…` |

> The agents produce structured output (JSON schema) — for a local model a
> capable one (Llama 3.1 70B / Qwen 32B+) is recommended; small models may
> break the schema.

### Code execution (workflow steps)

With `CODE_RUNTIME=docker`, each step runs in a **short-lived sibling container on
the host** (`--cap-drop ALL`, `no-new-privileges`, memory/cpu/pids limits, egress
lock, credentials passed via stdin). No separate VM / Firecracker needed.

- **App on the host** (`npm run server`): just have Docker installed and set
  `CODE_RUNTIME=docker`.
- **App inside a compose container** (docker-out-of-docker): compose already
  mounts `/var/run/docker.sock` + the `fb-work` volume and sets
  `DOCKER_WORK_DIR=/data/fb-work`, `DOCKER_VOLUME=fb-work`. (The socket mount
  grants the app host-level docker access — fine for single-tenant self-host.)

**Moving to managed (server-may-change scenario):** remove the `mongo` service
from `docker-compose.yml` and point `MONGO_URL` to Atlas. For secrets on object
storage instead of Mongo, set `VAULT_DRIVER=s3` + `S3_*`/AWS creds (R2/S3, or add
back a MinIO service). The app image stays the same.

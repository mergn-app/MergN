# MergN 

> The observability of n8n. The flexibility of AI agents.

<img width="2879" height="1799" alt="image" src="https://github.com/user-attachments/assets/419fc75e-a7c2-4f0f-ad86-7cd727223470" />


MergN is an AI-native automation platform built by Quoll crew. checkout: https://quollhq.com/

It bridges the gap between traditional workflow automation tools like n8n and AI-powered coding environments such as Claude Code. Instead of manually wiring integrations and writing automation logic, you describe what you want in plain language and MergN generates the required workflow logic at runtime.

### How Does It Work?

MergN lets you create workflows using natural language.

Like traditional automation platforms, workflows are represented as nodes and connections. However, unlike conventional tools, the underlying integration and execution code is generated dynamically by an LLM provider when the workflow builds.

This allows workflows to adapt to a much broader range of use cases without requiring users to manually configure every step.

### Why Not Just Use AI Directly?

You can already build automations with AI-assisted coding tools. The challenge is visibility.

Most AI-generated automation solutions produce code, but they do not provide a clear way to monitor, inspect, log, and understand what is happening inside a workflow. Especially for non-technical users.

MergN combines the flexibility of AI-generated logic with the observability of traditional workflow platforms. Every workflow remains structured, traceable, and monitorable.

### Who Is It For?

Non-technical users can build and operate automations without writing code while still maintaining visibility into how their workflows behave.

Developers get the power of AI-generated workflow logic combined with a visual interface for monitoring, debugging, and managing complex automation systems.


## Setup and Start with Docker (Recommended)

Clone, run — Mongo, NATS and the Docker step-runner are all wired into compose

```bash
git clone https://github.com/flowbaker/MergN.git && cd MergN
docker compose up -d --build       # starts in the background (no log wall)
# → open http://localhost:8787
```

Follow the app's logs:

```bash
docker compose logs -f app
```
## Setup Native

#### Setup
```bash
git clone https://github.com/flowbaker/MergN.git && cd mergN
npm install
```
#### Start
```bash
npm run server          # backend (loads .env) — http://localhost:8787
cd web && npm run dev   # frontend (Vite) — http://localhost:5173
```

## How To Update

On startup MergN checks for a newer version and prints it in the app log
(`docker compose logs -f app`, or the `npm run server` output):

**One command for both Docker and Native Builds** — run it from the repo root:

```bash
./update.sh          # or: npm run update
```

It pulls the latest source, then auto-detects your install and applies it:

- **Docker** → pulls the latest prebuilt image and restarts (Docker shows the
  download progress; no local build). Use `./update.sh --build` to build the
  image from source instead.
- **Native** (git clone + npm) → runs `npm install` (backend + web) and tells
  you to restart.

Prefer doing it by hand? Docker: `docker compose pull && docker compose up -d`.
Native: `git pull && npm install`. The boot check is non-blocking and silent if
offline — disable it with `UPDATE_CHECK=0`.

## Troubleshooting & Advanced Setup

To use the AI you need a model. *Easiest:* open the app, and use the
*gear icon → AI model* to pick a provider + key — stored in the DB, **no .env
needed*. Or set it via env (add **one* to a .env, cp .env.example .env):

bash
GOOGLE_GENERATIVE_AI_API_KEY=...                       # default (Gemini)
#### — or —
LLM_PROVIDER=openai
LLM_API_KEY=sk-...
#### — or fully local, no key (run Ollama on the host) —
LLM_PROVIDER=local
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_MODEL=llama3.1

Workflow steps run in throwaway Docker containers on your host — no extra setup.
For real use (not just local), set your own BETTER_AUTH_SECRET in .env.

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

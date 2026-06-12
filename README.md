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


## Setup with Docker (recommended)

**Requires:** Docker (Docker Desktop installed and running). Everything else —
Mongo, NATS, the step-runner — is bundled in compose. Clone and run:

```bash
git clone https://github.com/flowbaker/MergN.git && cd MergN
docker compose up -d        # starts in the background -> http://localhost:8787
```

Open **http://localhost:8787**. Logs: `docker compose logs -f app` · Stop: `docker compose down`

## Setup Native (Node)

**Requires:** Node 22+ (and Docker only if you want NATS/Mongo below).

```bash
git clone https://github.com/flowbaker/MergN.git && cd MergN
npm install
cd web && npm install && cd ..
```

No `.env` needed to start — the AI model is set from the UI (gear icon). A
`.env` is only for optional services below; create one with `cp .env.example .env`
when you need it.

By default native runs on local file storage with no extra services — fine for
manual & webhook workflows. **Scheduled / poll triggers need NATS** (JetStream).
Run it (port published so the host app can reach it):

```bash
docker run -d --name mergn-nats -p 4222:4222 nats:2.14-alpine -js
```

and set in `.env`: `NATS_URL=nats://localhost:4222`

Optional — a real database instead of file storage (Mongo):

```bash
docker run -d --name mergn-mongo -p 27017:27017 mongo:7
```

`.env`: `STORE_DRIVER=mongo` and `MONGO_URL=mongodb://localhost:27017`

Start (in two terminals):

```bash
npm run server          # backend  -> http://localhost:8787
cd web && npm run dev   # frontend -> http://localhost:5173
```

## First run — pick an AI model

Open the app, sign up (local email/password), then click the **gear icon → AI
model** and choose a provider + key — Google (Gemini), OpenAI, Anthropic, or a
local Ollama model. It's stored in the app, so **no `.env` needed**.

Now describe what you want in the chat and MergN builds the workflow. (Prefer
configuring the model via `.env`? See *Troubleshooting & Advanced* below.)

## Updating

On startup MergN logs whether a newer version exists. From the repo root run:

```bash
./update.sh        # pulls the latest and applies it (Docker or Native — auto-detected)
```

By hand instead — **Docker:** `git pull && docker compose up -d` · **Native:**
`git pull && npm install && (cd web && npm install)`, then restart.

(Disable the boot check with `UPDATE_CHECK=0`.)

## Troubleshooting & Advanced Setup

Prefer setting the AI model via `.env` instead of the in-app gear? Add **one** of:

```bash
GOOGLE_GENERATIVE_AI_API_KEY=...                      # default (Gemini)
# — or —
LLM_PROVIDER=openai
LLM_API_KEY=sk-...
# — or a fully local model (run Ollama on the host) —
LLM_PROVIDER=local
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_MODEL=llama3.1
```

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

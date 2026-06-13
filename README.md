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
Open http://localhost:8787. Logs: docker compose logs -f app · Stop: docker compose down

That's it. The application is now running with Docker.

**Update (Docker)**

When you want to update to the latest version, run:
```bash
git pull && docker compose up -d
```
This pulls the latest changes and restarts the containers.

## Setup Native

**Requires:** Node 22+ and Docker (for NATS — required to start).

```bash
git clone https://github.com/flowbaker/MergN.git && cd MergN
npm install
cd web && npm install && cd ..
```
----------------------------------------------------

**NATS is required** (JetStream — runs scheduled & poll workflows). Start it and
point the app at it, otherwise the backend exits on startup:

**Install Nats Via Docker** 

```bash
docker run -d --name mergn-nats -p 4222:4222 nats:2.14-alpine -js
cp .env.example .env
# in .env:  NATS_URL=nats://localhost:4222
```

**or** 

Go to official nats documentation if you want to install another way. 

https://docs.nats.io/running-a-nats-service/introduction/installation

----------------------------------------------------

**Install Mongo Via Docker (Optional)** 

Storage defaults to local files. Optional — use Mongo instead.

```bash
docker run -d --name mergn-mongo -p 27017:27017 mongo:7
# in .env:  STORE_DRIVER=mongo   MONGO_URL=mongodb://localhost:27017
```

**or** 

Go to official mongo documentation if you want to install another way. 

https://www.mongodb.com/docs/manual/installation/

----------------------------------------------------

**Start Native (in separated two terminals):**

```bash
cd ~/MergN 
npm run server          # backend  -> http://localhost:8787
```
```bash
cd ~/MergN 
cd web && npm run dev   # frontend -> http://localhost:5173
```
That's it. The application is now running natively.

**Update Native**

When you want to update to the latest version, run:

```bash
cd ~/MergN
git pull && npm install && (cd web && npm install)
```

Then restart the application.

To disable update checks on startup, set:

```bash
UPDATE_CHECK=0
```

## Troubleshooting & Advanced Setup

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

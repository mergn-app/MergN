# Self-hosted Langfuse

Local Langfuse stack for tracing the AI layer of the workflow builder
(see `src/observability.ts`). Stack: langfuse-web + worker, Postgres, ClickHouse,
Redis, MinIO.

## Run

```bash
cd langfuse
docker compose up -d        # first boot pulls images + runs migrations (~1–2 min)
docker compose logs -f langfuse-web
```

- UI: http://localhost:3000 — log in with `LANGFUSE_INIT_USER_EMAIL` / `_PASSWORD`
  from `.env`.
- The org, project, user, and API keys are auto-created on first boot from the
  `LANGFUSE_INIT_*` values, so no manual setup is needed.

The project's public/secret keys in `.env` already match the app's `../.env`
(`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL=http://localhost:3000`).
Restart the app server after the stack is up and traces will flow.

## Stop

```bash
docker compose down         # keep data
docker compose down -v      # wipe all volumes (fresh start)
```

## Notes

- Ports bound to localhost only except web (3000) and MinIO console (9090).
- `.env` here is gitignored. `.env.example` documents every variable.
- Regenerate any leaked secret with `openssl` and update both this `.env` and the
  matching app key.

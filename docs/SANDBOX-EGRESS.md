# Sandbox egress security

Workflow steps run **untrusted JS** in a docker sandbox. Two layers protect the
host and other tenants from SSRF / secret exfiltration:

## Layer 1 — app guard (automatic, in the sandbox)
`docker-runtime.ts` overrides `fetch` inside the sandbox and wraps provider
clients to block requests that resolve to internal / loopback / link-local
(incl. cloud metadata `169.254.169.254`) / private IPs. This stops the easy
vector (the `http` provider or a `fetch()` step hitting an internal address).

It is **defense-in-depth, not the boundary**: code running in the sandbox can
bypass a JS guard via raw sockets (`node:net`) or DNS rebinding. So:

## Layer 2 — host egress firewall (the real boundary) — REQUIRED in prod
Run containers are placed on an **isolated network** with **public DNS**
(`--network fb-runs --dns 1.1.1.1`). A host firewall then DROPs, at the packet
layer, any traffic from that subnet to internal/metadata ranges. The sandboxed
code **cannot** bypass this — raw sockets and rebinding both fail because the
kernel drops the packet by destination IP.

App side is automatic (the app creates `fb-runs` and runs containers on it). You
must apply the firewall **once** on the docker host. Pick one:

### Option A — privileged compose service (recommended: automatic + persistent)
Add to the deployment's `docker-compose.yml`:

```yaml
  egress-firewall:
    image: alpine:3
    network_mode: host
    cap_add: [NET_ADMIN, NET_RAW]
    restart: "no"
    environment:
      RUN_SUBNET: "10.88.0.0/24"
    volumes:
      - ./scripts/egress-firewall.sh:/egress-firewall.sh:ro
    command: sh -c "apk add --no-cache iptables ip6tables >/dev/null && sh /egress-firewall.sh"
```

It runs once on every `docker compose up` and re-applies the rules (idempotent).

### Option B — run the script once on the host
```sh
sudo RUN_SUBNET=10.88.0.0/24 sh scripts/egress-firewall.sh
```
Re-run after a docker daemon restart (DOCKER-USER is recreated), or wire it into
a systemd unit / boot hook.

## Verify
From inside a run container (or a step that fetches), an internal address must
fail while a public one works:
```sh
docker run --rm --network fb-runs --dns 1.1.1.1 node:22-slim \
  node -e "fetch('http://169.254.169.254/').then(()=>console.log('LEAK')).catch(e=>console.log('blocked:',e.message))"
# → blocked
```

## Config
- `RUN_NETWORK` (default `fb-runs`), `RUN_SUBNET` (default `10.88.0.0/24`),
  `RUN_DNS` (default `1.1.1.1,8.8.8.8`). Keep `RUN_SUBNET` in sync between the app
  env and the firewall script.

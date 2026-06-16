#!/usr/bin/env sh
# Egress firewall for the workflow run-container network.
#
# Step code runs untrusted JS in a docker sandbox. App-level guards (the fetch
# override) can be bypassed by raw sockets / DNS rebinding, so the REAL boundary
# is here, at the packet layer: drop any traffic FROM the run subnet TO internal,
# loopback, link-local (incl. cloud metadata 169.254.169.254) or private ranges.
# Public internet egress is still allowed. The sandboxed code cannot bypass this.
#
# Idempotent: uses a dedicated FB-EGRESS chain (flush + repopulate) hooked into
# DOCKER-USER once. Run as root on the docker host (or via the privileged
# egress-firewall compose service). IPv6 is best-effort.
set -eu

SUBNET="${RUN_SUBNET:-10.88.0.0/24}"
BLOCK="169.254.0.0/16 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10"

apply() {
  IPT="$1"; CHAIN="$2"; shift 2
  $IPT -N FB-EGRESS 2>/dev/null || true
  $IPT -F FB-EGRESS
  for net in "$@"; do
    $IPT -A FB-EGRESS -s "$SUBNET" -d "$net" -j DROP
  done
  # hook into DOCKER-USER exactly once
  $IPT -C "$CHAIN" -j FB-EGRESS 2>/dev/null || $IPT -I "$CHAIN" -j FB-EGRESS
}

apply iptables DOCKER-USER $BLOCK
echo "fb-egress: $SUBNET blocked from internal/metadata ranges (IPv4)."

# IPv6 best-effort (run network is IPv4, but block loopback/ULA/link-local too)
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -N FB-EGRESS 2>/dev/null || true
  ip6tables -F FB-EGRESS
  for net in ::1/128 fc00::/7 fe80::/10; do
    ip6tables -A FB-EGRESS -d "$net" -j DROP
  done
  ip6tables -C DOCKER-USER -j FB-EGRESS 2>/dev/null || ip6tables -I DOCKER-USER -j FB-EGRESS
  echo "fb-egress: IPv6 internal ranges blocked."
fi

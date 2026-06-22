// Connection binding check for restore. A version pins a node's chosen
// connection by id (the credential itself stays live, never versioned). On
// restore that id can be stale: the connection was deleted, or replaced by one
// for a different provider. We surface "reconnect" rather than silently failing
// at run time or silently falling back to a different connection.
//
// Field-level credential-shape drift (a provider re-authored from apiKey to
// clientId/secret) is NOT checked here — the connection metadata doesn't carry
// field names (the values live encrypted in the vault).

export interface ConnBinding {
  reqName: string; // "<funcId>/<requirement>" — for the UI to locate the node
  providerId: string;
  connectionId?: string; // the version's chosen connection (may be stale/absent)
}

export interface ConnReconnect {
  reqName: string;
  providerId: string;
  reason: "missing" | "wrong-provider";
}

// `bindings` = the restored flow's provider requirements that have a chosen
// connection; `connections` = the space's current connections (id + provider).
export function checkConnectionBindings(
  bindings: ConnBinding[],
  connections: { id: string; provider: string }[],
): ConnReconnect[] {
  const byId = new Map(connections.map((c) => [c.id, c.provider]));
  const out: ConnReconnect[] = [];
  for (const b of bindings) {
    if (!b.connectionId) continue; // never connected — normal, not a dangling ref
    const provider = byId.get(b.connectionId);
    if (provider === undefined)
      out.push({ reqName: b.reqName, providerId: b.providerId, reason: "missing" });
    else if (provider !== b.providerId)
      out.push({
        reqName: b.reqName,
        providerId: b.providerId,
        reason: "wrong-provider",
      });
  }
  return out;
}

// Build the bindings list from a flow's funcs (their `requires`) + nodeConnections.
export function bindingsOf(
  funcs: unknown[],
  nodeConnections: Record<string, Record<string, string>> | undefined,
): ConnBinding[] {
  const out: ConnBinding[] = [];
  for (const f of funcs as Array<{
    id?: string;
    requires?: Array<{ name?: string; provider?: string }>;
  }>) {
    if (!f?.id) continue;
    for (const r of f.requires ?? []) {
      if (!r?.provider || !r?.name) continue;
      out.push({
        reqName: `${f.id}/${r.name}`,
        providerId: r.provider,
        connectionId: nodeConnections?.[f.id]?.[r.name],
      });
    }
  }
  return out;
}

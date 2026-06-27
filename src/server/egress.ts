import type { SandboxPolicy } from "../providers/registry";

function stripBrackets(h: string): string {
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

export function hostFromCredValue(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (v.includes("://")) {
    try {
      const h = new URL(v).hostname;
      return h ? stripBrackets(h) : undefined;
    } catch {
      return undefined;
    }
  }
  let s = v;
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return end > 1 ? s.slice(1, end) : undefined;
  }
  s = s.split("/")[0].split(":")[0];
  if (!s || /[;=\s]/.test(s)) return undefined;
  return s;
}

export function resolveEgressHost(
  sandbox: SandboxPolicy | undefined,
  cred: Record<string, string> | undefined,
): { host?: string; hosts: string[]; error?: string } {
  if (!sandbox) return { hosts: [] };
  if (sandbox.egressFromField) {
    const raw = cred?.[sandbox.egressFromField];
    const host = typeof raw === "string" ? hostFromCredValue(raw) : undefined;
    if (!host) {
      return {
        hosts: [],
        error: `cannot derive egress host from credential field '${sandbox.egressFromField}'`,
      };
    }
    return { host, hosts: [host] };
  }
  // Combined allow-list: primary host + any extra sibling hosts.
  const hosts = [sandbox.egressDomain, ...(sandbox.egressDomains ?? [])].filter(
    (h): h is string => typeof h === "string" && h.length > 0,
  );
  return { host: hosts[0], hosts };
}

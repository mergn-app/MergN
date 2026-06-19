export type ModelValidation = { valid: true } | { valid: false; reason: "not_found" };

function googleApiKey(explicit?: string): string | undefined {
  return explicit || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

function stripGoogleModelName(name: string): string {
  return name.replace(/^models\//, "");
}

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`models list ${res.status}`);
  return res.json() as Promise<unknown>;
}

async function googleModels(apiKey: string): Promise<string[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const data = (await fetchJson(url)) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => stripGoogleModelName(m.name));
}

async function openAiModels(apiKey: string, baseURL?: string): Promise<string[]> {
  const base = (baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const data = (await fetchJson(`${base}/models`, {
    Authorization: `Bearer ${apiKey}`,
  })) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}

async function anthropicModels(apiKey: string): Promise<string[]> {
  const data = (await fetchJson("https://api.anthropic.com/v1/models", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  })) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}

async function localModels(baseURL: string, apiKey?: string): Promise<string[]> {
  const base = baseURL.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const data = (await fetchJson(`${base}/models`, headers)) as {
    data?: { id: string }[];
  };
  return (data.data ?? []).map((m) => m.id);
}

function listed(model: string, ids: string[]): boolean {
  const want = model.toLowerCase();
  return ids.some((id) => id.toLowerCase() === want);
}

/**
 * Check the provider's model list for an exact id match. Returns valid:true when
 * the list can't be fetched (missing key, network) so saves aren't blocked.
 */
export async function validateModelName(
  provider: string,
  model: string,
  opts: { apiKey?: string; baseURL?: string },
): Promise<ModelValidation> {
  const name = model.trim();
  if (!name) return { valid: true };

  try {
    let ids: string[] | null = null;
    switch (provider) {
      case "google": {
        const key = googleApiKey(opts.apiKey);
        if (!key) return { valid: true };
        ids = await googleModels(key);
        break;
      }
      case "openai": {
        if (!opts.apiKey) return { valid: true };
        ids = await openAiModels(opts.apiKey, opts.baseURL);
        break;
      }
      case "anthropic": {
        if (!opts.apiKey) return { valid: true };
        ids = await anthropicModels(opts.apiKey);
        break;
      }
      case "local":
      case "openai-compatible": {
        const base = opts.baseURL ?? "http://localhost:11434/v1";
        ids = await localModels(base, opts.apiKey);
        break;
      }
      default:
        return { valid: true };
    }
    if (!listed(name, ids)) return { valid: false, reason: "not_found" };
    return { valid: true };
  } catch {
    return { valid: true };
  }
}

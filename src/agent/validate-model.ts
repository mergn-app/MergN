export type ApiKeyValidation =
  | { valid: true; ids?: string[]; skipped?: true }
  | { valid: false; reason: "invalid_key" };

export type ModelValidation = { valid: true } | { valid: false; reason: "not_found" };

class ApiAuthError extends Error {}
class ApiFetchError extends Error {}

function googleApiKey(explicit?: string): string | undefined {
  return explicit || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

function stripGoogleModelName(name: string): string {
  return name.replace(/^models\//, "");
}

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (res.status === 401 || res.status === 403) throw new ApiAuthError(String(res.status));
  if (!res.ok) throw new ApiFetchError(String(res.status));
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
 * Verify credentials by fetching the provider model list. Must run before
 * validateModelName so a bad key never surfaces as a model-not-found error.
 */
export async function validateApiKey(
  provider: string,
  opts: { apiKey?: string; baseURL?: string },
): Promise<ApiKeyValidation> {
  try {
    switch (provider) {
      case "google": {
        const key = googleApiKey(opts.apiKey);
        if (!key) return { valid: true, skipped: true };
        return { valid: true, ids: await googleModels(key) };
      }
      case "openai": {
        if (!opts.apiKey) return { valid: true, skipped: true };
        return { valid: true, ids: await openAiModels(opts.apiKey, opts.baseURL) };
      }
      case "anthropic": {
        if (!opts.apiKey) return { valid: true, skipped: true };
        return { valid: true, ids: await anthropicModels(opts.apiKey) };
      }
      case "local":
      case "openai-compatible": {
        const base = opts.baseURL ?? "http://localhost:11434/v1";
        return { valid: true, ids: await localModels(base, opts.apiKey) };
      }
      default:
        return { valid: true, skipped: true };
    }
  } catch (e) {
    if (e instanceof ApiAuthError) return { valid: false, reason: "invalid_key" };
    return { valid: true, skipped: true };
  }
}

/** Check the provider model list for an exact id match. Run after validateApiKey. */
export async function validateModelName(
  provider: string,
  model: string,
  opts: { apiKey?: string; baseURL?: string },
  preloadedIds?: string[],
): Promise<ModelValidation> {
  const name = model.trim();
  if (!name) return { valid: true };

  try {
    let ids = preloadedIds;
    if (!ids) {
      const keyCheck = await validateApiKey(provider, opts);
      if (!keyCheck.valid || keyCheck.skipped || !keyCheck.ids) return { valid: true };
      ids = keyCheck.ids;
    }
    if (!listed(name, ids)) return { valid: false, reason: "not_found" };
    return { valid: true };
  } catch {
    return { valid: true };
  }
}

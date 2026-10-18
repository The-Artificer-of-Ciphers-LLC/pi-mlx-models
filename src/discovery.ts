/** Upper bound for model discovery, covering the request and the body read (D-10). */
export const DISCOVERY_TIMEOUT_MS = 5000;

export interface DiscoverModelIdsOptions {
  baseUrl: string;
  /** Defaults to the global fetch; tests that need a real timeout leave it unset. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask the local server which models it serves. Every failure (abort, refused connection,
 * non-200, bad JSON, wrong shape) yields an empty list so pi still loads.
 */
export async function discoverModelIds(options: DiscoverModelIdsOptions): Promise<string[]> {
  const doFetch = options.fetch ?? fetch;
  try {
    // One signal for the request and the body read, so a server that stalls mid-body is aborted too.
    const signal = AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
    const res = await doFetch(`${options.baseUrl}/models`, { signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data)) return [];
    return body.data.map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/** What a probe of the models endpoint learned: whether the server answered, and the ids when it did. */
export type ModelsProbe = { answers: true; ids: string[] } | { answers: false };

export async function probeModels(_options: DiscoverModelIdsOptions): Promise<ModelsProbe> {
  throw new Error("not implemented");
}

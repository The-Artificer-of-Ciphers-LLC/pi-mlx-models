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
  const probe = await probeModels(options);
  return probe.answers ? probe.ids : [];
}

/** What a probe of the models endpoint learned: whether the server answered, and the ids when it did. */
export type ModelsProbe = { answers: true; ids: string[] } | { answers: false };

/**
 * Ask whether the server answers its models endpoint. A server answers when it replies HTTP 200 with a `data` array,
 * even an empty one: zero models is still an answer, and only silence or a wrong reply is not (D-08). Same request and
 * bound as discoverModelIds. Never throws.
 */
export async function probeModels(options: DiscoverModelIdsOptions): Promise<ModelsProbe> {
  const doFetch = options.fetch ?? fetch;
  try {
    const signal = AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
    const res = await doFetch(`${options.baseUrl}/models`, { signal });
    if (res.status !== 200) return { answers: false };
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data)) return { answers: false };
    const ids = body.data.map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    return { answers: true, ids };
  } catch {
    return { answers: false };
  }
}

/**
 * The request half of the sampling settings (GEN-01, GEN-02): a pure rewrite of the payload pi is about to send to this
 * provider. It imports nothing from pi and nothing from settings.ts; settings.ts imports these types. Field names are the
 * ones mlx-lm reads (checked against mlx-lm v0.32.2 and pi-ai 1.3.0).
 */

/** The sampling keys in schema order; the names are the config keys under `model.sampling`. */
export const SAMPLING_KEYS = ["temperature", "topP", "topK", "minP", "repetitionPenalty", "maxTokens", "stop", "seed"] as const;

export type SamplingKey = (typeof SAMPLING_KEYS)[number];

/** The configured sampling values; a key that is not configured is absent and its request field is left as pi sent it. */
export interface SamplingValues {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repetitionPenalty?: number;
  maxTokens?: number;
  stop?: string | string[];
  seed?: number;
}

/** What the extension writes into a request: sampling values and the merged chat template arguments (non-empty when present). */
export interface RequestOverrides {
  sampling: SamplingValues;
  chatTemplateArgs?: { readonly [key: string]: unknown };
}

/** The launch made in this session: the model id it served and what to write into that model's requests. */
export interface ActiveLaunch {
  modelId: string;
  request: RequestOverrides;
}

export type Rewrite =
  | { kind: "unchanged" }
  | { kind: "bad-shape" }
  | { kind: "rewritten"; payload: Record<string, unknown> };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Apply the launch's values to a payload. Every configured value overwrites the same field; a field that is not configured
 * is left exactly as pi sent it (D-10). When template arguments are configured they replace pi's `chat_template_kwargs`
 * and pi's `reasoning_effort` is removed, so one source remains (D-16). A payload for another model is unchanged (D-13);
 * one that is not an object with a `messages` array is reported as `bad-shape` (D-11). The input is never touched: the
 * result is a shallow copy, and the arguments and any list are copied per call so the launch record is never aliased.
 */
export function applyRequestOverrides(payload: unknown, active: ActiveLaunch): Rewrite {
  if (!isPlainObject(payload)) return { kind: "bad-shape" };
  if (payload.model !== active.modelId) return { kind: "unchanged" };
  if (!Array.isArray(payload.messages)) return { kind: "bad-shape" };

  const result: Record<string, unknown> = { ...payload };
  let applied = false;
  const { sampling, chatTemplateArgs } = active.request;

  if (sampling.temperature !== undefined) {
    result.temperature = sampling.temperature;
    applied = true;
  }
  if (chatTemplateArgs !== undefined && Object.keys(chatTemplateArgs).length > 0) {
    result.chat_template_kwargs = JSON.parse(JSON.stringify(chatTemplateArgs)) as unknown;
    delete result.reasoning_effort;
    applied = true;
  }
  return applied ? { kind: "rewritten", payload: result } : { kind: "unchanged" };
}

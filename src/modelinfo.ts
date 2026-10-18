/**
 * What pi is told about a model: its context window, output limit, reasoning flag and input kinds, and where each value
 * came from (MOD-01). The context window is read from the model's own `config.json`.
 */

/** The context window registered for a model whose `config.json` cannot be read or holds no usable value (D-03). */
export const FALLBACK_CONTEXT_WINDOW = 32768;

/** The largest `config.json` that is read; a real one is a few KiB, a quantized one a few hundred (T-05-06). */
export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export type InputKind = "text" | "image";

/** The outcome of looking for a model's `config.json`: the parsed object and where it came from, or why there is none. */
export type ModelConfigRead = { ok: true; config: unknown; source: "cache" | "hub" | "path" } | { ok: false; reason: string };

export interface ReadModelConfigOptions {
  /** Whether the Hugging Face Hub may be asked when the cache has no copy. */
  hub: boolean;
}

/** Looks up a model's `config.json`. Never throws and never rejects. */
export type ReadModelConfig = (modelId: string, options: ReadModelConfigOptions) => Promise<ModelConfigRead>;

export interface ModelConfigReaderOptions {
  /** The Hugging Face hub cache directory; default is derived from the environment. */
  cacheRoot?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  hubTimeoutMs?: number;
  hubBaseUrl?: string;
  /** What a `./` or `../` model path is resolved against; default is the process's working directory. */
  cwd?: string;
}

export interface ModelInfo {
  contextWindow: number;
  contextSource: string;
  maxTokens: number;
  maxTokensSource: string;
  reasoning: boolean;
  reasoningSource: string;
  input: InputKind[];
  inputSource: string;
  /** Why the context window is the fallback, when it is. */
  fallbackReason?: string;
}

export function contextWindowOf(_config: unknown): number | undefined {
  return undefined;
}

export function createModelConfigReader(_options: ModelConfigReaderOptions = {}): ReadModelConfig {
  return async () => ({ ok: false, reason: "not implemented" });
}

export function defaultMaxTokens(_contextWindow: number, _reasoning: boolean): number {
  return 8192;
}

export function deriveModelInfo(_input: { id: string; config?: ModelConfigRead }): ModelInfo {
  return {
    contextWindow: 128000,
    contextSource: "default",
    maxTokens: 8192,
    maxTokensSource: "default",
    reasoning: false,
    reasoningSource: "default",
    input: ["text"],
    inputSource: "default",
  };
}

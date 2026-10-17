export const MODEL_PRESETS = [
  {
    key: "deepseek_r1_1_5b",
    modelId: "mlx-community/DeepSeek-R1-Distill-Qwen-1.5B-4bit",
    tags: ["reasoning", "math", "debugging", "planning"],
  },
  {
    key: "gemma4_e2b",
    modelId: "mlx-community/gemma-4-e2b-it-4bit",
    tags: ["writing", "summarization", "brainstorming", "general"],
  },
  {
    key: "llama3_2_3b",
    modelId: "mlx-community/Llama-3.2-3B-Instruct-4bit",
    tags: ["chat", "rewriting", "summarization", "light-coding"],
  },
  {
    key: "qwen3_4b",
    modelId: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
    tags: ["coding", "reasoning", "structured-output", "general"],
  },
  {
    key: "smollm3_3b",
    modelId: "mlx-community/SmolLM3-3B-4bit",
    tags: ["fast-chat", "quick-drafts", "classification", "extraction"],
  },
] as const;

export type ModelPreset = (typeof MODEL_PRESETS)[number];

/**
 * Either a model to start, or an `error` explaining why the input cannot be one. The failure variant lists
 * `modelId` and `preset` as optional undefined so reading them off an unnarrowed result still compiles.
 */
export type ResolvedModel =
  | { modelId: string; preset?: ModelPreset; error?: undefined }
  | { error: string; modelId?: undefined; preset?: undefined };

/**
 * Resolve a preset number, preset key, or full model id; empty input falls back to `defaultModel`.
 * A number outside the preset range, and an id that starts with "-" (it would become a server flag), are errors.
 */
export function resolveModel(input: string | undefined, defaultModel: string): ResolvedModel {
  const normalized = (input || "").trim();
  if (!normalized) {
    const preset = MODEL_PRESETS.find((p) => p.modelId === defaultModel || p.key === defaultModel);
    return { modelId: preset?.modelId ?? defaultModel, preset };
  }

  if (/^\d+$/.test(normalized)) {
    const idx = Number(normalized) - 1;
    if (idx < 0 || idx >= MODEL_PRESETS.length) {
      return { error: `Preset number ${normalized} is out of range (choose 1-${MODEL_PRESETS.length})` };
    }
    const preset = MODEL_PRESETS[idx];
    return { modelId: preset.modelId, preset };
  }

  if (normalized.startsWith("-")) {
    return { error: `Model ids must not start with "-" (got ${JSON.stringify(normalized)})` };
  }

  const preset = MODEL_PRESETS.find((p) => p.key === normalized || p.modelId === normalized);
  if (preset) return { modelId: preset.modelId, preset };
  return { modelId: normalized };
}

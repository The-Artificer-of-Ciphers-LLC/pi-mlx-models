import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_PRESETS, resolveModel } from "./presets.js";

const DEFAULT = MODEL_PRESETS[3].modelId;

test("empty input resolves to the default model and its preset", () => {
  assert.equal(resolveModel("  ", DEFAULT).preset?.key, "qwen3_4b");
});

test("accepts 1-based number, key, or full id", () => {
  assert.equal(resolveModel("1", DEFAULT).preset?.key, "deepseek_r1_1_5b");
  assert.equal(resolveModel("gemma4_e2b", DEFAULT).modelId, MODEL_PRESETS[1].modelId);
  assert.equal(resolveModel(MODEL_PRESETS[2].modelId, DEFAULT).preset?.key, "llama3_2_3b");
});

test("unknown input passes through as a raw model id", () => {
  assert.deepEqual(resolveModel("org/some-model", DEFAULT), { modelId: "org/some-model" });
  assert.deepEqual(resolveModel("99", DEFAULT), { modelId: "99" });
});

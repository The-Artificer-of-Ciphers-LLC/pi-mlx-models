import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_PRESETS, resolveModel } from "./presets.js";

const DEFAULT = MODEL_PRESETS[3].modelId;

/** Reads the failure text off either result shape, so the same helper works before and after the union. */
const errorOf = (result: object) => (result as { error?: string }).error;

test("empty input resolves to the default model and its preset", () => {
  assert.equal(resolveModel("  ", DEFAULT).preset?.key, "qwen3_4b");
});

test("accepts 1-based number, key, or full id", () => {
  assert.equal(resolveModel("1", DEFAULT).preset?.key, "deepseek_r1_1_5b");
  assert.equal(resolveModel("gemma4_e2b", DEFAULT).modelId, MODEL_PRESETS[1].modelId);
  assert.equal(resolveModel(MODEL_PRESETS[2].modelId, DEFAULT).preset?.key, "llama3_2_3b");
});

test("every preset number from 1 to the preset count resolves to the matching preset", () => {
  MODEL_PRESETS.forEach((preset, i) => {
    const result = resolveModel(String(i + 1), DEFAULT);
    assert.equal(errorOf(result), undefined);
    assert.equal(result.modelId, preset.modelId);
    assert.equal(result.preset?.key, preset.key);
  });
});

test("unknown non-numeric input passes through as a raw model id", () => {
  assert.deepEqual(resolveModel("org/some-model", DEFAULT), { modelId: "org/some-model" });
});

test("preset numbers outside 1 to the preset count are errors, not raw ids", () => {
  for (const input of ["0", "9", "99", "007"]) {
    const result = resolveModel(input, DEFAULT);
    const error = errorOf(result);
    assert.ok(error, `expected an error for ${input}`);
    assert.match(error, /out of range/);
    assert.match(error, new RegExp(`1-${MODEL_PRESETS.length}`));
    assert.equal(result.modelId, undefined);
  }
});

test("a model id that starts with a dash is an error so it cannot be read as a server flag", () => {
  for (const input of ["-x", "--help", "-"]) {
    const result = resolveModel(input, DEFAULT);
    const error = errorOf(result);
    assert.ok(error, `expected an error for ${input}`);
    assert.match(error, /must not start with "-"/);
    assert.equal(result.modelId, undefined);
  }
});

test("a preset key or full id that is valid is never reported as an error", () => {
  for (const preset of MODEL_PRESETS) {
    assert.equal(errorOf(resolveModel(preset.key, DEFAULT)), undefined);
    assert.equal(errorOf(resolveModel(preset.modelId, DEFAULT)), undefined);
  }
});

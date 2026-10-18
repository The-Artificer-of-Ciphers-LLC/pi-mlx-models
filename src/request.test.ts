import test from "node:test";
import assert from "node:assert/strict";
import { SAMPLING_KEYS, applyRequestOverrides, type ActiveLaunch, type RequestOverrides, type SamplingValues } from "./request.js";
import { SETTINGS } from "./settings.js";

const MODEL = "m";

const activeOf = (request: Partial<RequestOverrides> = {}): ActiveLaunch => ({ modelId: MODEL, request: { sampling: {}, ...request } });
const samplingOf = (sampling: SamplingValues): ActiveLaunch => activeOf({ sampling });

/** The rewritten payload, or a failed assertion. */
function rewritten(payload: unknown, active: ActiveLaunch): Record<string, unknown> {
  const result = applyRequestOverrides(payload, active);
  assert.equal(result.kind, "rewritten", JSON.stringify(result));
  assert.ok(result.kind === "rewritten");
  return result.payload;
}

const base = (extra: Record<string, unknown> = {}) => ({ model: MODEL, messages: [], ...extra });

// ---- one field each ----

const ONE_FIELD: ReadonlyArray<[key: keyof SamplingValues, field: string, configured: number, piSent: number]> = [
  ["topP", "top_p", 0.5, 1],
  ["topK", "top_k", 5, 50],
  ["minP", "min_p", 0.1, 0],
  ["repetitionPenalty", "repetition_penalty", 1.1, 1],
  ["seed", "seed", 1, 99],
];

for (const [key, field, configured, piSent] of ONE_FIELD) {
  test(`${key} overwrites the ${field} pi sent`, () => {
    const result = rewritten(base({ [field]: piSent }), samplingOf({ [key]: configured }));
    assert.equal(result[field], configured);
  });
}

test("a stop string is written as given", () => {
  assert.equal(rewritten(base({ stop: ["pi"] }), samplingOf({ stop: "END" })).stop, "END");
});

test("a stop list is written as an equal copy that is not the same array", () => {
  const stop = ["a", "b"];
  const result = rewritten(base(), samplingOf({ stop }));
  assert.deepEqual(result.stop, ["a", "b"]);
  assert.notEqual(result.stop, stop);
});

// ---- the output limit has two possible names ----

test("maxTokens overwrites both max_completion_tokens and max_tokens when the payload has both", () => {
  const result = rewritten(base({ max_completion_tokens: 8192, max_tokens: 4096 }), samplingOf({ maxTokens: 256 }));
  assert.equal(result.max_completion_tokens, 256);
  assert.equal(result.max_tokens, 256);
});

test("maxTokens overwrites max_completion_tokens and leaves max_tokens absent when the payload only has the first", () => {
  const result = rewritten(base({ max_completion_tokens: 8192 }), samplingOf({ maxTokens: 256 }));
  assert.equal(result.max_completion_tokens, 256);
  assert.equal("max_tokens" in result, false);
});

test("maxTokens adds max_completion_tokens when the payload has neither, and does not add max_tokens", () => {
  const result = rewritten(base(), samplingOf({ maxTokens: 256 }));
  assert.equal(result.max_completion_tokens, 256);
  assert.equal("max_tokens" in result, false);
});

// ---- what is not configured stays as pi sent it ----

test("fields the configuration does not set stay exactly as pi sent them", () => {
  const payload = base({ temperature: 0.9, max_completion_tokens: 8192, top_k: 50, stream: true, stop: ["pi"] });
  const result = rewritten(payload, samplingOf({ topP: 0.5 }));
  assert.deepEqual(result, { ...payload, top_p: 0.5 });
});

test("nothing configured returns unchanged", () => {
  assert.deepEqual(applyRequestOverrides(base({ temperature: 0.9 }), activeOf()), { kind: "unchanged" });
});

test("an empty chatTemplateArgs object counts as not configured: pi's kwargs and reasoning_effort are preserved", () => {
  const payload = base({ reasoning_effort: "high", chat_template_kwargs: { enable_thinking: true } });
  assert.deepEqual(applyRequestOverrides(payload, activeOf({ chatTemplateArgs: {} })), { kind: "unchanged" });
  const withSampling = rewritten(payload, activeOf({ sampling: { topP: 0.5 }, chatTemplateArgs: {} }));
  assert.equal(withSampling.reasoning_effort, "high");
  assert.deepEqual(withSampling.chat_template_kwargs, { enable_thinking: true });
});

// ---- the template arguments replace pi's ----

test("chat_template_kwargs is replaced, not merged: a key only pi sent is gone", () => {
  const payload = base({ reasoning_effort: "high", chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } });
  const result = rewritten(payload, activeOf({ chatTemplateArgs: { enable_thinking: false } }));
  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: false });
  assert.equal("reasoning_effort" in result, false);
});

test("the written kwargs are a fresh copy: changing them does not change the launch record", () => {
  const active = activeOf({ chatTemplateArgs: { nested: { a: 1 } } });
  const result = rewritten(base(), active);
  (result.chat_template_kwargs as { nested: { a: number } }).nested.a = 2;
  assert.deepEqual(active.request.chatTemplateArgs, { nested: { a: 1 } });
  const again = rewritten(base(), active);
  assert.deepEqual(again.chat_template_kwargs, { nested: { a: 1 } });
});

// ---- the input is never touched ----

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("a deeply frozen payload does not throw and is unchanged after the call", () => {
  const payload = deepFreeze(base({ temperature: 0.9, reasoning_effort: "high", chat_template_kwargs: { enable_thinking: true }, stop: ["pi"] }));
  const before = structuredClone(payload);
  const result = rewritten(
    payload,
    activeOf({ sampling: { temperature: 0.2, maxTokens: 10, stop: ["x"] }, chatTemplateArgs: { enable_thinking: false } }),
  );
  assert.notEqual(result, payload);
  assert.deepEqual(payload, before);
});

// ---- the shape guard ----

const BAD_SHAPES: ReadonlyArray<[string, unknown]> = [
  ["null", null],
  ["an array", []],
  ["a string", "payload"],
  ["a number", 5],
  ["an object without messages", { model: MODEL }],
  ["an object whose messages is not an array", { model: MODEL, messages: "hi" }],
];

for (const [name, payload] of BAD_SHAPES) {
  test(`${name} is bad-shape`, () => {
    assert.deepEqual(applyRequestOverrides(payload, samplingOf({ temperature: 0.2 })), { kind: "bad-shape" });
  });
}

test("a payload for another model id is unchanged, whatever else it holds", () => {
  assert.deepEqual(applyRequestOverrides({ model: "other", messages: [] }, samplingOf({ temperature: 0.2 })), { kind: "unchanged" });
});

// ---- the request field names are the schema's ----

test("every model.sampling row's requestField is a field the rewrite writes", () => {
  const SAMPLE: Record<string, unknown> = {
    temperature: 0.5,
    topP: 0.5,
    topK: 5,
    minP: 0.1,
    repetitionPenalty: 1.1,
    maxTokens: 100,
    stop: "x",
    seed: 1,
  };
  const rows = SETTINGS.filter((row) => row.path.startsWith("model.sampling."));
  assert.deepEqual(
    rows.map((row) => row.path.slice("model.sampling.".length)),
    [...SAMPLING_KEYS],
  );
  for (const row of rows) {
    const key = row.path.slice("model.sampling.".length);
    assert.ok(row.requestField !== undefined, `${row.path} names its request field`);
    const result = rewritten(base(), samplingOf({ [key]: SAMPLE[key] }));
    assert.ok(Object.prototype.hasOwnProperty.call(result, row.requestField), `${key} must write ${row.requestField}`);
  }
});

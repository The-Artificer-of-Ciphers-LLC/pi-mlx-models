import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FALLBACK_CONTEXT_WINDOW,
  MAX_CONFIG_BYTES,
  contextWindowOf,
  createModelConfigReader,
  defaultMaxTokens,
  deriveModelInfo,
  resolveCacheRoot,
} from "./modelinfo.js";
import { hfFixture, writeHfCache } from "./testkit.js";

/** A fresh temporary directory, removed when the test ends. */
function tempDir(t: TestContext, prefix = "pi-mlx-modelinfo-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const NOT_AN_ID = "not a Hugging Face repository id or an absolute path";

// ---------------------------------------------------------------------------------------------------------------------
// The context window of a config.json (D-01)
// ---------------------------------------------------------------------------------------------------------------------

const FIXTURE_WINDOWS: Array<[string, number]> = [
  ["deepseek-r1-distill-qwen-1.5b-4bit", 131072],
  ["gemma-4-e2b-it-4bit", 131072],
  ["llama-3.2-3b-instruct-4bit", 131072],
  ["qwen3-4b-instruct-2507-4bit", 262144],
  ["smollm3-3b-4bit", 65536],
  ["kat-coder-v2.5-dev-optiq-4bit", 262144],
];

test("the six real config.json shapes give the window of their model", () => {
  for (const [name, expected] of FIXTURE_WINDOWS) {
    assert.equal(contextWindowOf(hfFixture(name)), expected, name);
  }
});

test("the gemma-4 and KAT fixtures keep the window only in text_config, the other four at the top level", () => {
  for (const name of ["gemma-4-e2b-it-4bit", "kat-coder-v2.5-dev-optiq-4bit"]) {
    const config = hfFixture(name);
    assert.equal(Object.hasOwn(config, "max_position_embeddings"), false, `${name} has no top-level value`);
    assert.equal(typeof config.text_config.max_position_embeddings, "number", `${name} has a nested value`);
  }
  for (const name of [
    "deepseek-r1-distill-qwen-1.5b-4bit",
    "llama-3.2-3b-instruct-4bit",
    "qwen3-4b-instruct-2507-4bit",
    "smollm3-3b-4bit",
  ]) {
    assert.equal(typeof hfFixture(name).max_position_embeddings, "number", `${name} has a top-level value`);
  }
});

test("a valid text_config value wins over a valid top-level one", () => {
  assert.equal(contextWindowOf({ max_position_embeddings: 4096, text_config: { max_position_embeddings: 8192 } }), 8192);
});

test("an invalid nested value falls through to a valid top-level one, and two invalid values give nothing", () => {
  assert.equal(contextWindowOf({ max_position_embeddings: 4096, text_config: { max_position_embeddings: 0 } }), 4096);
  assert.equal(contextWindowOf({ max_position_embeddings: 0, text_config: { max_position_embeddings: -1 } }), undefined);
});

test("a value that is not a positive safe integer is rejected", () => {
  const bad: unknown[] = [0, -1, 1.5, "262144", null, true, [], {}, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY];
  for (const value of bad) {
    assert.equal(contextWindowOf({ max_position_embeddings: value }), undefined, `top level ${JSON.stringify(value)}`);
    assert.equal(contextWindowOf({ text_config: { max_position_embeddings: value } }), undefined, `nested ${JSON.stringify(value)}`);
  }
});

test("a config that is not an object gives nothing", () => {
  for (const config of [null, undefined, [], "text", 7, true]) {
    assert.equal(contextWindowOf(config), undefined);
  }
});

test("only own properties are read: a __proto__ key, an inherited value and an array text_config change nothing", () => {
  assert.equal(contextWindowOf(JSON.parse('{"__proto__":{"max_position_embeddings":99}}')), undefined);
  assert.equal(contextWindowOf(Object.create({ max_position_embeddings: 5 })), undefined);
  assert.equal(contextWindowOf({ text_config: Object.create({ max_position_embeddings: 5 }) }), undefined);
  const arrayHolder = Object.assign([], { max_position_embeddings: 5 });
  assert.equal(contextWindowOf({ text_config: arrayHolder, max_position_embeddings: 7 }), 7);
});

// ---------------------------------------------------------------------------------------------------------------------
// The cache root and the snapshot (D-02)
// ---------------------------------------------------------------------------------------------------------------------

test("the cache root is HF_HUB_CACHE when set and not blank, else the hub folder of the extension's HF_HOME", () => {
  assert.equal(resolveCacheRoot({ HF_HUB_CACHE: "/x/hub-cache" }, "/home/data"), "/x/hub-cache");
  assert.equal(resolveCacheRoot({ HF_HUB_CACHE: "  /x/hub-cache  " }, "/home/data"), "/x/hub-cache");
  assert.equal(resolveCacheRoot({ HF_HUB_CACHE: "" }, "/home/data"), join("/home/data", "hub"));
  assert.equal(resolveCacheRoot({ HF_HUB_CACHE: "  \t " }, "/home/data"), join("/home/data", "hub"));
  assert.equal(resolveCacheRoot({}, "/home/data"), join("/home/data", "hub"));
});

test("the reader follows refs/main to a symlinked snapshot file, the layout huggingface_hub writes", async (t) => {
  const cacheRoot = tempDir(t);
  writeHfCache(cacheRoot, "mlx-community/Qwen3-4B-Instruct-2507-4bit", hfFixture("qwen3-4b-instruct-2507-4bit"));

  const read = await createModelConfigReader({ cacheRoot })("mlx-community/Qwen3-4B-Instruct-2507-4bit", { hub: false });

  assert.equal(read.ok, true);
  assert.ok(read.ok);
  assert.equal(read.source, "cache");
  assert.equal(contextWindowOf(read.config), 262144);
});

test("the reader reads a snapshot config.json that is a regular file", async (t) => {
  const cacheRoot = tempDir(t);
  writeHfCache(cacheRoot, "org/plain", { max_position_embeddings: 4096 }, { regularFile: true });

  const read = await createModelConfigReader({ cacheRoot })("org/plain", { hub: false });

  assert.ok(read.ok);
  assert.equal(contextWindowOf(read.config), 4096);
});

test("without refs/main the newest snapshot that holds a config.json is used", async (t) => {
  const cacheRoot = tempDir(t);
  const older = writeHfCache(cacheRoot, "org/m", { max_position_embeddings: 1000 }, { revision: "a".repeat(40), omitRefs: true });
  const newer = writeHfCache(cacheRoot, "org/m", { max_position_embeddings: 2000 }, { revision: "b".repeat(40), omitRefs: true });
  // The newest snapshot of all has no config.json, so it is skipped.
  const empty = join(cacheRoot, "models--org--m", "snapshots", "c".repeat(40));
  mkdirSync(empty);
  utimesSync(older, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
  utimesSync(newer, new Date(1_100_000_000_000), new Date(1_100_000_000_000));
  utimesSync(empty, new Date(1_200_000_000_000), new Date(1_200_000_000_000));

  const read = await createModelConfigReader({ cacheRoot })("org/m", { hub: false });

  assert.ok(read.ok);
  assert.equal(contextWindowOf(read.config), 2000);
});

test("a refs/main naming a missing snapshot, or holding text that is not a revision, is ignored for the newest snapshot", async (t) => {
  const cacheRoot = tempDir(t);
  writeHfCache(cacheRoot, "org/missing-rev", { max_position_embeddings: 3000 }, { revision: "a".repeat(40), refsText: "f".repeat(40) });
  writeHfCache(cacheRoot, "org/bad-rev", { max_position_embeddings: 5000 }, { revision: "b".repeat(40), refsText: "main\n" });
  const reader = createModelConfigReader({ cacheRoot });

  const missing = await reader("org/missing-rev", { hub: false });
  const bad = await reader("org/bad-rev", { hub: false });

  assert.ok(missing.ok);
  assert.equal(contextWindowOf(missing.config), 3000);
  assert.ok(bad.ok);
  assert.equal(contextWindowOf(bad.config), 5000);
});

test("a model that is not in the cache gives a constant reason", async (t) => {
  const cacheRoot = join(tempDir(t), "no-such-cache");

  const read = await createModelConfigReader({ cacheRoot })("org/absent", { hub: false });

  assert.deepEqual(read, { ok: false, reason: "not in the Hugging Face cache" });
});

test("a refs/main that is a directory gives a failed read and does not throw", async (t) => {
  const cacheRoot = tempDir(t);
  mkdirSync(join(cacheRoot, "models--org--m", "refs", "main"), { recursive: true });

  const read = await createModelConfigReader({ cacheRoot })("org/m", { hub: false });

  assert.equal(read.ok, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// The model id is checked before any path is built (T-05-04)
// ---------------------------------------------------------------------------------------------------------------------

test("an id that is not a repository id or a path is rejected before the file system is touched", async (t) => {
  const cacheRoot = join(tempDir(t), "no-such-cache");
  const reader = createModelConfigReader({ cacheRoot });
  const rejected = [
    "org/..",
    "a/../b",
    "x/..",
    "a/b/c",
    "",
    "-x",
    "~/x",
    " a/b",
    "a b/c",
    "a/b\u0000",
    "a/b\n",
    "a".repeat(201),
  ];

  for (const id of rejected) {
    assert.deepEqual(await reader(id, { hub: false }), { ok: false, reason: NOT_AN_ID }, JSON.stringify(id));
  }
});

test("a plain name, an org/name and a name with dots, underscores and dashes are looked up in the cache", async (t) => {
  const cacheRoot = tempDir(t);
  const reader = createModelConfigReader({ cacheRoot });

  for (const id of ["org/name", "org/name.v2_x-3", "gpt2"]) {
    writeHfCache(cacheRoot, id, { max_position_embeddings: 2048 });
    const read = await reader(id, { hub: false });
    assert.ok(read.ok, id);
    assert.equal(read.source, "cache");
    assert.equal(contextWindowOf(read.config), 2048);
  }
});

test("a traversal id never reaches a decoy directory that an unchecked join would normalise to", async (t) => {
  const cacheRoot = tempDir(t);
  // join(cacheRoot, "models--x--../../decoy") is <cacheRoot>/decoy: lay a readable cache entry out there.
  const revision = "d".repeat(40);
  mkdirSync(join(cacheRoot, "decoy", "refs"), { recursive: true });
  writeFileSync(join(cacheRoot, "decoy", "refs", "main"), revision);
  mkdirSync(join(cacheRoot, "decoy", "snapshots", revision), { recursive: true });
  writeFileSync(join(cacheRoot, "decoy", "snapshots", revision, "config.json"), JSON.stringify({ max_position_embeddings: 99 }));

  const read = await createModelConfigReader({ cacheRoot })("x/../../decoy", { hub: false });

  assert.deepEqual(read, { ok: false, reason: NOT_AN_ID });
});

// ---------------------------------------------------------------------------------------------------------------------
// The size and the shape of the file (T-05-06)
// ---------------------------------------------------------------------------------------------------------------------

test("a real KAT config.json with a 100 KB quantization block is accepted and still gives its window", async (t) => {
  const cacheRoot = tempDir(t);
  const config = hfFixture("kat-coder-v2.5-dev-optiq-4bit");
  config.quantization = Object.fromEntries(
    Array.from({ length: 4000 }, (_, i) => [`language_model.model.layers.${i}.mlp.gate_proj`, { group_size: 64, bits: 4 }]),
  );
  const snapshot = writeHfCache(cacheRoot, "mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit", config);
  assert.ok(statSync(join(snapshot, "config.json")).size > 100_000);

  const read = await createModelConfigReader({ cacheRoot })("mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit", { hub: false });

  assert.ok(read.ok);
  assert.equal(contextWindowOf(read.config), 262144);
});

test("a config.json larger than 2 MiB is refused and one of exactly 2 MiB is read", async (t) => {
  const cacheRoot = tempDir(t);
  const head = '{"max_position_embeddings":4096}';
  writeHfCache(cacheRoot, "org/over", null, { raw: head + " ".repeat(MAX_CONFIG_BYTES + 1 - head.length) });
  writeHfCache(cacheRoot, "org/exact", null, { raw: head + " ".repeat(MAX_CONFIG_BYTES - head.length) });
  const reader = createModelConfigReader({ cacheRoot });

  assert.deepEqual(await reader("org/over", { hub: false }), { ok: false, reason: "config.json is larger than 2 MiB" });
  const exact = await reader("org/exact", { hub: false });
  assert.ok(exact.ok);
  assert.equal(contextWindowOf(exact.config), 4096);
});

test("invalid JSON and valid JSON that is not an object are refused with their own reasons", async (t) => {
  const cacheRoot = tempDir(t);
  writeHfCache(cacheRoot, "org/broken", null, { raw: '{"max_position_embeddings": ' });
  writeHfCache(cacheRoot, "org/array", null, { raw: "[1, 2]" });
  writeHfCache(cacheRoot, "org/number", null, { raw: "4096" });
  const reader = createModelConfigReader({ cacheRoot });

  assert.deepEqual(await reader("org/broken", { hub: false }), { ok: false, reason: "config.json is not valid JSON" });
  assert.deepEqual(await reader("org/array", { hub: false }), { ok: false, reason: "config.json is not a JSON object" });
  assert.deepEqual(await reader("org/number", { hub: false }), { ok: false, reason: "config.json is not a JSON object" });
});

test("a config.json that is a directory gives a failed read and does not throw", async (t) => {
  const cacheRoot = tempDir(t);
  const revision = "e".repeat(40);
  mkdirSync(join(cacheRoot, "models--org--dir", "refs"), { recursive: true });
  writeFileSync(join(cacheRoot, "models--org--dir", "refs", "main"), revision);
  mkdirSync(join(cacheRoot, "models--org--dir", "snapshots", revision, "config.json"), { recursive: true });

  const read = await createModelConfigReader({ cacheRoot })("org/dir", { hub: false });

  assert.equal(read.ok, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// A local model directory
// ---------------------------------------------------------------------------------------------------------------------

test("an absolute directory holding a config.json is read as a path, and a missing one fails", async (t) => {
  const root = tempDir(t);
  const model = join(root, "my-model");
  mkdirSync(model);
  writeFileSync(join(model, "config.json"), JSON.stringify({ max_position_embeddings: 16384 }));
  const reader = createModelConfigReader({ cacheRoot: join(root, "no-such-cache") });

  const read = await reader(model, { hub: false });
  const missing = await reader(join(root, "absent-model"), { hub: false });

  assert.ok(read.ok);
  assert.equal(read.source, "path");
  assert.equal(contextWindowOf(read.config), 16384);
  assert.equal(missing.ok, false);
});

test("a ./ path and a ../ path are resolved against the reader's working directory", async (t) => {
  const root = tempDir(t);
  const work = join(root, "work");
  mkdirSync(join(work, "sub"), { recursive: true });
  mkdirSync(join(root, "sub"));
  writeFileSync(join(work, "sub", "config.json"), JSON.stringify({ max_position_embeddings: 1111 }));
  writeFileSync(join(root, "sub", "config.json"), JSON.stringify({ max_position_embeddings: 2222 }));
  const reader = createModelConfigReader({ cacheRoot: join(root, "no-such-cache"), cwd: work });

  const here = await reader("./sub", { hub: false });
  const above = await reader("../sub", { hub: false });

  assert.ok(here.ok);
  assert.equal(here.source, "path");
  assert.equal(contextWindowOf(here.config), 1111);
  assert.ok(above.ok);
  assert.equal(contextWindowOf(above.config), 2222);
});

test("a local config.json that is a symlink to a file elsewhere is read, and none of its text reaches the derived record", async (t) => {
  const root = tempDir(t);
  const model = join(root, "model");
  mkdirSync(model);
  const outside = join(root, "outside.json");
  writeFileSync(outside, JSON.stringify({ max_position_embeddings: 4096, note: "SECRET-TEXT-12345", _name_or_path: "/Users/someone/private" }));
  symlinkSync(outside, join(model, "config.json"));

  const read = await createModelConfigReader({ cacheRoot: join(root, "no-such-cache") })(model, { hub: false });
  assert.ok(read.ok);
  const info = deriveModelInfo({ id: model, config: read });

  assert.equal(info.contextWindow, 4096);
  const shown = JSON.stringify(info);
  assert.equal(shown.includes("SECRET-TEXT-12345"), false);
  assert.equal(shown.includes("/Users/someone/private"), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// The derived record (D-03, D-07)
// ---------------------------------------------------------------------------------------------------------------------

test("a readable config derives the window from the file, the default output limit and no fallback reason", () => {
  const info = deriveModelInfo({
    id: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
    config: { ok: true, config: hfFixture("qwen3-4b-instruct-2507-4bit"), source: "cache" },
  });

  assert.equal(info.contextWindow, 262144);
  assert.equal(info.contextSource, "config.json");
  assert.equal(info.maxTokens, 8192);
  assert.equal(info.maxTokensSource, "default");
  assert.equal(info.reasoning, false);
  assert.deepEqual(info.input, ["text"]);
  assert.equal(Object.hasOwn(info, "fallbackReason"), false);
});

test("a failed read derives the fallback window with the reader's reason", () => {
  const info = deriveModelInfo({ id: "org/m", config: { ok: false, reason: "not in the Hugging Face cache" } });

  assert.equal(FALLBACK_CONTEXT_WINDOW, 32768);
  assert.equal(info.contextWindow, 32768);
  assert.equal(info.contextSource, "fallback");
  assert.equal(info.fallbackReason, "not in the Hugging Face cache");
  assert.equal(info.maxTokens, 8192);
});

test("a readable config with no usable value derives the fallback window", () => {
  const info = deriveModelInfo({ id: "org/m", config: { ok: true, config: { model_type: "x" }, source: "cache" } });

  assert.equal(info.contextWindow, 32768);
  assert.equal(info.contextSource, "fallback");
  assert.equal(info.fallbackReason, "config.json has no usable max_position_embeddings");
});

test("an undefined read derives the fallback window", () => {
  const info = deriveModelInfo({ id: "org/m" });

  assert.equal(info.contextWindow, 32768);
  assert.equal(info.contextSource, "fallback");
  assert.equal(info.fallbackReason, "config.json was not read");
});

test("the default output limit is a quarter of the window, capped at 8192 or 32768, and at least 1", () => {
  const table: Array<[number, boolean, number]> = [
    [262144, false, 8192],
    [65536, false, 8192],
    [131072, true, 32768],
    [262144, true, 32768],
    [32768, true, 8192],
    [4096, false, 1024],
    [4096, true, 1024],
    [3, false, 1],
    [1, true, 1],
  ];
  for (const [window, reasoning, expected] of table) {
    assert.equal(defaultMaxTokens(window, reasoning), expected, `${window} ${reasoning}`);
  }
});

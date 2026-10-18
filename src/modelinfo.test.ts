import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  FALLBACK_CONTEXT_WINDOW,
  HUB_TIMEOUT_MS,
  MAX_CONFIG_BYTES,
  contextWindowOf,
  createModelConfigReader,
  defaultMaxTokens,
  deriveModelInfo,
  describeModel,
  hubBaseUrlOf,
  resolveCacheRoot,
  type ModelConfigReaderOptions,
  type ModelInfo,
  type ReadModelConfig,
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

// ---------------------------------------------------------------------------------------------------------------------
// The line shown to the user (D-03, D-07)
// ---------------------------------------------------------------------------------------------------------------------

test("describeModel states the values and where each came from", () => {
  const info = deriveModelInfo({
    id: "org/plain-model",
    config: { ok: true, config: hfFixture("qwen3-4b-instruct-2507-4bit"), source: "cache" },
  });

  assert.equal(
    describeModel(info),
    "model: context 262144 (config.json), max output 8192 (default), reasoning no (default), input text (default)",
  );
});

test("describeModel shows the fallback window as a fallback", () => {
  const info = deriveModelInfo({ id: "org/plain-model", config: { ok: false, reason: "not in the Hugging Face cache" } });

  assert.ok(describeModel(info).startsWith("model: context 32768 (fallback), "));
});

test("describeModel cleans, redacts and clips every source text", () => {
  const base = deriveModelInfo({ id: "org/m" });
  const info: ModelInfo = {
    ...base,
    contextSource: "esc\u001b[31m\nline" + "x".repeat(200),
    maxTokensSource: "user:pass@host",
    reasoningSource: "bell\u0007tab\there",
    inputSource: "https://user:secret@example.com/path",
  };

  const line = describeModel(info);

  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(line), false, "no control character, newline included");
  assert.equal(line.includes("pass@"), false);
  assert.equal(line.includes("secret"), false);
  assert.ok(line.includes("***"));
  assert.ok(line.includes("x".repeat(60)));
  assert.equal(line.includes("x".repeat(80)), false, "a long source is clipped to 80 characters");
});

// ---------------------------------------------------------------------------------------------------------------------
// The Hugging Face Hub, asked once when the cache has nothing (D-02, T-05-08 to T-05-11). Real loopback servers only.
// ---------------------------------------------------------------------------------------------------------------------

interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
}

interface LoopbackHub {
  base: string;
  port: number;
  seen: SeenRequest[];
}

const CONFIG_PATH = "/org/name/resolve/main/config.json";
const MISS_PREFIX = "not in the local cache; ";

/** A loopback HTTP server that records every request; its sockets are destroyed and it is closed when the test ends. */
async function startHub(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse, hub: LoopbackHub) => void,
): Promise<LoopbackHub> {
  const sockets = new Set<Socket>();
  const hub: LoopbackHub = { base: "", port: 0, seen: [] };
  const server: Server = createServer((req, res) => {
    hub.seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    handler(req, res, hub);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  hub.port = (server.address() as AddressInfo).port;
  hub.base = `http://127.0.0.1:${hub.port}`;
  return hub;
}

const sendJson = (res: ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const sendText = (res: ServerResponse, body: string, status = 200): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
};

/** A reader with an empty cache, so every lookup is a cache miss; `options` may replace any default. */
function missReader(t: TestContext, options: ModelConfigReaderOptions = {}): ReadModelConfig {
  return createModelConfigReader({ cacheRoot: join(tempDir(t), "empty-cache"), env: {}, ...options });
}

/** The reason of a lookup that must fail with the Hub allowed. */
async function failureOf(reader: ReadModelConfig, id = "org/name"): Promise<string> {
  const read = await reader(id, { hub: true });
  assert.equal(read.ok, false, JSON.stringify(read));
  return read.ok ? "" : read.reason;
}

/** The port of a loopback address nobody listens on. */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** An injected fetch that answers the calls in order (the last answer repeats) and records them; no network is used. */
function fetchStub(...answers: Array<() => Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const stub: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (!answer) throw new Error("no answer prepared");
    return answer();
  };
  return { fetch: stub, calls };
}

const authorizationOf = (call: FetchCall | undefined): string | null => new Headers(call?.init?.headers).get("authorization");
const jsonResponse = (body: unknown) => (): Response => new Response(JSON.stringify(body), { status: 200 });
const redirectResponse = (location: string | null, status = 302) => (): Response =>
  new Response(null, { status, headers: location === null ? {} : { location } });

test("a cache hit never contacts the Hub", async (t) => {
  const hub = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 1 }));
  const cacheRoot = tempDir(t);
  writeHfCache(cacheRoot, "org/name", { max_position_embeddings: 2048 });

  const read = await createModelConfigReader({ cacheRoot, env: {}, hubBaseUrl: hub.base })("org/name", { hub: true });

  assert.ok(read.ok);
  assert.equal(read.source, "cache");
  assert.equal(contextWindowOf(read.config), 2048);
  assert.equal(hub.seen.length, 0);
});

test("a cache miss asks the Hub once for the repository's config.json and uses what it sends", async (t) => {
  const hub = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 40960 }));

  const read = await missReader(t, { hubBaseUrl: hub.base })("org/name", { hub: true });

  assert.ok(read.ok);
  assert.equal(read.source, "hub");
  assert.equal(contextWindowOf(read.config), 40960);
  assert.deepEqual(
    hub.seen.map((seen) => `${seen.method} ${seen.url}`),
    [`GET ${CONFIG_PATH}`],
  );
});

test("a plain single-name repository id is asked at its own path", async (t) => {
  const hub = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 1024 }));

  const read = await missReader(t, { hubBaseUrl: hub.base })("gpt2", { hub: true });

  assert.ok(read.ok);
  assert.deepEqual(
    hub.seen.map((seen) => seen.url),
    ["/gpt2/resolve/main/config.json"],
  );
});

test("with the Hub not allowed a cache miss says so and never contacts the Hub", async (t) => {
  const hub = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 1 }));

  const read = await missReader(t, { hubBaseUrl: hub.base })("org/name", { hub: false });

  assert.deepEqual(read, { ok: false, reason: "not in the Hugging Face cache" });
  assert.equal(hub.seen.length, 0);
});

test("HF_TOKEN is sent as a bearer token to the Hub's own origin", async (t) => {
  const hub = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 2048 }));

  const read = await missReader(t, { hubBaseUrl: hub.base, env: { HF_TOKEN: " hf_example-token " } })("org/name", { hub: true });

  assert.ok(read.ok);
  assert.equal(hub.seen[0]?.authorization, "Bearer hf_example-token");
});

test("without HF_TOKEN, or with a blank one, no Authorization header is sent", async (t) => {
  const hub = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 2048 }));

  for (const env of [{}, { HF_TOKEN: "" }, { HF_TOKEN: "   " }, { HF_TOKEN: undefined }]) {
    assert.ok((await missReader(t, { hubBaseUrl: hub.base, env })("org/name", { hub: true })).ok);
  }

  assert.equal(hub.seen.length, 4);
  for (const seen of hub.seen) assert.equal(seen.authorization, undefined);
});

test("the token appears in no reason and in no returned value", async (t) => {
  const token = "hf_SECRETTOKEN0123456789";
  const refusing = await startHub(t, (_req, res) => sendJson(res, { error: `bad token ${token}` }, 401));
  const serving = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 2048 }));
  const env = { HF_TOKEN: token };

  const reason = await failureOf(missReader(t, { hubBaseUrl: refusing.base, env }));
  const read = await missReader(t, { hubBaseUrl: serving.base, env })("org/name", { hub: true });

  assert.equal(reason.includes(token), false);
  assert.equal(JSON.stringify(read).includes(token), false);
  assert.equal(refusing.seen[0]?.authorization, `Bearer ${token}`);
});

test("a thrown error's text is never echoed into the reason", async (t) => {
  const secret = "https://user:hf_SECRET@host/path";
  const stub = fetchStub(() => {
    throw new Error(`connect failed ${secret}`);
  });

  const reason = await failureOf(missReader(t, { fetch: stub.fetch, env: { HF_TOKEN: "hf_SECRET" } }));

  assert.equal(reason, `${MISS_PREFIX}the Hugging Face Hub could not be reached`);
});

test("401 and 403 say the repository is gated, private or missing and name HF_TOKEN", async (t) => {
  for (const status of [401, 403]) {
    const hub = await startHub(t, (_req, res) => sendJson(res, { error: "x" }, status));
    const reason = await failureOf(missReader(t, { hubBaseUrl: hub.base }));
    assert.equal(
      reason,
      `${MISS_PREFIX}the Hugging Face Hub answered HTTP ${status}: the repository is gated, private or missing (set HF_TOKEN for a gated model)`,
    );
    assert.ok(reason.includes("gated, private or missing") && reason.includes("HF_TOKEN"));
  }
});

test("404 says the model was not found", async (t) => {
  const hub = await startHub(t, (_req, res) => sendJson(res, { error: "x" }, 404));

  const reason = await failureOf(missReader(t, { hubBaseUrl: hub.base }));

  assert.equal(reason, `${MISS_PREFIX}the model was not found on the Hugging Face Hub (HTTP 404)`);
});

test("any other status says the status", async (t) => {
  for (const status of [500, 503, 429]) {
    const hub = await startHub(t, (_req, res) => sendText(res, "nope", status));
    const reason = await failureOf(missReader(t, { hubBaseUrl: hub.base }));
    assert.equal(reason, `${MISS_PREFIX}the Hugging Face Hub answered HTTP ${status}`);
  }
});

test("a Hub that never answers is cut at the time limit and says so", async (t) => {
  const hub = await startHub(t, () => undefined);
  const started = Date.now();

  const reason = await failureOf(missReader(t, { hubBaseUrl: hub.base, hubTimeoutMs: 200 }));
  const elapsed = Date.now() - started;

  assert.equal(reason, `${MISS_PREFIX}the Hugging Face Hub did not answer within 200 ms`);
  assert.ok(elapsed >= 150 && elapsed < 2500, `took ${elapsed} ms`);
});

test("a Hub that sends headers and then stalls the body is cut by the same limit", async (t) => {
  const hub = await startHub(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"max_position_embeddings"');
  });
  const started = Date.now();

  const reason = await failureOf(missReader(t, { hubBaseUrl: hub.base, hubTimeoutMs: 200 }));
  const elapsed = Date.now() - started;

  assert.equal(reason, `${MISS_PREFIX}the Hugging Face Hub did not answer within 200 ms`);
  assert.ok(elapsed >= 150 && elapsed < 2500, `took ${elapsed} ms`);
});

test("the Hub time limit is 3000 ms", () => {
  assert.equal(HUB_TIMEOUT_MS, 3000);
});

test("a body larger than 2 MiB, sent in chunks, is refused", async (t) => {
  const hub = await startHub(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    for (let i = 0; i < 40; i++) res.write(chunk);
    res.end();
  });

  const reason = await failureOf(missReader(t, { hubBaseUrl: hub.base }));

  assert.equal(reason, "config.json is larger than 2 MiB");
});

test("a declared content-length above the cap is refused before the body is read", async (t) => {
  const hub = await startHub(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": String(MAX_CONFIG_BYTES + 1) });
    res.flushHeaders();
  });

  const reason = await failureOf(missReader(t, { hubBaseUrl: hub.base }));

  assert.equal(reason, "config.json is larger than 2 MiB");
});

test("a body that is not JSON, and one that is JSON but not an object, give the cache branch's reasons", async (t) => {
  const notJson = await startHub(t, (_req, res) => sendText(res, "<html>not json"));
  const notObject = await startHub(t, (_req, res) => sendText(res, "[1, 2, 3]"));

  assert.equal(await failureOf(missReader(t, { hubBaseUrl: notJson.base })), "config.json is not valid JSON");
  assert.equal(await failureOf(missReader(t, { hubBaseUrl: notObject.base })), "config.json is not a JSON object");
});

test("a Hub nobody listens at is reported as unreachable", async (t) => {
  const port = await unusedPort();

  const reason = await failureOf(missReader(t, { hubBaseUrl: `http://127.0.0.1:${port}` }));

  assert.equal(reason, `${MISS_PREFIX}the Hugging Face Hub could not be reached`);
});

test("HF_HUB_OFFLINE set to 1, true, yes or on in any case skips the Hub and says so", async (t) => {
  const hub = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 1 }));

  for (const value of ["1", "true", "TRUE", "yes", "ON", " 1 "]) {
    const reason = await failureOf(missReader(t, { hubBaseUrl: hub.base, env: { HF_HUB_OFFLINE: value } }));
    assert.ok(reason.startsWith(MISS_PREFIX) && reason.includes("HF_HUB_OFFLINE"), `${JSON.stringify(value)}: ${reason}`);
  }

  assert.equal(hub.seen.length, 0);
});

test("HF_HUB_OFFLINE set to 0, false or nothing does not skip the Hub", async (t) => {
  const hub = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 1 }));

  for (const value of ["0", "false", ""]) {
    const read = await missReader(t, { hubBaseUrl: hub.base, env: { HF_HUB_OFFLINE: value } })("org/name", { hub: true });
    assert.ok(read.ok, JSON.stringify(value));
  }

  assert.equal(hub.seen.length, 3);
});

test("a same-origin redirect is followed and keeps the Authorization header", async (t) => {
  const hub = await startHub(t, (req, res) => {
    if (req.url === CONFIG_PATH) {
      res.writeHead(307, { location: "/org/name/resolve/main/moved.json" });
      res.end();
    } else {
      sendJson(res, { max_position_embeddings: 8192 });
    }
  });

  const read = await missReader(t, { hubBaseUrl: hub.base, env: { HF_TOKEN: "tok" } })("org/name", { hub: true });

  assert.ok(read.ok);
  assert.equal(contextWindowOf(read.config), 8192);
  assert.deepEqual(
    hub.seen.map((seen) => [seen.url, seen.authorization]),
    [
      [CONFIG_PATH, "Bearer tok"],
      ["/org/name/resolve/main/moved.json", "Bearer tok"],
    ],
  );
});

test("a redirect to another origin is followed without the Authorization header", async (t) => {
  const second = await startHub(t, (_req, res) => sendJson(res, { max_position_embeddings: 16384 }));
  const first = await startHub(t, (_req, res) => {
    res.writeHead(302, { location: `${second.base}/cdn/config.json` });
    res.end();
  });

  const read = await missReader(t, { hubBaseUrl: first.base, env: { HF_TOKEN: "tok" } })("org/name", { hub: true });

  assert.ok(read.ok);
  assert.equal(contextWindowOf(read.config), 16384);
  assert.equal(first.seen[0]?.authorization, "Bearer tok", "the Hub itself saw the token");
  assert.equal(second.seen.length, 1);
  assert.equal(second.seen[0]?.url, "/cdn/config.json");
  assert.equal(second.seen[0]?.authorization, undefined, "the other origin saw no token");
});

test("a chain of more than 3 redirects fails", async (t) => {
  const hub = await startHub(t, (_req, res, self) => {
    res.writeHead(302, { location: `${CONFIG_PATH}?hop=${self.seen.length}` });
    res.end();
  });

  const reason = await failureOf(missReader(t, { hubBaseUrl: hub.base }));

  assert.equal(reason, `${MISS_PREFIX}the Hugging Face Hub redirected too many times`);
  assert.equal(hub.seen.length, 4, "the first request and 3 followed redirects");
});

test("a redirect from https to http, to another scheme, or without a location is refused", async (t) => {
  for (const location of ["http://hub.example.test/config.json", "ftp://hub.example.test/config.json", null]) {
    const stub = fetchStub(redirectResponse(location));
    const reason = await failureOf(missReader(t, { fetch: stub.fetch }));
    assert.equal(reason, `${MISS_PREFIX}the Hugging Face Hub sent a redirect that was refused`, String(location));
    assert.equal(stub.calls.length, 1, `${location} is not requested`);
  }
});

test("hubBaseUrlOf gives the Hub by default and an https HF_ENDPOINT without its trailing slashes", () => {
  assert.equal(hubBaseUrlOf({}), "https://huggingface.co");
  assert.equal(hubBaseUrlOf({ HF_ENDPOINT: "https://mirror.example.test" }), "https://mirror.example.test");
  assert.equal(hubBaseUrlOf({ HF_ENDPOINT: " https://mirror.example.test/ " }), "https://mirror.example.test");
  assert.equal(hubBaseUrlOf({ HF_ENDPOINT: "https://mirror.example.test/hub///" }), "https://mirror.example.test/hub");
});

test("hubBaseUrlOf ignores an endpoint that is not a plain https URL", () => {
  const ignored = [
    "http://mirror.example.test",
    "ftp://mirror.example.test",
    "not a url",
    "https://user:pass@mirror.example.test",
    "https://user@mirror.example.test",
    "https://mirror.example.test?x=1",
    "https://mirror.example.test/?",
    "https://mirror.example.test#frag",
    "https://mirror.example.test/#",
    "   ",
    "",
  ];
  for (const value of ignored) {
    assert.equal(hubBaseUrlOf({ HF_ENDPOINT: value }), "https://huggingface.co", JSON.stringify(value));
  }
  assert.equal(hubBaseUrlOf({ HF_ENDPOINT: undefined }), "https://huggingface.co");
});

test("with no base URL given the Hub's own address is asked, with a signal and no automatic redirect", async (t) => {
  const stub = fetchStub(jsonResponse({ max_position_embeddings: 4096 }));

  const read = await missReader(t, { fetch: stub.fetch })("org/name", { hub: true });

  assert.ok(read.ok);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, "https://huggingface.co/org/name/resolve/main/config.json");
  assert.equal(stub.calls[0]?.init?.method, "GET");
  assert.equal(stub.calls[0]?.init?.redirect, "manual");
  assert.ok(stub.calls[0]?.init?.signal instanceof AbortSignal);
});

test("HF_ENDPOINT is honoured and the token goes to that origin only", async (t) => {
  const stub = fetchStub(redirectResponse("https://elsewhere.example.test/cdn/config.json"), jsonResponse({ max_position_embeddings: 4096 }));
  const env = { HF_ENDPOINT: "https://mirror.example.test/", HF_TOKEN: "tok" };

  const read = await missReader(t, { fetch: stub.fetch, env })("org/name", { hub: true });

  assert.ok(read.ok);
  assert.equal(stub.calls[0]?.url, "https://mirror.example.test/org/name/resolve/main/config.json");
  assert.equal(authorizationOf(stub.calls[0]), "Bearer tok");
  assert.equal(stub.calls[1]?.url, "https://elsewhere.example.test/cdn/config.json");
  assert.equal(authorizationOf(stub.calls[1]), null);
});

test("an id that is not a repository id never reaches fetch, and neither does a local path", async (t) => {
  const stub = fetchStub(jsonResponse({ max_position_embeddings: 4096 }));
  const reader = missReader(t, { fetch: stub.fetch, cwd: tempDir(t) });

  for (const id of ["a/b/c", "org/..", "-x", "", "../x", "./model", join(tempDir(t), "model")]) {
    const read = await reader(id, { hub: true });
    assert.equal(read.ok, false, JSON.stringify(id));
  }

  assert.equal(stub.calls.length, 0);
});

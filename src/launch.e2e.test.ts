import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROVIDER_ID } from "./config.js";
import type { ProbeResult } from "./flagprobe.js";
import { createExtension } from "./index.js";
import { createModelConfigReader, type ReadModelConfig } from "./modelinfo.js";
import { MODEL_PRESETS } from "./presets.js";
import { createMlxServer, createSystemHost, type ServerHost } from "./server.js";
import { SETTINGS } from "./settings.js";
import {
  connectRefused,
  freePort,
  hfFixture,
  makeCtx,
  makeFakePi,
  makeFakeModelConfig,
  readRequests,
  stubArgs,
  writeHfCache,
  type CtxOptions,
} from "./testkit.js";

/**
 * End-to-end proof of the layered-config path: a value written in the global config file reaches the
 * spawned process (a stub that records its argv), the provider registration and the start message on
 * the very next /mlx-start. A real createMlxServer drives a real child; only the installer is faked.
 */

const QWEN = MODEL_PRESETS[3];

type Settings = Record<string, string | undefined>;

/** What the flag probe answers unless a test says otherwise: an install that lists every flag of the schema. */
const ALL_SUPPORTED: ProbeResult = {
  ok: true,
  version: "0.32.2",
  flags: new Set(SETTINGS.flatMap((row) => (row.mlxFlag === undefined ? [] : [row.mlxFlag]))),
};

interface HarnessExtras {
  /** What reads a model's config.json; default is a stand-in, so no test reaches the network or the real cache. */
  readModelConfig?: ReadModelConfig;
  /** The model ids the stand-in discovery reports for the provider's base URL; default is none. */
  discovered?: readonly string[];
  /** A directory to use instead of a new temporary one, so a second instance sees the files of the first (pi closed and reopened). */
  dir?: string;
}

async function harness(
  t: TestContext,
  env: Settings = {},
  ctxOptions: CtxOptions = {},
  probe: ProbeResult = ALL_SUPPORTED,
  extras: HarnessExtras = {},
) {
  const dir = extras.dir ?? mkdtempSync(join(tmpdir(), "pi-mlx-e2e-"));
  const globalConfigPath = join(dir, "data", "config.json");
  const argvFile = join(dir, "argv.json");
  const requestFile = join(dir, "requests.jsonl");

  const base = createSystemHost({
    command: process.execPath,
    buildArgs: stubArgs,
    env: { STUB_MODE: "ok", STUB_ARGV_FILE: argvFile, STUB_REQUEST_FILE: requestFile },
  });
  const children: ChildProcess[] = [];
  const host: ServerHost = {
    ...base,
    spawn: (model, address, extraArgs) => {
      const child = base.spawn(model, address, extraArgs) as ChildProcess;
      children.push(child);
      return child;
    },
  };
  const server = createMlxServer({ host, healthPollMs: 25, warmupPollMs: 25, killWaitMs: 1000 });
  t.after(async () => {
    await server.stop();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  let installCalls = 0;
  const extension = createExtension({
    server,
    ensureInstalled: async () => {
      installCalls += 1;
    },
    discoverModelIds: async () => [...(extras.discovered ?? [])],
    readModelConfig: extras.readModelConfig ?? makeFakeModelConfig().read,
    settings: { env, globalConfigPath, home: dir },
    probeFlags: async () => probe,
    shutdownWaitMs: 1000,
  });
  const fakePi = makeFakePi();
  const fakeCtx = makeCtx(undefined, ctxOptions);
  await extension(fakePi.pi);

  return {
    ...fakePi,
    ...fakeCtx,
    dir,
    /** Every child process the real server spawned, oldest first, so a test can kill one from outside. */
    children,
    globalConfigPath,
    argvFile,
    requestFile,
    /** Every request the stand-in server received so far, oldest first. */
    requests: () => readRequests(requestFile),
    /** What the registered before_provider_request handler answers for a payload of the given provider and model id. */
    runHook(payload: unknown, provider: string = PROVIDER_ID, modelId: string = QWEN.modelId) {
      const hook = fakePi.handlers.get("before_provider_request");
      assert.ok(hook, "the extension registers a before_provider_request handler");
      return hook({ payload }, { model: { provider, id: modelId } });
    },
    /** POST a payload to the stand-in server's chat completions path, under the base URL of the latest launch. */
    async postToServer(port: number, payload: unknown): Promise<number> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      await res.arrayBuffer();
      return res.status;
    },
    shutdown: () => fakePi.handlers.get("session_shutdown")!(),
    get installCalls() {
      return installCalls;
    },
    writeConfig(value: unknown) {
      mkdirSync(dirname(globalConfigPath), { recursive: true });
      writeFileSync(globalConfigPath, JSON.stringify(value));
    },
    /** Write the working directory's own `.pi/pi-mlx-models.json`. */
    writeProject(value: unknown) {
      mkdirSync(join(fakeCtx.ctx.cwd, ".pi"), { recursive: true });
      writeFileSync(join(fakeCtx.ctx.cwd, ".pi", "pi-mlx-models.json"), JSON.stringify(value));
    },
    argv: (): string[] => JSON.parse(readFileSync(argvFile, "utf8")),
    start: (input = "qwen3_4b") => fakePi.commands.get("mlx-start")!(input, fakeCtx.ctx),
    last: (input = "") => fakePi.commands.get("mlx-last")!(input, fakeCtx.ctx),
    status: (input = "") => fakePi.commands.get("mlx-status")!(input, fakeCtx.ctx),
    restart: (input = "") => fakePi.commands.get("mlx-restart")!(input, fakeCtx.ctx),
    stop: () => fakePi.commands.get("mlx-stop")!("", fakeCtx.ctx),
  };
}

const startNotes = (notes: Array<{ message: string; type: string }>) =>
  notes.filter((n) => n.message.startsWith("Starting MLX server with"));
const lastBaseUrl = (calls: Array<{ config: any }>) => calls.at(-1)?.config.baseUrl;
/** A fetch that rejects: a real reader given this can reach no host, whatever it tries. */
const noNetwork = (async () => {
  throw new Error("network down");
}) as unknown as typeof fetch;

test("a model whose config.json is in the cache is registered with that file's context window", { timeout: 30_000 }, async (t) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "pi-mlx-hf-"));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  // The real layout: refs/main, a blob, and snapshots/<revision>/config.json as a symlink to the blob.
  writeHfCache(cacheRoot, QWEN.modelId, hfFixture("qwen3-4b-instruct-2507-4bit"));
  const h = await harness(t, {}, {}, ALL_SUPPORTED, {
    readModelConfig: createModelConfigReader({ cacheRoot, fetch: noNetwork, env: {} }),
  });

  await h.start();

  const models = h.providerCalls.at(-1)?.config.models;
  assert.equal(models.length, 1);
  assert.equal(models[0].id, QWEN.modelId);
  assert.equal(models[0].contextWindow, 262144);
  assert.equal(models[0].maxTokens, 8192);
  assert.equal(models[0].reasoning, false);
  assert.deepEqual(models[0].input, ["text"]);
  await h.stop();
});

test("a model with no config.json in the cache still starts, registered with the fallback window", { timeout: 30_000 }, async (t) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "pi-mlx-hf-"));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  const h = await harness(t, {}, {}, ALL_SUPPORTED, {
    readModelConfig: createModelConfigReader({ cacheRoot, fetch: noNetwork, env: {} }),
  });

  await h.start();

  assert.equal(h.notes.filter((n) => n.type === "error").length, 0);
  assert.ok(h.notes.some((n) => n.message.startsWith("MLX server is ready for prompts. Use /model and pick pi-mlx-models/")));
  const models = h.providerCalls.at(-1)?.config.models;
  assert.equal(models.length, 1);
  assert.equal(models[0].contextWindow, 32768);
  await h.stop();
});

test("an unreadable config.json through the real reader gives the fallback window and exactly one warning, and the start succeeds", { timeout: 30_000 }, async (t) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "pi-mlx-hf-"));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  // An empty cache and a fetch that rejects: nothing can answer, whatever the reader tries.
  const h = await harness(t, {}, {}, ALL_SUPPORTED, {
    readModelConfig: createModelConfigReader({ cacheRoot, fetch: noNetwork, env: {} }),
  });

  await h.start();

  assert.equal(h.notes.filter((n) => n.type === "error").length, 0);
  assert.ok(h.notes.some((n) => n.message.startsWith("MLX server is ready for prompts. Use /model and pick pi-mlx-models/")));
  assert.equal(h.providerCalls.at(-1)?.config.models[0].contextWindow, 32768);
  const warned = h.notes.filter((n) => n.type === "warning" && n.message.startsWith("context window unavailable for "));
  assert.equal(warned.length, 1);
  assert.match(warned[0].message, /^context window unavailable for \S+ \(.+\); using 32768$/);
  await h.stop();
});

const R1_DISTILL = MODEL_PRESETS[0];

test("starting the DeepSeek-R1 distill preset registers a reasoning model with the compat flags and a 32768 output limit", { timeout: 30_000 }, async (t) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "pi-mlx-hf-"));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  writeHfCache(cacheRoot, R1_DISTILL.modelId, hfFixture("deepseek-r1-distill-qwen-1.5b-4bit"));
  const h = await harness(t, {}, {}, ALL_SUPPORTED, {
    readModelConfig: createModelConfigReader({ cacheRoot, fetch: noNetwork, env: {} }),
  });

  await h.start("deepseek_r1_1_5b");

  const models = h.providerCalls.at(-1)?.config.models;
  assert.equal(models.length, 1);
  assert.equal(models[0].id, R1_DISTILL.modelId);
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].contextWindow, 131072);
  assert.equal(models[0].maxTokens, 32768);
  assert.deepEqual(models[0].input, ["text"]);
  assert.deepEqual(models[0].compat, { supportsDeveloperRole: false, supportsReasoningEffort: false });
  const line = h.notes.find((n) => n.message.startsWith("model: "));
  assert.ok(line, "the start shows a model line");
  assert.ok(line.message.includes("max output 32768 (default)"), line.message);
  assert.ok(line.message.includes("reasoning yes (preset)"), line.message);
  await h.stop();
});

test("starting the Qwen3 preset registers a plain text-only model with 8192 and no compat property", { timeout: 30_000 }, async (t) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "pi-mlx-hf-"));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  writeHfCache(cacheRoot, QWEN.modelId, hfFixture("qwen3-4b-instruct-2507-4bit"));
  const h = await harness(t, {}, {}, ALL_SUPPORTED, {
    readModelConfig: createModelConfigReader({ cacheRoot, fetch: noNetwork, env: {} }),
  });

  await h.start("qwen3_4b");

  const models = h.providerCalls.at(-1)?.config.models;
  assert.equal(models.length, 1);
  assert.equal(models[0].reasoning, false);
  assert.equal(models[0].maxTokens, 8192);
  assert.deepEqual(models[0].input, ["text"]);
  assert.equal("compat" in models[0], false);
  const line = h.notes.find((n) => n.message.startsWith("model: "));
  assert.ok(line, "the start shows a model line");
  assert.ok(line.message.includes("reasoning no (preset)"), line.message);
  await h.stop();
});

const KAT_CODER_ID = "mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit";

test("a KAT-Coder profile with limits.reasoning and limits.maxTokens registers a reasoning model with that output limit, and the server gets no --max-tokens", { timeout: 30_000 }, async (t) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "pi-mlx-hf-"));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  writeHfCache(cacheRoot, KAT_CODER_ID, hfFixture("kat-coder-v2.5-dev-optiq-4bit"));
  const port = await freePort();
  const h = await harness(t, {}, {}, ALL_SUPPORTED, {
    readModelConfig: createModelConfigReader({ cacheRoot, fetch: noNetwork, env: {} }),
  });
  h.writeConfig({
    server: { port },
    models: {
      [KAT_CODER_ID]: {
        profiles: { think: { limits: { reasoning: true, maxTokens: 16384 }, chatTemplateArgs: { enable_thinking: true } } },
      },
    },
  });

  await h.start(`${KAT_CODER_ID} --profile think`);

  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  assert.ok(h.notes.some((n) => n.message.startsWith("MLX server is ready for prompts. Use /model and pick pi-mlx-models/")));
  const models = h.providerCalls.at(-1)?.config.models;
  assert.equal(models.length, 1);
  assert.equal(models[0].id, KAT_CODER_ID);
  assert.equal(models[0].contextWindow, 262144);
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].maxTokens, 16384);
  assert.deepEqual(models[0].input, ["text"]);
  assert.deepEqual(models[0].compat, { supportsDeveloperRole: false, supportsReasoningEffort: false });
  const line = h.notes.find((n) => n.message.startsWith("model: "));
  assert.ok(line, "the start shows a model line");
  assert.ok(line.message.includes("max output 16384 (profile think)"), line.message);
  assert.ok(line.message.includes("reasoning yes (profile think)"), line.message);
  assert.ok(line.message.includes("context 262144 (config.json)"), line.message);
  const argv = h.argv();
  assert.ok(argv.includes('--chat-template-args={"enable_thinking":true}'), JSON.stringify(argv));
  assert.equal(argv.some((arg) => arg.startsWith("--max-tokens")), false, JSON.stringify(argv));
  const payload = { model: KAT_CODER_ID, messages: [{ role: "user", content: "hi" }], max_completion_tokens: 8192 };
  const rewritten = (await h.runHook(payload, PROVIDER_ID, KAT_CODER_ID)) as Record<string, unknown>;
  assert.equal(rewritten.max_completion_tokens, 8192);
  await h.stop();
});

test("a port and log level in the global file reach the process, the provider and the start message",{ timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port, logLevel: "DEBUG" } });

  await h.start();

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--log-level=DEBUG"]);
  assert.equal(lastBaseUrl(h.providerCalls), `http://127.0.0.1:${port}/v1`);
  const starting = startNotes(h.notes);
  assert.equal(starting.length, 1);
  assert.equal(
    starting[0].message,
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --port ${port} (global file), --log-level DEBUG (global file)`,
  );

  await h.stop();
  assert.equal(await connectRefused(port), true, "stop must wait on the launch's own port");
});

test("editing the global file changes the next start with no reload step", { timeout: 30_000 }, async (t) => {
  const first = await freePort();
  let second = await freePort();
  while (second === first) second = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port: first, logLevel: "DEBUG" } });
  await h.start();
  assert.deepEqual(h.argv().slice(-3), ["--port", String(first), "--log-level=DEBUG"]);

  h.writeConfig({ server: { port: second, logLevel: "INFO" } });
  await h.start();

  assert.deepEqual(h.argv().slice(-3), ["--port", String(second), "--log-level=INFO"]);
  assert.equal(lastBaseUrl(h.providerCalls), `http://127.0.0.1:${second}/v1`);
  assert.equal(await connectRefused(first), true, "the first server was replaced");
});

test("an env var beats the file and still works alone", { timeout: 30_000 }, async (t) => {
  const fromFile = await freePort();
  let fromEnv = await freePort();
  while (fromEnv === fromFile) fromEnv = await freePort();

  const both = await harness(t, { PI_MLX_MODELS_PORT: String(fromEnv) });
  both.writeConfig({ server: { port: fromFile } });
  await both.start();
  assert.deepEqual(both.argv().slice(-2), ["--port", String(fromEnv)]);
  assert.equal(lastBaseUrl(both.providerCalls), `http://127.0.0.1:${fromEnv}/v1`);
  assert.match(startNotes(both.notes)[0].message, new RegExp(`\\nflags: --port ${fromEnv} \\(env PI_MLX_MODELS_PORT\\)$`));
  await both.stop();

  const alone = await harness(t, { PI_MLX_MODELS_PORT: String(fromEnv) });
  await alone.start();
  assert.deepEqual(alone.argv().slice(-2), ["--port", String(fromEnv)]);
  assert.match(startNotes(alone.notes)[0].message, new RegExp(`\\nflags: --port ${fromEnv} \\(env PI_MLX_MODELS_PORT\\)$`));
});

test("an invalid value in the global file stops the start before any side effect", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  h.writeConfig({ server: { port: 99999, logLevel: "debug" } });

  await h.start();

  const errors = h.notes.filter((n) => n.type === "error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.startsWith("mlx-start failed: invalid configuration"), errors[0].message);
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
  assert.equal(h.providerCalls.length, 1, "only the initial provider registration");
});

test("a missing global file is simply absent and is never created", { timeout: 30_000 }, async (t) => {
  // The port comes from env only so that no test ever binds the default port 8080.
  const port = await freePort();
  const h = await harness(t, { PI_MLX_MODELS_PORT: String(port) });

  await h.start();

  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port)]);
  assert.equal(existsSync(h.globalConfigPath), false);
  // The data directory now exists because a successful start remembers itself there (plan 06-06); the config file stays absent
  // and the record is the only thing the extension put in the directory.
  assert.deepEqual(readdirSync(dirname(h.globalConfigPath)), ["last-launch.json"]);
});

test("flags typed on /mlx-start reach the process, and the next start without them is back to the file and defaults", { timeout: 30_000 }, async (t) => {
  const typed = await freePort();
  let fromFile = await freePort();
  while (fromFile === typed) fromFile = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port: fromFile } });

  await h.start(`qwen3_4b --port ${typed} --log-level DEBUG --allowed-origins http://a.test,http://b.test`);

  assert.deepEqual(h.argv(), [
    "--model",
    QWEN.modelId,
    "--host",
    "127.0.0.1",
    "--port",
    String(typed),
    "--allowed-origins=http://a.test,http://b.test",
    "--log-level=DEBUG",
  ]);
  assert.equal(lastBaseUrl(h.providerCalls), `http://127.0.0.1:${typed}/v1`);
  assert.equal(
    startNotes(h.notes)[0].message,
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --port ${typed} (/mlx-start), --allowed-origins http://a.test,http://b.test (/mlx-start), --log-level DEBUG (/mlx-start)`,
  );

  await h.start();

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(fromFile)]);
  assert.equal(lastBaseUrl(h.providerCalls), `http://127.0.0.1:${fromFile}/v1`);
  assert.equal(await connectRefused(typed), true, "the first server was replaced");
});

test("a pi flag reaches the process, and a command-line flag beats it", { timeout: 30_000 }, async (t) => {
  const fromPi = await freePort();
  let typed = await freePort();
  while (typed === fromPi) typed = await freePort();
  const h = await harness(t);
  h.setFlag("mlx-port", String(fromPi));
  h.setFlag("mlx-log-level", "DEBUG");

  await h.start();
  assert.deepEqual(h.argv().slice(-3), ["--port", String(fromPi), "--log-level=DEBUG"]);
  assert.match(startNotes(h.notes)[0].message, /\nflags: --port \d+ \(pi flag --mlx-port\), --log-level DEBUG \(pi flag --mlx-log-level\)$/);

  await h.start(`qwen3_4b --port ${typed}`);
  assert.deepEqual(h.argv().slice(-3), ["--port", String(typed), "--log-level=DEBUG"]);
  assert.equal(lastBaseUrl(h.providerCalls), `http://127.0.0.1:${typed}/v1`);
});

test("a refused command line spawns nothing", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);

  await h.start("qwen3_4b --port abc");
  await h.start("--bogus");

  const errors = h.notes.filter((n) => n.type === "error");
  assert.equal(errors.length, 2);
  assert.ok(errors[0].message.startsWith("mlx-start failed: invalid configuration"), errors[0].message);
  assert.ok(errors[1].message.startsWith("mlx-start failed: unknown flag --bogus"), errors[1].message);
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
});

// ---- the project file layer and the trust boundary (plan 02-05: CFG-01, CFG-06) ----

/** An env that puts the stub on a free port, so no test ever binds the default port 8080. */
const onFreePort = async (): Promise<{ env: Settings; port: number }> => {
  const port = await freePort();
  return { env: { PI_MLX_MODELS_PORT: String(port) }, port };
};

test("a project file in the working directory beats the global file, and the flags line says so", { timeout: 30_000 }, async (t) => {
  const { env, port } = await onFreePort();
  const h = await harness(t, env);
  h.writeConfig({ server: { logLevel: "INFO" } });
  h.writeProject({ server: { logLevel: "DEBUG" } });

  await h.start();

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--log-level=DEBUG"]);
  assert.match(startNotes(h.notes)[0].message, /\nflags: --port \d+ \(env PI_MLX_MODELS_PORT\), --log-level DEBUG \(project file\)$/);
  assert.equal(h.confirms.length, 0);
});

test("a project file that turns on trustRemoteCode spawns nothing, installs nothing and asks nothing", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const h = await harness(t, env);
  h.writeProject({ server: { trustRemoteCode: true } });

  await h.start();

  const errors = h.notes.filter((n) => n.type === "error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes("server.trustRemoteCode: lets the model repository run Python code"), errors[0].message);
  assert.ok(errors[0].message.includes(".pi/pi-mlx-models.json"), errors[0].message);
  assert.ok(errors[0].message.endsWith(`Move them to ${h.globalConfigPath}; starting then asks for confirmation.`), errors[0].message);
  assert.equal(h.confirms.length, 0, "no prompt can override a project file");
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
  assert.equal(h.providerCalls.length, 1, "only the initial provider registration");
});

test("a project file with a wildcard host or a remote base URL spawns nothing either", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const h = await harness(t, env);

  h.writeProject({ server: { host: "0.0.0.0" } });
  await h.start();
  h.writeProject({ baseUrl: "http://example.test:8080/v1" });
  await h.start();

  const errors = h.notes.filter((n) => n.type === "error");
  assert.equal(errors.length, 2);
  assert.ok(errors[0].message.includes("server.host (0.0.0.0): listens on a non-loopback address"), errors[0].message);
  assert.ok(errors[1].message.includes("baseUrl (http://example.test:8080/v1): sends prompts to a non-loopback address"), errors[1].message);
  assert.equal(h.confirms.length, 0);
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
});

test("trustRemoteCode in the global file asks on every start and reaches the process only when confirmed", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const h = await harness(t, env);
  h.writeConfig({ server: { trustRemoteCode: true } });

  await h.start();

  assert.equal(h.argv().at(-1), "--trust-remote-code");
  assert.deepEqual(h.argv().slice(0, 2), ["--model", QWEN.modelId]);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].title, "Allow remote code from the model repository?");
  assert.ok(h.confirms[0].message.startsWith("--trust-remote-code (from global file) lets the model repository run Python code"));
  assert.ok(
    h.confirms[0].message.endsWith("\n\nYes allows this. No or Esc cancels. Check which option is highlighted before pressing Enter."),
    h.confirms[0].message,
  );
  assert.match(startNotes(h.notes)[0].message, /\nflags: .*--trust-remote-code \(global file\)$/);

  await h.start();

  assert.equal(h.confirms.length, 2, "nothing is remembered: the next start asks again");
  assert.equal(h.argv().at(-1), "--trust-remote-code");
});

test("declining the dialog spawns nothing and says the start was cancelled", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const h = await harness(t, env, { confirm: false });
  h.writeConfig({ server: { trustRemoteCode: true } });

  await h.start();

  assert.equal(h.confirms.length, 1);
  assert.deepEqual(h.notes, [{ type: "info", message: "mlx-start cancelled: --trust-remote-code was not confirmed." }]);
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
  assert.equal(h.providerCalls.length, 1, "only the initial provider registration");
});

test("without a UI a risky start is refused and spawns nothing", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const h = await harness(t, env, { hasUI: false });

  await h.start("qwen3_4b --trust-remote-code");

  assert.deepEqual(h.notes, [
    {
      type: "error",
      message: "mlx-start failed: --trust-remote-code needs interactive confirmation; run /mlx-start in an interactive pi session",
    },
  ]);
  assert.equal(h.confirms.length, 0);
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
});

// ---- the model options and the models block (plan 02-06: SRV-02, CFG-01) ----

test("every connection and model key in the global file produces exactly those flags on the spawned process", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  const template = join(dirname(h.globalConfigPath), "template.jinja");
  h.writeConfig({
    server: { port, allowedOrigins: ["http://a.test", "http://b.test"], logLevel: "DEBUG" },
    model: {
      adapterPath: "/tmp/adapters/x",
      draftModel: "mlx-community/draft",
      numDraftTokens: 4,
      chatTemplate: template,
      useDefaultChatTemplate: true,
      chatTemplateArgs: { enable_thinking: false },
    },
  });
  writeFileSync(template, "{{ messages }}\n");

  await h.start();

  const expected = [
    "--model",
    QWEN.modelId,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--allowed-origins=http://a.test,http://b.test",
    "--log-level=DEBUG",
    "--adapter-path=/tmp/adapters/x",
    "--draft-model=mlx-community/draft",
    "--num-draft-tokens=4",
    "--chat-template={{ messages }}\n",
    "--use-default-chat-template",
    '--chat-template-args={"enable_thinking":false}',
  ];
  assert.deepEqual(h.argv(), expected);
  const flagsLine = startNotes(h.notes)[0].message.split("\n")[1];
  assert.ok(flagsLine.includes(`--chat-template ${template} (global file)`), flagsLine);
  assert.ok(!flagsLine.includes("{{ messages }}"), "the template text is not shown");

  await h.stop();
  assert.equal(await connectRefused(port), true);

  // A project file's model option changes only its own element.
  h.writeProject({ model: { numDraftTokens: 2 } });
  await h.start();
  assert.deepEqual(h.argv(), expected.map((arg) => (arg === "--num-draft-tokens=4" ? "--num-draft-tokens=2" : arg)));
  await h.stop();

  // A typed flag beats the project file.
  await h.start("qwen3_4b --num-draft-tokens 6");
  assert.deepEqual(h.argv(), expected.map((arg) => (arg === "--num-draft-tokens=4" ? "--num-draft-tokens=6" : arg)));
  assert.match(startNotes(h.notes)[2].message, /--num-draft-tokens 6 \(\/mlx-start\)/);

  await h.stop();
  assert.equal(await connectRefused(port), true, "the stub is stopped");
});

test("a models entry reaches only its own model on a real spawn", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const h = await harness(t, env);
  h.writeConfig({ model: { numDraftTokens: 3 }, models: { qwen3_4b: { draftModel: "q-draft" } } });

  await h.start("qwen3_4b");
  assert.deepEqual(h.argv().slice(-2), ["--draft-model=q-draft", "--num-draft-tokens=3"]);
  await h.stop();

  await h.start("llama3_2_3b");
  assert.deepEqual(h.argv().slice(-1), ["--num-draft-tokens=3"]);
  assert.ok(!h.argv().some((arg) => arg.startsWith("--draft-model")));
  assert.deepEqual(h.argv().slice(0, 2), ["--model", MODEL_PRESETS.find((p) => p.key === "llama3_2_3b")!.modelId]);
});

test("chat template arguments typed as a JSON string merge over the file and reach the process as one element", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const h = await harness(t, env);
  h.writeConfig({ model: { chatTemplateArgs: { enable_thinking: true, keep: 1 } } });

  await h.start(`qwen3_4b --chat-template-args '{"enable_thinking": false}'`);

  assert.equal(h.argv().at(-1), '--chat-template-args={"enable_thinking":false,"keep":1}');
});

test("a missing chat template file spawns nothing and installs nothing", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const h = await harness(t, env);
  const missing = join(dirname(h.globalConfigPath), "missing.jinja");
  h.writeConfig({ model: { chatTemplate: missing } });

  await h.start();

  const failures = h.notes.filter((n) => n.type === "error");
  assert.equal(failures.length, 1);
  assert.equal(
    failures[0].message,
    `mlx-start failed: invalid configuration\n  model.chatTemplate (global config.json): cannot read ${missing}: cannot be read (ENOENT)`,
  );
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
  assert.equal(h.providerCalls.length, 1, "only the initial provider registration");
});

test("an older mlx-lm skips the flags it cannot do, says so once, and the stub still reaches ready", { timeout: 30_000 }, async (t) => {
  const old: ProbeResult = { ok: true, version: "0.24.0", flags: new Set(["--help", "--model", "--host", "--port", "--log-level"]) };
  const port = await freePort();
  const h = await harness(t, {}, {}, old);
  h.writeConfig({ server: { port, allowedOrigins: ["http://a.test"], logLevel: "DEBUG" } });

  await h.start();

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--log-level=DEBUG"]);
  assert.ok(!h.argv().some((arg) => arg.startsWith("--allowed-origins")), "the skipped flag never reaches the process");
  assert.deepEqual(
    h.notes.filter((n) => n.type === "warning").map((n) => n.message),
    ["Skipped --allowed-origins: not supported by mlx-lm 0.24.0 (run /mlx-init to upgrade)"],
  );
  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  assert.equal(
    startNotes(h.notes)[0].message,
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --port ${port} (global file), --allowed-origins http://a.test (global file, skipped), --log-level DEBUG (global file)`,
  );
  assert.ok(
    h.notes.some((n) => n.type === "info" && n.message.startsWith("MLX server is ready for prompts")),
    "the stub reached ready",
  );

  await h.stop();
  assert.equal(await connectRefused(port), true);
});

// ---- performance flags (SRV-04): a decode concurrency reaches the spawned argv ----

test("a decode concurrency in the global file reaches the process and the flags line", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port, decodeConcurrency: 4 } });

  await h.start();

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--decode-concurrency=4"]);
  const starting = startNotes(h.notes);
  assert.equal(starting.length, 1);
  assert.equal(
    starting[0].message,
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --port ${port} (global file), --decode-concurrency 4 (global file)`,
  );

  await h.stop();
  assert.equal(await connectRefused(port), true, "stop must wait on the launch's own port");
});

test("a decode concurrency typed on /mlx-start is for that launch only", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port, decodeConcurrency: 4 } });

  await h.start("qwen3_4b --decode-concurrency 2");

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--decode-concurrency=2"]);
  assert.match(startNotes(h.notes)[0].message, /--decode-concurrency 2 \(\/mlx-start\)$/);

  await h.stop();
  await h.start("qwen3_4b");

  assert.equal(h.argv().at(-1), "--decode-concurrency=4");
  assert.match(startNotes(h.notes).at(-1)!.message, /--decode-concurrency 4 \(global file\)$/);
});

test("a decode concurrency of 0 in the global file stops the start before any side effect", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  h.writeConfig({ server: { decodeConcurrency: 0 } });

  await h.start();

  const errors = h.notes.filter((n) => n.type === "error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.startsWith("mlx-start failed: invalid configuration"), errors[0].message);
  assert.ok(
    errors[0].message.includes(`server.decodeConcurrency (global config.json): 0 is not an integer of at least 1 (flag --decode-concurrency)`),
    errors[0].message,
  );
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
});

// ---- KV quantization (SRV-05): kvBits reaches the argv and every launch says batching is off ----

test("kvBits in the global file reaches the process and the flags line, with one batching warning", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port, kvBits: 4 } });

  await h.start();

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--kv-bits=4"]);
  const starting = startNotes(h.notes);
  assert.equal(starting.length, 1);
  assert.match(starting[0].message, /--kv-bits 4 \(global file\)$/);
  const warnings = h.notes.filter((n) => n.type === "warning");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].message.includes("Disables batching, so requests are served one at a time."), warnings[0].message);

  await h.stop();
  assert.equal(await connectRefused(port), true, "stop must wait on the launch's own port");
});

test("all three KV flags typed on /mlx-start reach the process in schema order, each labelled with the command", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port } });

  await h.start("qwen3_4b --quantized-kv-start 0 --kv-group-size 32 --kv-bits 4");

  assert.deepEqual(h.argv().slice(-3), ["--kv-bits=4", "--kv-group-size=32", "--quantized-kv-start=0"]);
  assert.equal(
    startNotes(h.notes)[0].message,
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --port ${port} (global file), --kv-bits 4 (/mlx-start), --kv-group-size 32 (/mlx-start), --quantized-kv-start 0 (/mlx-start)`,
  );
  assert.equal(h.notes.filter((n) => n.type === "warning").length, 1);
});

// ---- sampling to the server (SRV-03): a temperature in the sampling object reaches the argv and the flags line ----

test("a temperature in the sampling object of the global file reaches the process and the flags line", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port }, model: { sampling: { temperature: 0.2 } } });

  await h.start();

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--temp=0.2"]);
  const starting = startNotes(h.notes);
  assert.equal(starting.length, 1);
  assert.equal(
    starting[0].message,
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --port ${port} (global file), --temp 0.2 (global file)`,
  );

  await h.stop();
  assert.equal(await connectRefused(port), true, "stop must wait on the launch's own port");
});

test("a negative temperature in the global file stops the start before any side effect", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  h.writeConfig({ model: { sampling: { temperature: -1 } } });

  await h.start();

  const errors = h.notes.filter((n) => n.type === "error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.startsWith("mlx-start failed: invalid configuration"), errors[0].message);
  assert.ok(
    errors[0].message.includes("model.sampling.temperature (global config.json): -1 is not a number of at least 0 (OpenAI field temperature, flag --temp)"),
    errors[0].message,
  );
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
});

test("a project file's max tokens beats a global models entry, and the flags line says so", { timeout: 30_000 }, async (t) => {
  const { env, port } = await onFreePort();
  const h = await harness(t, env);
  h.writeConfig({ models: { qwen3_4b: { sampling: { maxTokens: 256 } } } });
  h.writeProject({ model: { sampling: { maxTokens: 512 } } });

  await h.start();

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--max-tokens=512"]);
  assert.match(startNotes(h.notes)[0].message, /\nflags: --port \d+ \(env PI_MLX_MODELS_PORT\), --max-tokens 512 \(project file\)$/);
  assert.equal(h.confirms.length, 0, "sampling in a project file needs no confirmation (D-04)");
  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
});

// ---- sampling and template arguments to the request (GEN-01, GEN-02): the registered before_provider_request hook ----

/** A request payload shaped like the one pi builds for this provider's launched model. */
const piPayload = (model: string) => ({
  model,
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  temperature: 0.9,
  max_completion_tokens: 8192,
  reasoning_effort: "high",
  chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
});

const hookOf = (h: { handlers: Map<string, (event?: any, ctx?: any) => unknown> }) => {
  const hook = h.handlers.get("before_provider_request");
  assert.ok(hook, "the extension registers a before_provider_request handler");
  return hook;
};

const REQUEST_CONFIG = (port: number) => ({
  server: { port },
  model: { sampling: { temperature: 0.2 }, chatTemplateArgs: { enable_thinking: false } },
});

test("after /mlx-start the hook rewrites a pi payload: configured temperature, one template source, the rest as pi sent it", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(REQUEST_CONFIG(port));
  await h.start();
  const payload = piPayload(QWEN.modelId);
  const before = structuredClone(payload);

  const result = (await hookOf(h)({ payload }, { model: { provider: PROVIDER_ID, id: QWEN.modelId } })) as Record<string, unknown>;

  assert.ok(result !== undefined && result !== payload, "a new object, not pi's");
  assert.equal(result.temperature, 0.2);
  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: false });
  assert.equal("reasoning_effort" in result, false);
  assert.equal(result.model, payload.model);
  assert.deepEqual(result.messages, payload.messages);
  assert.equal(result.stream, true);
  assert.equal(result.max_completion_tokens, 8192);
  assert.deepEqual(payload, before, "pi's payload object was not mutated");
});

test("the hook leaves a request for another provider untouched", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(REQUEST_CONFIG(port));
  await h.start();

  const result = await hookOf(h)({ payload: piPayload(QWEN.modelId) }, { model: { provider: "openai", id: QWEN.modelId } });

  assert.equal(result, undefined);
});

test("the hook leaves a request for another model id untouched", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(REQUEST_CONFIG(port));
  await h.start();

  const result = await hookOf(h)(
    { payload: piPayload("some/other-model") },
    { model: { provider: PROVIDER_ID, id: "some/other-model" } },
  );

  assert.equal(result, undefined);
});

test("before any /mlx-start in the session the hook leaves every request untouched", { timeout: 30_000 }, async (t) => {
  const { env, port } = await onFreePort();
  const h = await harness(t, env);
  h.writeConfig(REQUEST_CONFIG(port));

  const result = await hookOf(h)({ payload: piPayload(QWEN.modelId) }, { model: { provider: PROVIDER_ID, id: QWEN.modelId } });

  assert.equal(result, undefined);
});

test("the hook never throws: a hostile payload, a missing ctx.model and a missing event all return undefined", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(REQUEST_CONFIG(port));
  await h.start();
  const hook = hookOf(h);
  const ctx = { model: { provider: PROVIDER_ID, id: QWEN.modelId } };
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("hostile");
      },
      get() {
        throw new Error("hostile");
      },
    },
  );

  assert.equal(await hook({ payload: hostile }, ctx), undefined);
  assert.equal(await hook({ payload: null }, ctx), undefined);
  assert.equal(await hook({ payload: "x" }, ctx), undefined);
  assert.equal(await hook(undefined, ctx), undefined);
  assert.equal(await hook({ payload: piPayload(QWEN.modelId) }, {}), undefined, "no ctx.model: nothing is applied");
  assert.equal(await hook({ payload: piPayload(QWEN.modelId) }, undefined), undefined);
});

// ---- what the stand-in server receives (GEN-01, GEN-02, roadmap criterion 3): the hook's output posted to a real child ----

const LAUNCH_CONFIG = (port: number, temperature = 0.2) => ({
  server: { port, logLevel: "DEBUG" },
  model: {
    sampling: { temperature, maxTokens: 2048, seed: 7, stop: ["###"] },
    chatTemplateArgs: { enable_thinking: false },
  },
});

test("the stand-in server receives the configured values and the one template source for the launched model", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(LAUNCH_CONFIG(port));
  await h.start();
  const payload = piPayload(QWEN.modelId);

  const rewritten = await h.runHook(payload);
  assert.equal(await h.postToServer(port, rewritten), 200);

  const received = h.requests().at(-1);
  assert.equal(received?.url, "/v1/chat/completions");
  assert.deepEqual(received?.body, {
    model: QWEN.modelId,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    temperature: 0.2,
    max_completion_tokens: 2048,
    seed: 7,
    stop: ["###"],
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.deepEqual((received?.body as Record<string, unknown>).chat_template_kwargs, { enable_thinking: false });
});

test("a request for another provider reaches the stand-in server exactly as pi built it", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(LAUNCH_CONFIG(port));
  await h.start();
  const payload = piPayload(QWEN.modelId);

  const result = await h.runHook(payload, "openai");
  assert.equal(result, undefined);
  assert.equal(await h.postToServer(port, payload), 200);

  assert.deepEqual(h.requests().at(-1)?.body, payload);
});

test("after /mlx-stop the hook leaves a request for the former model untouched", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(LAUNCH_CONFIG(port));
  await h.start();
  assert.notEqual(await h.runHook(piPayload(QWEN.modelId)), undefined, "applied while the launch lives");

  await h.stop();

  assert.equal(await h.runHook(piPayload(QWEN.modelId)), undefined);
});

test("after session_shutdown the hook leaves a request for the former model untouched", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(LAUNCH_CONFIG(port));
  await h.start();
  assert.notEqual(await h.runHook(piPayload(QWEN.modelId)), undefined, "applied while the launch lives");

  await h.shutdown();

  assert.equal(await h.runHook(piPayload(QWEN.modelId)), undefined);
});

test("editing or deleting the config after the start changes nothing until the next start (D-12)", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(LAUNCH_CONFIG(port, 0.2));
  await h.start();
  const temperatureOf = async () => ((await h.runHook(piPayload(QWEN.modelId))) as Record<string, unknown>).temperature;
  assert.equal(await temperatureOf(), 0.2);

  h.writeConfig(LAUNCH_CONFIG(port, 0.9));
  assert.equal(await temperatureOf(), 0.2, "an edited file is not read per request");

  rmSync(h.globalConfigPath);
  assert.equal(await temperatureOf(), 0.2, "a deleted file is not missed per request");
});

test("a second /mlx-start picks up the edited config (D-12)", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(LAUNCH_CONFIG(port, 0.2));
  await h.start();
  h.writeConfig(LAUNCH_CONFIG(port, 0.9));

  await h.start();

  const result = (await h.runHook(piPayload(QWEN.modelId))) as Record<string, unknown>;
  assert.equal(result.temperature, 0.9);
  assert.equal(await h.postToServer(port, result), 200);
  assert.equal((h.requests().at(-1)?.body as Record<string, unknown>).temperature, 0.9);
});

// ---- profiles (CFG-04, SRV-03, GEN-01, GEN-02): a profile picked at start reaches the argv, the start message and the request ----

const PROFILE_CONFIG = (port: number) => ({
  server: { port },
  models: {
    qwen3_4b: {
      profiles: { fast: { sampling: { temperature: 0.2, maxTokens: 2048 }, chatTemplateArgs: { enable_thinking: false } } },
    },
  },
});

test("a profile picked with --profile reaches the spawned argv, the start message and the request the server receives", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(PROFILE_CONFIG(port));

  await h.start("qwen3_4b --profile fast");

  assert.deepEqual(h.argv(), [
    "--model",
    QWEN.modelId,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    '--chat-template-args={"enable_thinking":false}',
    "--temp=0.2",
    "--max-tokens=2048",
  ]);
  const starting = startNotes(h.notes);
  assert.equal(starting.length, 1);
  assert.equal(
    starting[0].message,
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nprofile: fast (/mlx-start)\nflags: --port ${port} (global file), --chat-template-args {"enable_thinking":false} (profile fast), --temp 0.2 (profile fast), --max-tokens 2048 (profile fast)`,
  );

  const rewritten = await h.runHook(piPayload(QWEN.modelId));
  assert.equal(await h.postToServer(port, rewritten), 200);
  const body = h.requests().at(-1)?.body as Record<string, unknown>;
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_completion_tokens, 2048);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test("the profile applies to that launch only: the next start without --profile is back to the file's base", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(PROFILE_CONFIG(port));
  await h.start("qwen3_4b --profile fast");
  await h.stop();

  await h.start("qwen3_4b");

  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port)]);
  const second = startNotes(h.notes)[1];
  assert.equal(second.message, `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --port ${port} (global file)`);
  assert.ok(!second.message.includes("profile:"));
  assert.equal(await h.runHook(piPayload(QWEN.modelId)), undefined);
});

test("an unknown profile name is refused before any install, probe or spawn, naming the available profiles", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(PROFILE_CONFIG(port));

  await h.start("qwen3_4b --profile nope");

  const failures = h.notes.filter((n) => n.type === "error");
  assert.equal(failures.length, 1);
  assert.ok(failures[0].message.startsWith("mlx-start failed: invalid configuration"), failures[0].message);
  assert.ok(
    failures[0].message.includes(`profile "nope" (/mlx-start --profile): not defined for ${QWEN.modelId}; available profiles: fast`),
    failures[0].message,
  );
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
});

// ---- profiles and the trust boundary (plan 04-05: CFG-04, D-03, D-04, T-04-13) ----

test("a project profile that asks for trustRemoteCode is refused with one error: nothing is spawned, installed or asked", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const h = await harness(t, env);
  h.writeProject({ models: { qwen3_4b: { profiles: { fast: { trustRemoteCode: true } } } } });

  await h.start("qwen3_4b --profile fast");

  const failures = h.notes.filter((n) => n.type === "error");
  assert.deepEqual(
    failures.map((n) => n.message),
    [
      'mlx-start failed: invalid configuration\n  models["qwen3_4b"].profiles["fast"].trustRemoteCode (project .pi/pi-mlx-models.json): unknown key (trustRemoteCode is a "server" key, not part of a profile)',
    ],
  );
  assert.equal(h.confirms.length, 0, "no dialog was asked");
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
  assert.equal(h.providerCalls.length, 1, "only the initial provider registration");
});

// ---- a project profile through a real child process (plan 04-05: CFG-04, D-04, T-04-14) ----

test("a project file profile picked with --profile spawns the stub with its value, labelled as the profile", { timeout: 30_000 }, async (t) => {
  const { env, port } = await onFreePort();
  const h = await harness(t, env);
  h.writeProject({ models: { qwen3_4b: { profiles: { fast: { sampling: { temperature: 0.4 } } } } } });

  await h.start("qwen3_4b --profile fast");

  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--temp=0.4"]);
  assert.equal(
    startNotes(h.notes)[0].message,
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nprofile: fast (/mlx-start)\nflags: --port ${port} (env PI_MLX_MODELS_PORT), --temp 0.4 (profile fast)`,
  );
  assert.equal(h.confirms.length, 0);
});

/** A project directory with a template one level above it, as the profile's relative path points. */
function projectWithOutsideTemplate() {
  const base = mkdtempSync(join(tmpdir(), "pi-mlx-e2e-tpl-"));
  const cwd = join(base, "project");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(base, "outside.jinja"), "{{ outside }}");
  return { base, cwd };
}

test("a project profile whose chatTemplate points outside the project is refused and spawns nothing", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const { cwd } = projectWithOutsideTemplate();
  const h = await harness(t, env, { cwd });
  h.writeProject({ models: { qwen3_4b: { profiles: { fast: { chatTemplate: "../outside.jinja" } } } } });

  await h.start("qwen3_4b --profile fast");

  const failures = h.notes.filter((n) => n.type === "error");
  assert.equal(failures.length, 1);
  assert.ok(
    failures[0].message.startsWith("mlx-start failed: invalid configuration\n  model.chatTemplate (project .pi/pi-mlx-models.json): "),
    failures[0].message,
  );
  assert.ok(failures[0].message.endsWith("outside.jinja is outside the project directory"), failures[0].message);
  assert.equal(h.installCalls, 0);
  assert.equal(existsSync(h.argvFile), false, "nothing may be spawned");
});

test("the same chatTemplate path in a global profile is read and launches", { timeout: 30_000 }, async (t) => {
  const { env } = await onFreePort();
  const { cwd } = projectWithOutsideTemplate();
  const h = await harness(t, env, { cwd });
  h.writeConfig({ models: { qwen3_4b: { profiles: { fast: { chatTemplate: "../outside.jinja" } } } } });

  await h.start("qwen3_4b --profile fast");

  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  assert.equal(h.argv().at(-1), "--chat-template={{ outside }}");
  assert.match(startNotes(h.notes)[0].message, /\nprofile: fast \(\/mlx-start\)\nflags: .*--chat-template .*outside\.jinja \(profile fast\)$/);
});

// ---- phase 4 acceptance (roadmap criteria 1 to 4): one Qwen3-style scenario over the real extension, a real child and the recorded request ----

const ACCEPT_CONFIG = (port: number) => ({
  server: { port, logLevel: "DEBUG" },
  models: {
    qwen3_4b: {
      defaultProfile: "careful",
      profiles: {
        careful: {
          sampling: { temperature: 0.2, topP: 0.9, topK: 40, minP: 0.05, repetitionPenalty: 1.1, maxTokens: 1024, stop: ["###"], seed: 42 },
          chatTemplateArgs: { enable_thinking: false },
        },
        wild: { sampling: { temperature: 1.1 } },
      },
    },
  },
});

/** The payload pi builds for the launched model, with both output-limit names and pi's own thinking settings. */
const acceptPayload = () => ({
  model: QWEN.modelId,
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  temperature: 0.7,
  max_completion_tokens: 8192,
  max_tokens: 4096,
  reasoning_effort: "high",
  chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
});

test("accept 1 (criteria 1 and 2): a start with no flag uses the default profile for the argv and the start message", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(ACCEPT_CONFIG(port));

  await h.start("qwen3_4b");

  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  assert.deepEqual(h.argv(), [
    "--model",
    QWEN.modelId,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--log-level=DEBUG",
    '--chat-template-args={"enable_thinking":false}',
    "--temp=0.2",
    "--top-p=0.9",
    "--top-k=40",
    "--min-p=0.05",
    "--max-tokens=1024",
  ]);
  const starting = startNotes(h.notes);
  assert.equal(starting.length, 1);
  assert.equal(
    starting[0].message,
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\n` +
      "profile: careful (global file)\n" +
      `flags: --port ${port} (global file), --log-level DEBUG (global file), --chat-template-args {"enable_thinking":false} (profile careful), --temp 0.2 (profile careful), --top-p 0.9 (profile careful), --top-k 40 (profile careful), --min-p 0.05 (profile careful), --max-tokens 1024 (profile careful)\n` +
      'request: repetition_penalty 1.1 (profile careful), stop ["###"] (profile careful), seed 42 (profile careful)',
  );
});

test("accept 2 (criterion 1): --profile picks another profile, and a missing one lists the available ones and touches nothing", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(ACCEPT_CONFIG(port));

  await h.start("qwen3_4b --profile wild");

  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  assert.deepEqual(h.argv(), ["--model", QWEN.modelId, "--host", "127.0.0.1", "--port", String(port), "--log-level=DEBUG", "--temp=1.1"]);
  const starting = startNotes(h.notes);
  assert.equal(starting.length, 1);
  assert.match(starting[0].message, /\nprofile: wild \(\/mlx-start\)\n/);

  const installsBefore = h.installCalls;
  const argvBefore = readFileSync(h.argvFile, "utf8");
  const providerCallsBefore = h.providerCalls.length;
  const notesBefore = h.notes.length;

  await h.start("qwen3_4b --profile nope");

  const added = h.notes.slice(notesBefore);
  assert.equal(added.length, 1, "exactly one new note");
  assert.equal(added[0].type, "error");
  assert.ok(added[0].message.includes("available profiles: careful, wild"), added[0].message);
  assert.equal(h.installCalls, installsBefore, "no install was attempted");
  assert.equal(readFileSync(h.argvFile, "utf8"), argvBefore, "nothing was spawned");
  assert.equal(h.providerCalls.length, providerCallsBefore, "the provider was not re-registered");
  assert.equal(await connectRefused(port), false, "the running server was not touched");
});

test("accept 3 (criterion 3): the stand-in server receives the profile's values, and another provider's or model's request is unchanged", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(ACCEPT_CONFIG(port));
  await h.start("qwen3_4b");
  const original = acceptPayload();

  const rewritten = await h.runHook(original);
  assert.equal(await h.postToServer(port, rewritten), 200);

  const received = h.requests().at(-1)?.body as Record<string, unknown>;
  assert.equal(received.temperature, 0.2);
  assert.equal(received.top_p, 0.9);
  assert.equal(received.top_k, 40);
  assert.equal(received.min_p, 0.05);
  assert.equal(received.repetition_penalty, 1.1);
  assert.deepEqual(received.stop, ["###"]);
  assert.equal(received.seed, 42);
  assert.equal(received.max_completion_tokens, 1024);
  assert.equal(received.max_tokens, 1024);
  assert.equal(received.model, original.model);
  assert.deepEqual(received.messages, original.messages);
  assert.equal(received.stream, true);

  assert.equal(await h.runHook(acceptPayload(), "anthropic"), undefined);
  assert.equal(await h.postToServer(port, acceptPayload()), 200);
  assert.deepEqual(h.requests().at(-1)?.body, acceptPayload(), "another provider's request is unchanged");

  const otherModel = { ...acceptPayload(), model: "some/other-model" };
  assert.equal(await h.runHook(otherModel, PROVIDER_ID, "some/other-model"), undefined);
  assert.equal(await h.postToServer(port, otherModel), 200);
  assert.deepEqual(h.requests().at(-1)?.body, otherModel, "another model id's request is unchanged");
});

test("accept 4 (criterion 4): enable_thinking false leaves one source of template arguments and no reasoning_effort", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(ACCEPT_CONFIG(port));
  await h.start("qwen3_4b");

  assert.equal(await h.postToServer(port, await h.runHook(acceptPayload())), 200);
  const careful = h.requests().at(-1)?.body as Record<string, unknown>;
  assert.deepEqual(careful.chat_template_kwargs, { enable_thinking: false });
  assert.equal(Object.prototype.hasOwnProperty.call(careful, "reasoning_effort"), false);

  await h.start("qwen3_4b --profile wild");
  assert.equal(await h.postToServer(port, await h.runHook(acceptPayload())), 200);
  const wild = h.requests().at(-1)?.body as Record<string, unknown>;
  assert.deepEqual(wild.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
  assert.equal(wild.reasoning_effort, "high");
  assert.deepEqual(wild, { ...acceptPayload(), temperature: 1.1 }, "only the temperature differs from pi's payload");
});

// ---- phase 5 acceptance: the five roadmap criteria over the real extension, a real child process and the real reader ----

const SMOLLM3 = MODEL_PRESETS[4];
const GEMMA4 = MODEL_PRESETS[1];
const COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: false };
const OTHER_ID = "org/other";

/** A harness over the real reader on a temporary Hugging Face cache holding the given fixtures; no host can be reached. */
async function cachedHarness(
  t: TestContext,
  fixtures: ReadonlyArray<readonly [id: string, fixture: string]>,
  discovered: readonly string[] = [],
) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "pi-mlx-hf-"));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  for (const [id, fixture] of fixtures) writeHfCache(cacheRoot, id, hfFixture(fixture));
  const { env } = await onFreePort();
  return harness(t, env, {}, ALL_SUPPORTED, {
    readModelConfig: createModelConfigReader({ cacheRoot, fetch: noNetwork, env: {} }),
    discovered,
  });
}

const registered = (h: { providerCalls: Array<{ config: any }> }) => h.providerCalls.at(-1)?.config.models as any[];
const warningsOf = (notes: Array<{ message: string; type: string }>) => notes.filter((n) => n.type === "warning");

test("phase 5 criterion 1: the Qwen3, SmolLM3 and gemma-4 presets register the window of their own config.json", { timeout: 60_000 }, async (t) => {
  const h = await cachedHarness(t, [
    [QWEN.modelId, "qwen3-4b-instruct-2507-4bit"],
    [SMOLLM3.modelId, "smollm3-3b-4bit"],
    [GEMMA4.modelId, "gemma-4-e2b-it-4bit"],
  ]);

  const expected = [
    { key: "qwen3_4b", id: QWEN.modelId, window: 262144 },
    { key: "smollm3_3b", id: SMOLLM3.modelId, window: 65536 },
    { key: "gemma4_e2b", id: GEMMA4.modelId, window: 131072 },
  ];
  for (const { key, id, window } of expected) {
    await h.start(key);
    const models = registered(h);
    assert.equal(models.length, 1, key);
    assert.equal(models[0].id, id, key);
    assert.equal(models[0].contextWindow, window, key);
    assert.equal(models[0].reasoning, false, key);
    assert.deepEqual(models[0].input, ["text"], key);
    assert.equal(models[0].maxTokens, 8192, key);
    assert.equal("compat" in models[0], false, key);
  }
  assert.deepEqual(warningsOf(h.notes), [], "a cached config.json needs no warning");
  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  await h.stop();
});

test("phase 5 criterion 2: the R1 distill is a reasoning model, text-only models take no images, and a profile wins in both directions", { timeout: 60_000 }, async (t) => {
  const h = await cachedHarness(t, [
    [R1_DISTILL.modelId, "deepseek-r1-distill-qwen-1.5b-4bit"],
    [QWEN.modelId, "qwen3-4b-instruct-2507-4bit"],
  ]);
  h.writeConfig({
    models: {
      deepseek_r1_1_5b: { profiles: { plain: { limits: { reasoning: false, input: ["text", "image"] } } } },
      qwen3_4b: { profiles: { think: { limits: { reasoning: true } } } },
    },
  });

  await h.start("deepseek_r1_1_5b");
  let models = registered(h);
  assert.equal(models.length, 1);
  assert.equal(models[0].reasoning, true);
  assert.deepEqual(models[0].compat, COMPAT);
  assert.deepEqual(models[0].input, ["text"]);

  await h.start("deepseek_r1_1_5b --profile plain");
  models = registered(h);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, R1_DISTILL.modelId);
  assert.equal(models[0].reasoning, false, "the profile switches reasoning off over the preset");
  assert.equal("compat" in models[0], false);
  assert.deepEqual(models[0].input, ["text", "image"], "the profile opts in to images");
  assert.equal(models[0].maxTokens, 8192, "the default output limit follows the final reasoning flag");

  await h.start("qwen3_4b --profile think");
  models = registered(h);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, QWEN.modelId);
  assert.equal(models[0].reasoning, true, "the profile switches reasoning on over the preset");
  assert.deepEqual(models[0].compat, COMPAT);
  assert.deepEqual(models[0].input, ["text"]);

  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  await h.stop();
});

test("phase 5 criterion 3: the output limit has a documented default and a profile sets it", { timeout: 60_000 }, async (t) => {
  const h = await cachedHarness(t, [
    [QWEN.modelId, "qwen3-4b-instruct-2507-4bit"],
    [R1_DISTILL.modelId, "deepseek-r1-distill-qwen-1.5b-4bit"],
  ]);
  h.writeConfig({ models: { qwen3_4b: { profiles: { short: { limits: { maxTokens: 2048 } } } } } });

  await h.start("qwen3_4b");
  assert.equal(registered(h)[0].maxTokens, 8192);
  assert.ok(h.argv().every((arg) => !arg.startsWith("--max-tokens")), JSON.stringify(h.argv()));

  await h.start("deepseek_r1_1_5b");
  assert.equal(registered(h)[0].maxTokens, 32768);
  assert.ok(h.argv().every((arg) => !arg.startsWith("--max-tokens")), JSON.stringify(h.argv()));

  await h.start("qwen3_4b --profile short");
  assert.equal(registered(h)[0].maxTokens, 2048);
  const line = h.notes.filter((n) => n.message.startsWith("model: ")).at(-1);
  assert.ok(line, "the start shows a model line");
  assert.ok(line.message.includes("max output 2048 (profile short)"), line.message);
  assert.ok(h.argv().every((arg) => !arg.startsWith("--max-tokens")), `limits.maxTokens is not a server flag: ${JSON.stringify(h.argv())}`);

  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  await h.stop();
});

test("phase 5 criterion 4: pi lists only the loaded model by default, and provider.listAllModels lists every model the server reports", { timeout: 60_000 }, async (t) => {
  const reported = [QWEN.modelId, R1_DISTILL.modelId, OTHER_ID];
  const fixtures = [
    [QWEN.modelId, "qwen3-4b-instruct-2507-4bit"],
    [R1_DISTILL.modelId, "deepseek-r1-distill-qwen-1.5b-4bit"],
  ] as const;

  const byDefault = await cachedHarness(t, fixtures, reported);
  await byDefault.start("qwen3_4b");
  assert.deepEqual(registered(byDefault).map((m) => m.id), [QWEN.modelId], "only the loaded model is listed");
  await byDefault.stop();
  assert.deepEqual(registered(byDefault), [], "after /mlx-stop the list is empty again");

  const everything = await cachedHarness(t, fixtures, reported);
  everything.writeConfig({ provider: { listAllModels: true } });
  await everything.start("qwen3_4b");
  const models = registered(everything);
  assert.deepEqual(models.map((m) => m.id), reported);
  assert.deepEqual(models.map((m) => m.contextWindow), [262144, 131072, 32768]);
  assert.equal(models[1].reasoning, true, "the R1 distill is flagged by its name");
  assert.deepEqual(models[1].compat, COMPAT);
  assert.equal(models[0].reasoning, false);
  assert.deepEqual(models.map((m) => m.input), [["text"], ["text"], ["text"]]);
  assert.deepEqual(everything.notes.filter((n) => n.type === "error"), []);
  await everything.stop();
});

test("phase 5 criterion 5: an unreadable config.json still starts with the documented window and one notice", { timeout: 60_000 }, async (t) => {
  const h = await cachedHarness(t, []);

  await h.start("smollm3_3b");

  assert.deepEqual(h.notes.filter((n) => n.type === "error"), []);
  assert.ok(h.notes.some((n) => n.message.startsWith("MLX server is ready for prompts. Use /model and pick pi-mlx-models/")));
  assert.equal(registered(h)[0].id, SMOLLM3.modelId);
  assert.equal(registered(h)[0].contextWindow, 32768);
  const fallback = /^context window unavailable for \S+ \(.+\); using 32768$/;
  assert.equal(h.notes.filter((n) => n.type === "warning" && fallback.test(n.message)).length, 1);

  await h.start("smollm3_3b");
  assert.equal(registered(h)[0].contextWindow, 32768);
  assert.equal(h.notes.filter((n) => n.type === "warning" && fallback.test(n.message)).length, 1, "the same notice is not shown twice");
  await h.stop();

  const manual = await cachedHarness(t, []);
  manual.writeConfig({ models: { smollm3_3b: { profiles: { fixed: { limits: { contextWindow: 50000 } } } } } });
  await manual.start("smollm3_3b --profile fixed");
  assert.equal(registered(manual)[0].contextWindow, 50000);
  assert.deepEqual(warningsOf(manual.notes), [], "a window set by hand skips the read, so there is nothing to warn about");
  await manual.stop();
});

// ---- /mlx-last: the last launch is remembered at ready and replayed by a fresh extension instance (plan 06-06: CMD-01, CMD-06) ----

const FAST_PROFILE_FILE = (port: number, temperature = 0.2) => ({
  server: { port },
  models: { qwen3_4b: { profiles: { fast: { sampling: { temperature } } } } },
});
const lastRecordPath = (h: { dir: string }) => join(h.dir, "data", "last-launch.json");
const errorNotes = (notes: Array<{ message: string; type: string }>) => notes.filter((n) => n.type === "error");
/** A fresh extension instance over the files of an earlier one, as when pi is closed and opened again. */
const reopened = (t: TestContext, earlier: { dir: string }, env: Settings = {}) =>
  harness(t, env, {}, ALL_SUPPORTED, { dir: earlier.dir });

test("mlx-last e2e: a model started once is started again with the same profile by a fresh instance, with no picker", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const first = await harness(t);
  first.writeConfig(FAST_PROFILE_FILE(port));

  await first.start("qwen3_4b --profile fast");

  assert.deepEqual(errorNotes(first.notes), []);
  assert.equal(
    readFileSync(lastRecordPath(first), "utf8"),
    `{"version":1,"model":"${QWEN.modelId}","profile":"fast"}\n`,
    "the record holds the model id and the profile and nothing else",
  );
  const firstArgv = first.argv();
  await first.stop();
  assert.equal(await connectRefused(port), true);
  rmSync(first.argvFile);

  const second = await reopened(t, first);
  second.ctx.ui.select = async () => {
    throw new Error("the picker must not open");
  };
  await second.last();

  assert.deepEqual(errorNotes(second.notes), []);
  assert.deepEqual(second.argv(), firstArgv, "the same model, the same profile, the same server arguments");
  const starting = startNotes(second.notes);
  assert.equal(starting.length, 1);
  assert.ok(starting[0].message.includes("\nprofile: fast (previous launch)"), starting[0].message);
  assert.ok(second.notes.some((n) => n.message.startsWith("MLX server is ready for prompts.")), "the ready message appears");
  await second.stop();
});

test("mlx-last e2e: the replay goes through the files read now, not the files of the first launch", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const first = await harness(t);
  first.writeConfig(FAST_PROFILE_FILE(port));
  await first.start("qwen3_4b --profile fast");
  assert.deepEqual(first.argv().filter((arg) => arg.startsWith("--temp")), ["--temp=0.2"]);
  await first.stop();

  first.writeConfig(FAST_PROFILE_FILE(port, 0.4));
  const second = await reopened(t, first);
  await second.last();

  assert.deepEqual(errorNotes(second.notes), []);
  assert.deepEqual(second.argv().filter((arg) => arg.startsWith("--temp")), ["--temp=0.4"]);
  await second.stop();
});

test("mlx-last e2e: with nothing remembered it says so, points to /mlx-start and starts nothing", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);

  await h.last();

  assert.deepEqual(errorNotes(h.notes), []);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].type, "info");
  assert.ok(h.notes[0].message.includes("/mlx-start"), h.notes[0].message);
  assert.equal(existsSync(h.argvFile), false, "no child was started");
  assert.equal(h.installCalls, 0);
  assert.equal(h.providerCalls.length, 1, "nothing was installed or registered");
});

test("mlx-last e2e: an override applies to one launch only and is never remembered", { timeout: 60_000 }, async (t) => {
  const port = await freePort();
  const first = await harness(t);
  first.writeConfig({ server: { port } });
  await first.start("qwen3_4b");
  const record = `{"version":1,"model":"${QWEN.modelId}","profile":null}\n`;
  assert.equal(readFileSync(lastRecordPath(first), "utf8"), record);
  await first.stop();

  const second = await reopened(t, first);
  await second.last("--log-level DEBUG");
  assert.deepEqual(errorNotes(second.notes), []);
  assert.ok(second.argv().includes("--log-level=DEBUG"), JSON.stringify(second.argv()));
  assert.equal(readFileSync(lastRecordPath(first), "utf8"), record, "the record still holds only the model and the profile");
  await second.stop();

  const third = await reopened(t, first);
  await third.last();
  assert.deepEqual(errorNotes(third.notes), []);
  assert.equal(third.argv().some((arg) => arg.startsWith("--log-level")), false, JSON.stringify(third.argv()));
  await third.stop();
});

// ---- /mlx-status: one block with the health and the lines the start showed, from a record kept in memory (plan 06-08: CMD-03) ----

/** The notices a command added after `before` notices existed. */
const addedSince = (notes: Array<{ message: string; type: string }>, before: number) => notes.slice(before);

test("mlx-status e2e: a started model is reported ready with the very lines the start showed", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({
    server: { port },
    models: { qwen3_4b: { profiles: { fast: { sampling: { temperature: 0.2, repetitionPenalty: 1.1 } } } } },
  });

  await h.start("qwen3_4b --profile fast");
  assert.deepEqual(errorNotes(h.notes), []);
  const starting = startNotes(h.notes);
  assert.equal(starting.length, 1);
  const startLines = starting[0].message.split("\n").slice(1);
  assert.ok(startLines.length >= 3, `the start message has a profile, a flags and a request line: ${starting[0].message}`);
  const modelNote = h.notes.find((n) => n.message.startsWith("model: "));
  assert.ok(modelNote, "the start shows a model line");

  const before = h.notes.length;
  await h.status();

  const added = addedSince(h.notes, before);
  assert.equal(added.length, 1, "one notice, through the same channel as the start message");
  assert.equal(added[0].type, "info");
  const block = added[0].message;
  assert.ok(block.startsWith("status: ready"), block);
  for (const line of startLines) assert.ok(block.includes(line), `the status block repeats "${line}": ${block}`);
  assert.ok(block.includes(modelNote.message), `the status block repeats the model line: ${block}`);
  assert.ok(block.includes(`:${port}`), block);
  assert.ok(block.includes("--temp 0.2 (profile fast)"), block);
  await h.stop();
});

test("mlx-status e2e: after /mlx-stop the status is down and no longer shows the session's lines", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port }, models: { qwen3_4b: { profiles: { fast: { sampling: { temperature: 0.2 } } } } } });
  await h.start("qwen3_4b --profile fast");
  await h.stop();

  const before = h.notes.length;
  await h.status();

  const block = addedSince(h.notes, before)[0].message;
  assert.ok(block.startsWith("status: down"), block);
  assert.ok(block.includes("nothing is listening"), block);
  assert.equal(block.includes("profile:"), false, block);
  assert.equal(block.includes("flags:"), false, block);
});

test("mlx-status e2e: with nothing ever started the status is down and does not claim a session", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port } });

  await h.status();

  assert.equal(h.notes.length, 1);
  const block = h.notes[0].message;
  assert.ok(block.startsWith("status: down"), block);
  assert.ok(block.includes("nothing is listening"), block);
  assert.equal(block.includes("started by this session"), false, block);
  assert.equal(existsSync(h.argvFile), false, "no child was started");
});

test("mlx-status e2e crash: after the child is killed from outside the status is down and claims no running session", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig({ server: { port }, models: { qwen3_4b: { profiles: { fast: { sampling: { temperature: 0.2 } } } } } });
  await h.start("qwen3_4b --profile fast");
  assert.deepEqual(errorNotes(h.notes), []);
  const child = h.children.at(-1);
  assert.ok(child, "premise: the real server spawned a child");

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const before = h.notes.length;
  await h.status();

  const block = h.notes.slice(before)[0].message;
  assert.ok(block.startsWith("status: down"), block);
  assert.equal(block.includes("profile:"), false, block);
  assert.equal(block.includes("flags:"), false, block);
  assert.equal(block.includes("a start is under way"), false, block);
});

// ---- /mlx-restart: the same model and profile selection through the files read now, flags not kept (plan 06-09: CMD-04) ----

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

test("mlx-restart e2e: a running server is replaced by a new child with the override, and /mlx-status shows the new flags", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(FAST_PROFILE_FILE(port));
  await h.start("qwen3_4b --profile fast");
  assert.deepEqual(errorNotes(h.notes), []);
  assert.equal(h.children.length, 1);

  await h.restart("--log-level DEBUG");

  assert.deepEqual(errorNotes(h.notes), []);
  assert.equal(h.children.length, 2, "the restart spawned a new child");
  assert.equal(hasExited(h.children[0]), true, "the first child is gone");
  assert.equal(hasExited(h.children[1]), false, "the second child serves the port");
  const argv = h.argv();
  assert.ok(argv.includes("--log-level=DEBUG"), JSON.stringify(argv));
  assert.ok(argv.includes("--temp=0.2"), JSON.stringify(argv));
  const restarts = startNotes(h.notes).filter((n) => n.message.includes("(previous launch)"));
  assert.equal(restarts.length, 1, "the restart's start message words the kept profile as the previous launch's");
  assert.ok(restarts[0].message.includes("\nprofile: fast (previous launch)"), restarts[0].message);

  const before = h.notes.length;
  await h.status();
  const block = addedSince(h.notes, before)[0].message;
  assert.ok(block.startsWith("status: ready"), block);
  assert.ok(block.includes("--log-level DEBUG"), block);
  assert.ok(block.includes("--temp 0.2 (profile fast)"), block);

  await h.restart();

  assert.deepEqual(errorNotes(h.notes), []);
  assert.equal(h.children.length, 3);
  assert.equal(h.argv().some((arg) => arg.startsWith("--log-level")), false, "the override applied to one restart only");
  assert.ok(h.argv().includes("--temp=0.2"), "the profile selection is kept");
  await h.stop();
});

test("mlx-restart e2e: an edit of the global file takes effect on the next restart", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const h = await harness(t);
  h.writeConfig(FAST_PROFILE_FILE(port));
  await h.start("qwen3_4b --profile fast");
  assert.ok(h.argv().includes("--temp=0.2"), JSON.stringify(h.argv()));

  h.writeConfig(FAST_PROFILE_FILE(port, 0.5));
  await h.restart();

  assert.deepEqual(errorNotes(h.notes), []);
  assert.deepEqual(h.argv().filter((arg) => arg.startsWith("--temp")), ["--temp=0.5"]);
  await h.stop();
});

test("mlx-restart e2e: with nothing running a fresh instance starts the remembered launch with the same arguments and says so", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const first = await harness(t);
  first.writeConfig(FAST_PROFILE_FILE(port));
  await first.start("qwen3_4b --profile fast");
  assert.deepEqual(errorNotes(first.notes), []);
  const firstArgv = first.argv();
  await first.stop();
  assert.equal(await connectRefused(port), true);
  rmSync(first.argvFile);

  const second = await reopened(t, first);
  await second.restart();

  assert.deepEqual(errorNotes(second.notes), []);
  assert.deepEqual(second.argv(), firstArgv, "the same model, the same profile, the same server arguments");
  const said = second.notes.filter((n) => n.type === "info" && n.message.includes("nothing was running, starting"));
  assert.equal(said.length, 1);
  assert.ok(said[0].message.includes(QWEN.modelId), said[0].message);
  assert.ok(startNotes(second.notes)[0].message.includes("\nprofile: fast (previous launch)"), startNotes(second.notes)[0].message);
  await second.stop();
});

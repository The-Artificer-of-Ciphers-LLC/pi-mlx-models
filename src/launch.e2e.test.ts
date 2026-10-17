import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createExtension } from "./index.js";
import { MODEL_PRESETS } from "./presets.js";
import { createMlxServer, createSystemHost, type ServerHost } from "./server.js";
import { connectRefused, freePort, makeCtx, makeFakePi, stubArgs } from "./testkit.js";

/**
 * End-to-end proof of the layered-config path: a value written in the global config file reaches the
 * spawned process (a stub that records its argv), the provider registration and the start message on
 * the very next /mlx-start. A real createMlxServer drives a real child; only the installer is faked.
 */

const QWEN = MODEL_PRESETS[3];

type Settings = Record<string, string | undefined>;

async function harness(t: TestContext, env: Settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-mlx-e2e-"));
  const globalConfigPath = join(dir, "data", "config.json");
  const argvFile = join(dir, "argv.json");

  const base = createSystemHost({
    command: process.execPath,
    buildArgs: stubArgs,
    env: { STUB_MODE: "ok", STUB_ARGV_FILE: argvFile },
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
    discoverModelIds: async () => [],
    settings: { env, globalConfigPath, home: dir },
    shutdownWaitMs: 1000,
  });
  const fakePi = makeFakePi();
  const fakeCtx = makeCtx();
  await extension(fakePi.pi);

  return {
    ...fakePi,
    ...fakeCtx,
    globalConfigPath,
    argvFile,
    get installCalls() {
      return installCalls;
    },
    writeConfig(value: unknown) {
      mkdirSync(dirname(globalConfigPath), { recursive: true });
      writeFileSync(globalConfigPath, JSON.stringify(value));
    },
    argv: (): string[] => JSON.parse(readFileSync(argvFile, "utf8")),
    start: (input = "qwen3_4b") => fakePi.commands.get("mlx-start")!(input, fakeCtx.ctx),
    stop: () => fakePi.commands.get("mlx-stop")!("", fakeCtx.ctx),
  };
}

const startNotes = (notes: Array<{ message: string; type: string }>) =>
  notes.filter((n) => n.message.startsWith("Starting MLX server with"));
const lastBaseUrl = (calls: Array<{ config: any }>) => calls.at(-1)?.config.baseUrl;

test("a port and log level in the global file reach the process, the provider and the start message", { timeout: 30_000 }, async (t) => {
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
  assert.equal(existsSync(dirname(h.globalConfigPath)), false);
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

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createExtension } from "./index.js";
import { MODEL_PRESETS } from "./presets.js";
import { createMlxServer, createSystemHost, type ServerHost } from "./server.js";
import { connectRefused, freePort, makeCtx, makeFakePi, stubArgs, type CtxOptions } from "./testkit.js";

/**
 * End-to-end proof of the layered-config path: a value written in the global config file reaches the
 * spawned process (a stub that records its argv), the provider registration and the start message on
 * the very next /mlx-start. A real createMlxServer drives a real child; only the installer is faked.
 */

const QWEN = MODEL_PRESETS[3];

type Settings = Record<string, string | undefined>;

async function harness(t: TestContext, env: Settings = {}, ctxOptions: CtxOptions = {}) {
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
  const fakeCtx = makeCtx(undefined, ctxOptions);
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
    /** Write the working directory's own `.pi/pi-mlx-models.json`. */
    writeProject(value: unknown) {
      mkdirSync(join(fakeCtx.ctx.cwd, ".pi"), { recursive: true });
      writeFileSync(join(fakeCtx.ctx.cwd, ".pi", "pi-mlx-models.json"), JSON.stringify(value));
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

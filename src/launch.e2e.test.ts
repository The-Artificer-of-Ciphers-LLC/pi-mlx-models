import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROVIDER_ID } from "./config.js";
import type { ProbeResult } from "./flagprobe.js";
import { createExtension } from "./index.js";
import { MODEL_PRESETS } from "./presets.js";
import { createMlxServer, createSystemHost, type ServerHost } from "./server.js";
import { SETTINGS } from "./settings.js";
import { connectRefused, freePort, makeCtx, makeFakePi, stubArgs, type CtxOptions } from "./testkit.js";

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

async function harness(t: TestContext, env: Settings = {}, ctxOptions: CtxOptions = {}, probe: ProbeResult = ALL_SUPPORTED) {
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
    probeFlags: async () => probe,
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

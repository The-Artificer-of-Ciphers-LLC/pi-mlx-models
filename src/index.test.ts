import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_ID } from "./config.js";
import { createExtension } from "./index.js";
import { MODEL_PRESETS } from "./presets.js";
import type { LaunchSpec, MlxServer, ServerEvent } from "./server.js";
import { makeCtx, makeFakePi } from "./testkit.js";

type ProviderCall = { name: string; config: any };
type Note = { message: string; type: string };

interface FakeServerOptions {
  /** Replaces the default start (which emits launched, loading, warming, ready and resolves). */
  start?: (model: string, onEvent?: (event: ServerEvent) => void) => Promise<void>;
  /** Replaces the default stop (which resolves at once). */
  stop?: () => Promise<void>;
}

function makeFakeServer(options: FakeServerOptions = {}) {
  const startCalls: string[] = [];
  /** The LaunchSpec of each start, parallel to `startCalls`. */
  const launches: Array<LaunchSpec | undefined> = [];
  let stopCalls = 0;
  const server: MlxServer & { startCalls: string[]; launches: Array<LaunchSpec | undefined>; readonly stopCalls: number } = {
    get running() {
      return startCalls.length > 0;
    },
    startCalls,
    launches,
    get stopCalls() {
      return stopCalls;
    },
    async start(model, onEvent, launch) {
      startCalls.push(model);
      launches.push(launch);
      if (options.start) return options.start(model, onEvent);
      for (const type of ["launched", "loading", "warming", "ready"] as const) onEvent?.({ type });
    },
    async stop() {
      stopCalls += 1;
      if (options.stop) await options.stop();
    },
  };
  return server;
}

const lastStatus = (statuses: Array<{ key: string; text: string | undefined }>) =>
  statuses.filter((s) => s.key === PROVIDER_ID).at(-1)?.text;
const modelIdsOf = (call: ProviderCall | undefined) => (call?.config.models as Array<{ id: string }> | undefined)?.map((m) => m.id);

test("mlx-start with a preset key starts that preset's model and reports ready", async () => {
  const preset = MODEL_PRESETS[3];
  const server = makeFakeServer();
  const { pi, commands, providerCalls } = makeFakePi();
  const { ctx, notes, statuses } = makeCtx();
  const extension = createExtension({
    server,
    ensureInstalled: async () => {},
    discoverModelIds: async () => [preset.modelId],
    settings: freshSettings({}),
  });
  await extension(pi);

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(server.startCalls, [preset.modelId]);
  assert.ok(notes.some((n) => n.type === "info" && n.message.startsWith("Starting MLX server with")));
  assert.ok(
    notes.some(
      (n) =>
        n.type === "info" &&
        n.message === "MLX server is ready for prompts. Use /model and pick pi-mlx-models/...",
    ),
  );
  assert.equal(lastStatus(statuses), `mlx: running (${preset.modelId})`);
  assert.deepEqual(modelIdsOf(providerCalls.at(-1)), [preset.modelId]);
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets already-queued promise continuations run, without any timer. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Settings that read no real file: the global config path points into an empty temporary directory. */
function freshSettings(env: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-mlx-settings-"));
  return { env, globalConfigPath: join(dir, "config.json"), home: dir };
}

/** An extension over a fresh fake pi, with a counting installer that succeeds unless told otherwise. */
async function setup(
  options: {
    server?: FakeServerOptions;
    ensureInstalled?: (opts?: any) => Promise<void>;
    discovered?: string[];
    select?: (options: string[]) => string | undefined;
    env?: Record<string, string | undefined>;
    /** Settings sources to use instead of a fresh empty one, e.g. to write the global file from the test. */
    settings?: ReturnType<typeof freshSettings>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const server = makeFakeServer(options.server);
  const installCalls: any[] = [];
  const fakePi = makeFakePi();
  const fakeCtx = makeCtx(options.select);
  const extension = createExtension({
    server,
    ensureInstalled: (async (opts?: any) => {
      installCalls.push(opts);
      await options.ensureInstalled?.(opts);
    }) as any,
    discoverModelIds: async () => options.discovered ?? [],
    settings: options.settings ?? freshSettings(options.env ?? {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  await extension(fakePi.pi);
  return { server, installCalls, ...fakePi, ...fakeCtx };
}

const errors = (notes: Note[]) => notes.filter((n) => n.type === "error").map((n) => n.message);

test("the extension registers mlx-init, mlx-start and mlx-stop, a session_shutdown handler and one initial provider", async () => {
  const { commands, handlers, providerCalls } = await setup();

  assert.deepEqual([...commands.keys()].sort(), ["mlx-init", "mlx-start", "mlx-stop"]);
  assert.ok(handlers.has("session_shutdown"));
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].name, PROVIDER_ID);
  assert.equal(providerCalls[0].config.baseUrl, "http://127.0.0.1:8080/v1");
  assert.deepEqual(providerCalls[0].config.models, []);
});

test("mlx-start with a preset number starts that preset's model", async () => {
  const { server, commands, ctx } = await setup();

  await commands.get("mlx-start")!("2", ctx);

  assert.deepEqual(server.startCalls, [MODEL_PRESETS[1].modelId]);
});

test("mlx-start with a raw model id starts that id and names no preset", async () => {
  const { server, commands, ctx, notes } = await setup();

  await commands.get("mlx-start")!("org/some-model", ctx);

  assert.deepEqual(server.startCalls, ["org/some-model"]);
  const starting = notes.find((n) => n.message.startsWith("Starting MLX server with"));
  assert.equal(starting?.message, "Starting MLX server with org/some-model...");
});

test("mlx-start with no arguments opens the picker and starts the chosen preset", async () => {
  const { server, commands, ctx } = await setup({ select: (options) => options[3] });

  await commands.get("mlx-start")!("", ctx);

  assert.deepEqual(server.startCalls, [MODEL_PRESETS[3].modelId]);
});

test("a cancelled picker notifies and starts nothing", async () => {
  const { server, installCalls, commands, ctx, notes } = await setup({ select: () => undefined });

  await commands.get("mlx-start")!("", ctx);

  assert.deepEqual(notes, [{ message: "Preset selection cancelled.", type: "info" }]);
  assert.deepEqual(server.startCalls, []);
  assert.equal(installCalls.length, 0);
});

test("mlx-start with an out-of-range preset number fails before any side effect", async () => {
  const { server, installCalls, commands, ctx, notes, providerCalls } = await setup();
  const providerCallsBefore = providerCalls.length;

  await commands.get("mlx-start")!("9", ctx);

  const [message] = errors(notes);
  assert.ok(message?.startsWith("mlx-start failed:"), `unexpected message: ${message}`);
  assert.match(message, /out of range/);
  assert.deepEqual(server.startCalls, []);
  assert.equal(installCalls.length, 0);
  assert.equal(providerCalls.length, providerCallsBefore);
});

test("mlx-start with preset number zero is rejected the same way", async () => {
  const { server, installCalls, commands, ctx, notes } = await setup();

  await commands.get("mlx-start")!("0", ctx);

  assert.ok(errors(notes)[0]?.startsWith("mlx-start failed:"));
  assert.deepEqual(server.startCalls, []);
  assert.equal(installCalls.length, 0);
});

test("mlx-start with an id that starts with a dash fails before any side effect", async () => {
  const { server, installCalls, commands, ctx, notes, providerCalls } = await setup();
  const providerCallsBefore = providerCalls.length;

  await commands.get("mlx-start")!("-x", ctx);

  const [message] = errors(notes);
  assert.ok(message?.startsWith("mlx-start failed:"), `unexpected message: ${message}`);
  assert.deepEqual(server.startCalls, []);
  assert.equal(installCalls.length, 0);
  assert.equal(providerCalls.length, providerCallsBefore);
});

test("a server that fails to start is reported as mlx-start failed and never shows running", async () => {
  const { commands, ctx, notes, statuses } = await setup({
    server: {
      start: async () => {
        throw new Error("boom");
      },
    },
  });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(errors(notes), ["mlx-start failed: boom"]);
  assert.ok(!statuses.some((s) => s.text?.startsWith("mlx: running")));
});

test("a failing runtime install is reported as mlx-start failed and the server is never started", async () => {
  const { server, commands, ctx, notes } = await setup({
    ensureInstalled: async () => {
      throw new Error("no python");
    },
  });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(errors(notes), ["mlx-start failed: no python"]);
  assert.deepEqual(server.startCalls, []);
});

test("the provider falls back to the started model when discovery finds none", async () => {
  const { commands, ctx, providerCalls } = await setup({ discovered: [] });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(modelIdsOf(providerCalls.at(-1)), [MODEL_PRESETS[3].modelId]);
});

test("mlx-stop reports stopped only after the server's stop has resolved", async () => {
  const gate = deferred();
  const { server, commands, ctx, notes, statuses } = await setup({ server: { stop: () => gate.promise } });

  const stopping = commands.get("mlx-stop")!("", ctx);
  await flush();

  assert.equal(server.stopCalls, 1);
  assert.ok(!notes.some((n) => n.message === "MLX server stopped."), "reported stopped before stop() resolved");
  assert.notEqual(lastStatus(statuses), "mlx: stopped");

  gate.resolve();
  await stopping;

  assert.ok(notes.some((n) => n.type === "info" && n.message === "MLX server stopped."));
  assert.equal(lastStatus(statuses), "mlx: stopped");
});

test("mlx-init installs with upgrade and reports success", async () => {
  const { installCalls, commands, ctx, notes } = await setup();

  await commands.get("mlx-init")!("", ctx);

  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0].upgrade, true);
  assert.ok(notes.some((n) => n.type === "info" && n.message === "MLX runtime installed."));
  assert.deepEqual(errors(notes), []);
});

test("mlx-init failure is reported as mlx-init failed", async () => {
  const { commands, ctx, notes } = await setup({
    ensureInstalled: async () => {
      throw new Error("pip exploded");
    },
  });

  await commands.get("mlx-init")!("", ctx);

  assert.deepEqual(errors(notes), ["mlx-init failed: pip exploded"]);
  assert.ok(!notes.some((n) => n.message === "MLX runtime installed."));
});

/** A promise that never settles: a stop or start that hangs. */
const never = () => new Promise<never>(() => {});

test("session_shutdown awaits server.stop() before it finishes", async () => {
  const gate = deferred();
  const order: string[] = [];
  const { handlers } = await setup({
    server: {
      stop: async () => {
        order.push("stop started");
        await gate.promise;
        order.push("stop finished");
      },
    },
    sleep: never,
  });

  const finished = Promise.resolve(handlers.get("session_shutdown")!()).then(() => {
    order.push("handler finished");
  });
  await flush();
  assert.deepEqual(order, ["stop started"]);

  gate.resolve();
  await finished;

  assert.deepEqual(order, ["stop started", "stop finished", "handler finished"]);
});

test("session_shutdown still finishes once the wait elapses when stop never resolves", async () => {
  const wait = deferred();
  const sleepMs: number[] = [];
  const { handlers, providerCalls } = await setup({
    server: { stop: never },
    sleep: (ms) => {
      sleepMs.push(ms);
      return wait.promise;
    },
  });
  const providerCallsBefore = providerCalls.length;

  let finished = false;
  const done = Promise.resolve(handlers.get("session_shutdown")!()).then(() => {
    finished = true;
  });
  await flush();
  assert.equal(finished, false, "handler finished before the wait elapsed");
  assert.equal(sleepMs.length, 1);
  assert.ok(sleepMs[0] > 0, "the wait must be a positive bound");

  wait.resolve();
  await done;

  assert.equal(providerCalls.length, providerCallsBefore + 1);
});

test("session_shutdown during an in-flight mlx-start completes and stops the progress spinner", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { server, commands, handlers, ctx, statuses } = await setup({
    server: {
      start: (_model, onEvent) => {
        onEvent?.({ type: "launched" });
        return never();
      },
    },
    sleep: never,
  });

  void commands.get("mlx-start")!("qwen3_4b", ctx);
  await flush();
  assert.equal(server.startCalls.length, 1);

  const beforeTick = statuses.length;
  t.mock.timers.tick(1000);
  assert.ok(statuses.length > beforeTick, "premise: the spinner should be animating while start is pending");

  await handlers.get("session_shutdown")!();

  const afterShutdown = statuses.length;
  t.mock.timers.tick(1000);
  assert.equal(statuses.length, afterShutdown, "the spinner kept running after shutdown");
});

test("session_shutdown re-registers the provider from discovery, empty when nothing is found", async () => {
  const { handlers, providerCalls } = await setup({ discovered: [], sleep: never });
  const providerCallsBefore = providerCalls.length;

  await handlers.get("session_shutdown")!();

  assert.equal(providerCalls.length, providerCallsBefore + 1);
  assert.deepEqual(modelIdsOf(providerCalls.at(-1)), []);
});

test("a stop that rejects does not prevent the provider re-registration at shutdown", async () => {
  const { handlers, providerCalls } = await setup({
    server: {
      stop: async () => {
        throw new Error("stop failed");
      },
    },
    sleep: never,
  });
  const providerCallsBefore = providerCalls.length;

  await handlers.get("session_shutdown")!();

  assert.equal(providerCalls.length, providerCallsBefore + 1);
});

test("an invalid PI_MLX_MODELS_PORT is warned about once, on the first mlx-start only", async () => {
  const { commands, ctx, notes } = await setup({ env: { PI_MLX_MODELS_PORT: "abc" } });
  const warnings = () => notes.filter((n) => n.type === "warning");

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.equal(warnings().length, 1);
  assert.match(warnings()[0].message, /PI_MLX_MODELS_PORT/);
  assert.equal(notes[0].type, "warning");

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.equal(warnings().length, 1);
});

test("without config problems no warning notification is shown", async () => {
  const { commands, ctx, notes } = await setup({ env: {} });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(notes.filter((n) => n.type === "warning"), []);
});

test("a rejected first mlx-start still surfaces the config warning once", async () => {
  const { commands, ctx, notes } = await setup({ env: { PI_MLX_MODELS_PORT: "abc" } });
  const warnings = () => notes.filter((n) => n.type === "warning");

  await commands.get("mlx-start")!("9", ctx);
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0].message, /PI_MLX_MODELS_PORT/);

  await commands.get("mlx-start")!("9", ctx);
  assert.equal(warnings().length, 1);
});

// CR-02: /mlx-stop and a newer /mlx-start cancel an in-flight install.
test("mlx-stop while the runtime installs: no late server start, no late UI writes, status stays stopped", async () => {
  const gate = deferred();
  let emit: ((event: any) => void) | undefined;
  const { server, commands, ctx, notes, statuses, widgets } = await setup({
    ensureInstalled: async (opts) => {
      emit = opts.onEvent;
      await gate.promise;
    },
  });

  const starting = commands.get("mlx-start")!("qwen3_4b", ctx);
  await flush();
  await commands.get("mlx-stop")!("", ctx);
  const statusesAfterStop = statuses.length;
  const widgetsAfterStop = widgets.length;

  emit?.({ phase: "pip", state: "active", detail: "late pip line" });
  gate.resolve();
  await starting;

  assert.deepEqual(server.startCalls, [], "a stopped start must not start the server");
  assert.equal(statuses.length, statusesAfterStop, "no status write after the stop");
  assert.equal(widgets.length, widgetsAfterStop, "no widget write after the stop");
  assert.equal(lastStatus(statuses), "mlx: stopped");
  assert.ok(!notes.some((n) => n.message.startsWith("Starting MLX server")));
  assert.deepEqual(errors(notes), []);
});

test("two quick mlx-start calls share one install and only the newer one starts the server", async () => {
  const gate = deferred();
  const { server, installCalls, commands, ctx, notes, statuses } = await setup({
    ensureInstalled: () => gate.promise,
  });

  const first = commands.get("mlx-start")!("1", ctx);
  await flush();
  const second = commands.get("mlx-start")!("2", ctx);
  await flush();
  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(installCalls.length, 1, "concurrent starts must not run two installs in one venv");
  assert.deepEqual(server.startCalls, [MODEL_PRESETS[1].modelId]);
  assert.equal(lastStatus(statuses), `mlx: running (${MODEL_PRESETS[1].modelId})`);
  assert.deepEqual(errors(notes), []);
});

// WR-01 (round 2): /mlx-init must not share the epoch that cancels starts.
test("an mlx-init while the server is starting is refused and the start still completes", async () => {
  const gate = deferred();
  const { server, installCalls, commands, ctx, notes, statuses, providerCalls } = await setup({
    discovered: [MODEL_PRESETS[3].modelId],
    server: {
      start: async (_model, onEvent) => {
        onEvent?.({ type: "launched" });
        await gate.promise;
        onEvent?.({ type: "ready" });
      },
    },
  });

  const starting = commands.get("mlx-start")!("qwen3_4b", ctx);
  await flush();
  assert.equal(server.startCalls.length, 1, "premise: server.start is in flight");
  await commands.get("mlx-init")!("", ctx);
  gate.resolve();
  await starting;

  assert.equal(installCalls.length, 1, "the refused init must not run an install");
  assert.ok(errors(notes).some((m) => m.includes("/mlx-stop")), "the refusal says how to recover");
  assert.equal(lastStatus(statuses), `mlx: running (${MODEL_PRESETS[3].modelId})`);
  assert.ok(notes.some((n) => n.message.startsWith("MLX server is ready for prompts")));
  assert.deepEqual(modelIdsOf(providerCalls.at(-1)), [MODEL_PRESETS[3].modelId]);
});

test("an mlx-init after a start does not drop a later crash of the server", async () => {
  let emit: ((event: ServerEvent) => void) | undefined;
  const { commands, ctx, statuses } = await setup({
    server: {
      start: async (_model, onEvent) => {
        emit = onEvent;
        onEvent?.({ type: "ready" });
      },
    },
  });

  await commands.get("mlx-start")!("qwen3_4b", ctx);
  assert.equal(lastStatus(statuses), `mlx: running (${MODEL_PRESETS[3].modelId})`);
  await commands.get("mlx-init")!("", ctx);
  emit?.({ type: "exited" });

  assert.equal(lastStatus(statuses), "mlx: stopped", "a crash after init must still be reported");
});

test("an mlx-init after an mlx-stop waits for the stopped start's install and then runs its own", async () => {
  const gates = [deferred(), deferred()];
  let running = 0;
  let maxRunning = 0;
  let call = 0;
  const { commands, ctx } = await setup({
    ensureInstalled: async () => {
      const gate = gates[call++];
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate?.promise;
      running -= 1;
    },
  });

  const starting = commands.get("mlx-start")!("qwen3_4b", ctx);
  await flush();
  await commands.get("mlx-stop")!("", ctx);
  const initing = commands.get("mlx-init")!("", ctx);
  await flush();
  gates[0].resolve();
  await flush();
  gates[1].resolve();
  await Promise.all([starting, initing]);

  assert.equal(maxRunning, 1);
  assert.equal(call, 2, "an upgrade install is not satisfied by a plain one");
});

test("session_shutdown while the runtime installs: the server is never started afterwards", async () => {
  const gate = deferred();
  const { server, handlers, commands, ctx } = await setup({
    ensureInstalled: () => gate.promise,
    sleep: never,
  });

  const starting = commands.get("mlx-start")!("qwen3_4b", ctx);
  await flush();
  await handlers.get("session_shutdown")!();
  gate.resolve();
  await starting;

  assert.deepEqual(server.startCalls, []);
});

// WR-01: a failed start must not leave a stale spinner frame in the status bar.
test("a failed start replaces the last spinner frame in the status bar with a failed status", async () => {
  const { commands, ctx, statuses } = await setup({
    server: {
      start: async (_model, onEvent) => {
        onEvent?.({ type: "launched" });
        throw new Error("boom");
      },
    },
  });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.ok(statuses.some((s) => s.text?.startsWith("[")), "premise: a spinner frame was shown");
  assert.equal(lastStatus(statuses), "mlx: failed");
});

test("a failed install also leaves a failed status rather than an empty one", async () => {
  const { commands, ctx, statuses } = await setup({
    ensureInstalled: async () => {
      throw new Error("no python");
    },
  });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.equal(lastStatus(statuses), "mlx: failed");
});

// WR-06: discovered model ids come from the local server and are rendered as the model name.
test("a discovered model id with control characters is cleaned in the display name only", async () => {
  const hostile = "org/model\u001b]0;pwned\u0007\u009b31m";
  const { providerCalls } = await setup({ discovered: [hostile] });

  const [model] = providerCalls.at(-1)!.config.models as Array<{ id: string; name: string }>;

  assert.equal(model.id, hostile, "the id is what the server expects and stays as discovered");
  assert.doesNotMatch(model.name, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(model.name, /^org\/model/);
});

// ---- a refused start has no side effects, and the corrected file is read on the next start (D-05, D-06) ----

const warnings = (notes: Note[]) => notes.filter((n) => n.type === "warning").map((n) => n.message);

test("a global file with several problems is refused with one report and nothing else happens", async () => {
  const settings = freshSettings({});
  writeFileSync(settings.globalConfigPath, '{"server":{"port":99999,"logLevel":"debug","hots":"x"}}');
  const { server, installCalls, commands, providerCalls, ctx, notes, statuses, widgets } = await setup({ settings });
  const providersBefore = providerCalls.length;

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(notes, [
    {
      type: "error",
      message: [
        "mlx-start failed: invalid configuration",
        "  server.port (global config.json): 99999 is not an integer from 1 to 65535 (flag --port)",
        '  server.logLevel (global config.json): "debug" must be one of DEBUG, INFO, WARNING, ERROR, CRITICAL (flag --log-level)',
        "  server.hots (global config.json): unknown key (did you mean server.host?)",
      ].join("\n"),
    },
  ]);
  assert.equal(installCalls.length, 0, "the runtime installer was not called");
  assert.deepEqual(server.startCalls, [], "no server was started");
  assert.equal(providerCalls.length, providersBefore, "no provider was registered");
  assert.deepEqual(widgets, [], "no progress widget was shown");
  assert.deepEqual(statuses, [], "no status was set");
});

test("a global file that is not valid JSON is refused with one error naming the file", async () => {
  const settings = freshSettings({});
  writeFileSync(settings.globalConfigPath, "{ nope");
  const { server, installCalls, commands, ctx, notes } = await setup({ settings });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  const found = errors(notes);
  assert.equal(found.length, 1);
  assert.ok(
    found[0].startsWith("mlx-start failed: invalid configuration\n  global config.json: is not valid JSON ("),
    found[0],
  );
  assert.equal(notes.length, 1, "nothing but the error was shown");
  assert.equal(installCalls.length, 0);
  assert.deepEqual(server.startCalls, []);
});

test("nothing about a refused start is remembered: the corrected file is used by the next start", async () => {
  const preset = MODEL_PRESETS.find((p) => p.key === "qwen3_4b")!;
  const settings = freshSettings({});
  writeFileSync(settings.globalConfigPath, '{"server":{"port":"9000"}}');
  const { server, commands, ctx, notes, statuses } = await setup({ settings });

  await commands.get("mlx-start")!("qwen3_4b", ctx);
  assert.equal(errors(notes).length, 1);
  assert.deepEqual(server.startCalls, []);

  writeFileSync(settings.globalConfigPath, '{"server":{"logLevel":"INFO"}}');
  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.equal(errors(notes).length, 1, "no further error");
  assert.deepEqual(server.startCalls, [preset.modelId]);
  assert.equal(lastStatus(statuses), `mlx: running (${preset.modelId})`);
});

test("a missing global file is no error and nothing is created at its path", async () => {
  const settings = freshSettings({});
  const { server, commands, ctx, notes } = await setup({ settings });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(errors(notes), []);
  assert.equal(server.startCalls.length, 1);
  assert.equal(existsSync(settings.globalConfigPath), false);
});

test("an environment warning comes before the config error, and a second refused start does not repeat it", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_PORT: "abc" });
  writeFileSync(settings.globalConfigPath, '{"server":{"port":0}}');
  const { commands, ctx, notes } = await setup({ settings });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(
    notes.map((n) => n.type),
    ["warning", "error"],
  );
  assert.match(notes[0].message, /PI_MLX_MODELS_PORT/);
  assert.ok(notes[1].message.startsWith("mlx-start failed: invalid configuration\n  server.port (global config.json): 0 is not an integer"));

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.equal(warnings(notes).length, 1, "the warning is shown once");
  assert.equal(errors(notes).length, 2, "the refusal is shown on every refused start");
});

// ---- per-launch flags on /mlx-start and the pi flags (D-08 to D-12) ----

const QWEN = MODEL_PRESETS.find((p) => p.key === "qwen3_4b")!;
const startingNotes = (notes: Note[]) => notes.filter((n) => n.message.startsWith("Starting MLX server with")).map((n) => n.message);
const PI_FLAG_NAMES = ["mlx-model", "mlx-port", "mlx-host", "mlx-log-level"];

/** What a refused start must leave behind: no install, no spawn, and no provider beyond the initial one. */
function assertNothingHappened(h: Awaited<ReturnType<typeof setup>>) {
  assert.equal(h.installCalls.length, 0, "the runtime installer was not called");
  assert.deepEqual(h.server.startCalls, [], "no server was started");
  assert.equal(h.providerCalls.length, 1, "no provider beyond the initial one");
  assert.deepEqual(h.widgets, [], "no progress widget was shown");
}

test("the factory registers the four pi flags as string flags with no default, before its first await, and reads none", async () => {
  const fakePi = makeFakePi();
  const extension = createExtension({
    server: makeFakeServer(),
    ensureInstalled: async () => {},
    discoverModelIds: async () => [],
    settings: freshSettings({}),
  });

  const running = extension(fakePi.pi);
  assert.deepEqual(
    fakePi.flags.map((flag) => flag.name),
    PI_FLAG_NAMES,
    "registered synchronously, before the factory's first await",
  );
  await running;

  for (const flag of fakePi.flags) {
    assert.equal(flag.options.type, "string", flag.name);
    assert.ok(!("default" in flag.options), `${flag.name} must not carry a default`);
    assert.ok((flag.options.description ?? "").length > 10, `${flag.name} needs a description`);
  }
  assert.equal(fakePi.getFlagCalls(), 0, "no flag value is read while the factory runs");
});

test("mlx-start with a model and flags launches that model on those flags, and the message and provider agree", async () => {
  const { server, commands, ctx, notes, providerCalls } = await setup();

  await commands.get("mlx-start")!("qwen3_4b --port 9000 --log-level DEBUG", ctx);

  assert.deepEqual(server.startCalls, [QWEN.modelId]);
  assert.deepEqual(server.launches, [
    { address: { host: "127.0.0.1", port: 9000 }, baseUrl: "http://127.0.0.1:9000/v1", extraArgs: ["--log-level=DEBUG"] },
  ]);
  assert.deepEqual(startingNotes(notes), [
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --port 9000 (/mlx-start), --log-level DEBUG (/mlx-start)`,
  ]);
  assert.ok(providerCalls.length > 1);
  assert.deepEqual(
    providerCalls.slice(1).map((call) => call.config.baseUrl),
    providerCalls.slice(1).map(() => "http://127.0.0.1:9000/v1"),
  );
});

test("mlx-start accepts --host and --allowed-origins as typed, in the flag spelling of mlx-lm", async () => {
  const { server, commands, ctx } = await setup();

  await commands.get("mlx-start")!("--allowed-origins=http://a.test,http://b.test --host localhost org/some-model", ctx);

  assert.deepEqual(server.startCalls, ["org/some-model"]);
  assert.deepEqual(server.launches[0]?.address, { host: "localhost", port: 8080 });
  assert.deepEqual(server.launches[0]?.extraArgs, ["--allowed-origins=http://a.test,http://b.test"]);
});

test("pi flags are read on every start and sit between the command line and the environment", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_PORT: "9200" });
  writeFileSync(settings.globalConfigPath, '{"server":{"port":9300}}');
  const h = await setup({ settings });
  const start = (input: string) => h.commands.get("mlx-start")!(input, h.ctx);
  const lastPort = () => h.server.launches.at(-1)?.address.port;
  const lastFlagsLine = () => startingNotes(h.notes).at(-1)?.split("\n")[1];

  h.setFlag("mlx-port", "9100");
  await start("qwen3_4b");
  assert.equal(lastPort(), 9100);
  assert.equal(lastFlagsLine(), "flags: --port 9100 (pi flag --mlx-port)");

  await start("qwen3_4b --port 9000");
  assert.equal(lastPort(), 9000, "the command line beats the pi flag");
  assert.equal(lastFlagsLine(), "flags: --port 9000 (/mlx-start)");

  h.setFlag("mlx-port", undefined);
  await start("qwen3_4b");
  assert.equal(lastPort(), 9200, "without the pi flag the environment wins");
  assert.equal(lastFlagsLine(), "flags: --port 9200 (env PI_MLX_MODELS_PORT)");

  delete settings.env.PI_MLX_MODELS_PORT;
  await start("qwen3_4b");
  assert.equal(lastPort(), 9300, "without the environment the file wins");
  assert.equal(lastFlagsLine(), "flags: --port 9300 (global file)");
  assert.ok(h.getFlagCalls() >= 5, "every start reads the flags again");
});

test("the pi flags for host and log level reach the launch", async () => {
  const { server, commands, ctx, notes, setFlag } = await setup();
  setFlag("mlx-host", "localhost");
  setFlag("mlx-log-level", "WARNING");

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(server.launches[0]?.address, { host: "localhost", port: 8080 });
  assert.deepEqual(server.launches[0]?.extraArgs, ["--log-level=WARNING"]);
  assert.match(startingNotes(notes)[0], /\nflags: --host localhost \(pi flag --mlx-host\), --log-level WARNING \(pi flag --mlx-log-level\)$/);
});

test("a pi flag that has no text, or is not text, is ignored", async () => {
  const { server, commands, ctx, setFlag } = await setup();
  setFlag("mlx-port", "   ");
  setFlag("mlx-host", true);
  setFlag("mlx-log-level", "");

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(server.launches, [{ address: { host: "127.0.0.1", port: 8080 }, baseUrl: "http://127.0.0.1:8080/v1", extraArgs: [] }]);
});

test("a bare mlx-start with --mlx-model set opens no picker and launches that model", async () => {
  let picks = 0;
  const { server, commands, ctx, notes, setFlag } = await setup({
    select: (options) => {
      picks += 1;
      return options[0];
    },
  });
  setFlag("mlx-model", "qwen3_4b");

  await commands.get("mlx-start")!("", ctx);

  assert.equal(picks, 0, "the picker must not open");
  assert.deepEqual(server.startCalls, [QWEN.modelId]);
  assert.match(startingNotes(notes)[0], /^Starting MLX server with .* \(preset: qwen3_4b\)\.\.\.$/);
});

test("a model typed on the command line beats --mlx-model", async () => {
  const { server, commands, ctx, setFlag } = await setup();
  setFlag("mlx-model", "qwen3_4b");

  await commands.get("mlx-start")!("smollm3_3b --log-level DEBUG", ctx);

  assert.deepEqual(server.startCalls, [MODEL_PRESETS.find((p) => p.key === "smollm3_3b")!.modelId]);
});

test("--mlx-model with a bad value ends with the usual error and starts nothing", async () => {
  const h = await setup();
  h.setFlag("mlx-model", "9");

  await h.commands.get("mlx-start")!("", h.ctx);

  const [message] = errors(h.notes);
  assert.ok(message?.startsWith("mlx-start failed:"), message);
  assert.match(message, /out of range/);
  assertNothingHappened(h);
});

test("--mlx-model alone never starts anything, not even when pi runs the factory with it already set", async () => {
  const server = makeFakeServer();
  const installCalls: unknown[] = [];
  const fakePi = makeFakePi();
  fakePi.setFlag("mlx-model", "qwen3_4b");
  const extension = createExtension({
    server,
    ensureInstalled: (async (opts?: unknown) => {
      installCalls.push(opts);
    }) as any,
    discoverModelIds: async () => [],
    settings: freshSettings({}),
  });

  await extension(fakePi.pi);

  assert.deepEqual(server.startCalls, []);
  assert.equal(installCalls.length, 0);
  assert.equal(fakePi.getFlagCalls(), 0);
});

test("a blank --mlx-model is the same as none: the picker opens", async () => {
  let picks = 0;
  const { server, commands, ctx, setFlag } = await setup({
    select: (options) => {
      picks += 1;
      return options[3];
    },
  });
  setFlag("mlx-model", "   ");

  await commands.get("mlx-start")!("", ctx);

  assert.equal(picks, 1);
  assert.deepEqual(server.startCalls, [QWEN.modelId]);
});

test("mlx-start with only flags opens the picker and launches the picked preset on those flags", async () => {
  let picks = 0;
  const { server, commands, ctx } = await setup({
    select: (options) => {
      picks += 1;
      return options[3];
    },
  });

  await commands.get("mlx-start")!("--log-level DEBUG", ctx);

  assert.equal(picks, 1);
  assert.deepEqual(server.startCalls, [QWEN.modelId]);
  assert.deepEqual(server.launches[0]?.extraArgs, ["--log-level=DEBUG"]);
});

test("a configured default model does not skip the picker", async () => {
  let picks = 0;
  const settings = freshSettings({});
  writeFileSync(settings.globalConfigPath, '{"defaultModel":"smollm3_3b"}');
  const { server, commands, ctx } = await setup({
    settings,
    select: (options) => {
      picks += 1;
      return options[3];
    },
  });

  await commands.get("mlx-start")!("--log-level DEBUG", ctx);

  assert.equal(picks, 1, "the picker still opens");
  assert.deepEqual(server.startCalls, [QWEN.modelId]);
});

test("a cancelled picker with flags typed notifies and starts nothing", async () => {
  const h = await setup({ select: () => undefined });

  await h.commands.get("mlx-start")!("--port 9000", h.ctx);

  assert.deepEqual(h.notes, [{ message: "Preset selection cancelled.", type: "info" }]);
  assertNothingHappened(h);
});

test("overrides apply to that launch only: the next start has the defaults and no flags line", async () => {
  const { server, commands, ctx, notes, setFlag } = await setup();

  await commands.get("mlx-start")!("qwen3_4b --port 9000 --log-level DEBUG", ctx);
  assert.equal(server.launches[0]?.address.port, 9000, "premise: the first launch used the typed flags");
  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(server.launches.at(-1), { address: { host: "127.0.0.1", port: 8080 }, baseUrl: "http://127.0.0.1:8080/v1", extraArgs: [] });
  assert.equal(startingNotes(notes).at(-1), `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...`);

  // A pi flag is read live: once it is cleared, nothing about it is remembered either.
  setFlag("mlx-port", "9100");
  await commands.get("mlx-start")!("qwen3_4b", ctx);
  setFlag("mlx-port", undefined);
  await commands.get("mlx-start")!("qwen3_4b", ctx);
  assert.equal(server.launches.at(-1)?.address.port, 8080);
});

test("mlx-start with an unknown flag is refused, with the valid flags listed, and nothing happens", async () => {
  const h = await setup();

  await h.commands.get("mlx-start")!("--bogus 1", h.ctx);

  assert.deepEqual(errors(h.notes), ["mlx-start failed: unknown flag --bogus (valid flags: --host, --port, --allowed-origins, --log-level)"]);
  assert.equal(h.notes.length, 1);
  assertNothingHappened(h);
});

test("mlx-start with a flag that has no value is refused and nothing happens", async () => {
  const h = await setup();

  await h.commands.get("mlx-start")!("--port", h.ctx);

  assert.deepEqual(errors(h.notes), ["mlx-start failed: --port needs a value"]);
  assertNothingHappened(h);
});

test("mlx-start with a second model, or a repeated flag, is refused and nothing happens", async () => {
  const h = await setup();

  await h.commands.get("mlx-start")!("qwen3_4b other", h.ctx);
  await h.commands.get("mlx-start")!("--port 1 --port 2", h.ctx);
  await h.commands.get("mlx-start")!("--port 'unterminated", h.ctx);

  assert.deepEqual(errors(h.notes), [
    "mlx-start failed: unexpected extra argument other (only one model is accepted)",
    "mlx-start failed: --port was given twice",
    "mlx-start failed: unterminated quote in the /mlx-start arguments",
  ]);
  assertNothingHappened(h);
});

test("a pi flag spelling typed on the command line is an unknown flag, not a way to set a pi flag", async () => {
  const h = await setup();

  await h.commands.get("mlx-start")!("qwen3_4b --mlx-port 9", h.ctx);

  assert.match(errors(h.notes)[0], /^mlx-start failed: unknown flag --mlx-port /);
  assertNothingHappened(h);
});

test("a bad value on the command line is refused with the report, labelled with the flag", async () => {
  const h = await setup();

  await h.commands.get("mlx-start")!("qwen3_4b --port abc", h.ctx);

  assert.deepEqual(errors(h.notes), [
    'mlx-start failed: invalid configuration\n  server.port (/mlx-start --port): "abc" is not an integer from 1 to 65535',
  ]);
  assertNothingHappened(h);
});

test("a bad pi flag value is refused with the report, labelled with the pi flag", async () => {
  const h = await setup();
  h.setFlag("mlx-port", "abc");

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(errors(h.notes), [
    'mlx-start failed: invalid configuration\n  server.port (pi flag --mlx-port): "abc" is not an integer from 1 to 65535',
  ]);
  assertNothingHappened(h);
});

test("problems from the command line, a pi flag and the file are all in the one report", async () => {
  const settings = freshSettings({});
  writeFileSync(settings.globalConfigPath, '{"server":{"logLevel":"loud"}}');
  const h = await setup({ settings });
  h.setFlag("mlx-host", "-x");

  await h.commands.get("mlx-start")!("qwen3_4b --port 0", h.ctx);

  assert.equal(errors(h.notes).length, 1);
  const lines = errors(h.notes)[0].split("\n");
  assert.equal(lines.length, 4, errors(h.notes)[0]);
  assert.ok(lines[1].startsWith("  server.port (/mlx-start --port)"), lines[1]);
  assert.ok(lines[2].startsWith("  server.host (pi flag --mlx-host)"), lines[2]);
  assert.ok(lines[3].startsWith("  server.logLevel (global config.json)"), lines[3]);
  assertNothingHappened(h);
});

test("a syntax error in the arguments is reported alone; any other refusal still shows config warnings first", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_PORT: "abc" });
  const h = await setup({ settings });

  await h.commands.get("mlx-start")!("--bogus", h.ctx);
  assert.deepEqual(
    h.notes.map((n) => n.type),
    ["error"],
    "no configuration warning for a start that was refused on its arguments",
  );

  await h.commands.get("mlx-start")!("qwen3_4b --port abc", h.ctx);
  assert.deepEqual(
    h.notes.map((n) => n.type),
    ["error", "warning", "error"],
  );
  assert.match(h.notes[1].message, /PI_MLX_MODELS_PORT/);
});

test("arguments longer than 8192 characters are refused before anything else", async () => {
  const h = await setup();

  await h.commands.get("mlx-start")!(`qwen3_4b ${"x".repeat(9000)}`, h.ctx);

  assert.deepEqual(errors(h.notes), ["mlx-start failed: the /mlx-start arguments are longer than 8192 characters"]);
  assertNothingHappened(h);
});

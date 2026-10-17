import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_ID } from "./config.js";
import { createExtension } from "./index.js";
import { MODEL_PRESETS } from "./presets.js";
import type { MlxServer, ServerEvent } from "./server.js";
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
  let stopCalls = 0;
  const server: MlxServer & { startCalls: string[]; readonly stopCalls: number } = {
    get running() {
      return startCalls.length > 0;
    },
    startCalls,
    get stopCalls() {
      return stopCalls;
    },
    async start(model, onEvent) {
      startCalls.push(model);
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
    settings: freshSettings(options.env ?? {}),
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

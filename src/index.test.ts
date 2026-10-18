import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_ID, VENV_PYTHON } from "./config.js";
import { createExtension } from "./index.js";
import { parseHelpFlags, type ProbeResult, type VersionResult } from "./flagprobe.js";
import { MODEL_PRESETS } from "./presets.js";
import { ensureInstalled, type RuntimeHost } from "./runtime.js";
import { SETTINGS, initFlagSpecs } from "./settings.js";
import type { LaunchSpec, MlxServer, ServerEvent } from "./server.js";
import type { ModelConfigRead, ReadModelConfig } from "./modelinfo.js";
import { makeCtx, makeFakeModelConfig, makeFakePi, type CtxOptions } from "./testkit.js";

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
    readModelConfig: makeFakeModelConfig().read,
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

/** A probe result for an install that lists every flag the schema can pass. */
const ALL_SUPPORTED: ProbeResult = {
  ok: true,
  version: "0.32.2",
  flags: new Set(SETTINGS.flatMap((row) => (row.mlxFlag === undefined ? [] : [row.mlxFlag]))),
};

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
    /** Options of the fake ctx: the working directory, whether a UI is attached, the answer dialogs give. */
    ctx?: CtxOptions;
    /** What the flag probe answers; default: an install that lists every flag of the schema. */
    probe?: () => Promise<ProbeResult>;
    /** What the cheap installed-version query answers; default: mlx-lm 0.32.2. */
    installed?: () => Promise<VersionResult>;
    /** What reads a model's config.json; default: a stand-in answering a 131072 window, so no test reaches the real cache. */
    readModelConfig?: ReadModelConfig;
  } = {},
) {
  const fakeModelConfig = makeFakeModelConfig();
  const server = makeFakeServer(options.server);
  const installCalls: any[] = [];
  /** How many times the extension asked which flags the install supports. */
  let probeCalls = 0;
  /** How many times the extension asked which mlx-lm version is installed. */
  let installedCalls = 0;
  /** How many times the extension asked the server which models it reports. */
  let discoveryCalls = 0;
  const fakePi = makeFakePi();
  const fakeCtx = makeCtx(options.select, options.ctx);
  const extension = createExtension({
    server,
    ensureInstalled: (async (opts?: any) => {
      installCalls.push(opts);
      await options.ensureInstalled?.(opts);
    }) as any,
    discoverModelIds: async () => {
      discoveryCalls += 1;
      return options.discovered ?? [];
    },
    readModelConfig: options.readModelConfig ?? fakeModelConfig.read,
    settings: options.settings ?? freshSettings(options.env ?? {}),
    probeFlags: async () => {
      probeCalls += 1;
      return options.probe ? options.probe() : ALL_SUPPORTED;
    },
    installedVersion: async () => {
      installedCalls += 1;
      return options.installed ? options.installed() : { ok: true, version: "0.32.2" };
    },
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  await extension(fakePi.pi);
  return {
    server,
    installCalls,
    ...fakePi,
    ...fakeCtx,
    get probeCalls() {
      return probeCalls;
    },
    get installedCalls() {
      return installedCalls;
    },
    get discoveryCalls() {
      return discoveryCalls;
    },
    /** The calls the default stand-in reader received: the model id and whether the Hub was allowed. */
    readCalls: fakeModelConfig.calls,
  };
}

const errors =(notes: Note[]) => notes.filter((n) => n.type === "error").map((n) => n.message);

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
  // Only the all-models list shows ids the server reports without their being launched (MOD-04, D-12).
  const settings = freshSettings({});
  writeFileSync(settings.globalConfigPath, '{"provider":{"listAllModels":true}}');
  const { commands, ctx, providerCalls } = await setup({ discovered: [hostile], settings });
  await commands.get("mlx-start")!("qwen3_4b", ctx);

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
    readModelConfig: makeFakeModelConfig().read,
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

test("mlx-start passes the five performance flags in mlx-lm spelling, in schema order, each labelled with the command", async () => {
  const { server, commands, ctx, notes } = await setup();

  await commands.get("mlx-start")!(
    "qwen3_4b --decode-concurrency 2 --prompt-concurrency=4 --prefill-step-size 1024 --prompt-cache-size 5 --prompt-cache-bytes 8589934592",
    ctx,
  );

  assert.deepEqual(server.startCalls, [QWEN.modelId]);
  assert.deepEqual(server.launches[0]?.extraArgs, [
    "--decode-concurrency=2",
    "--prompt-concurrency=4",
    "--prefill-step-size=1024",
    "--prompt-cache-size=5",
    "--prompt-cache-bytes=8589934592",
  ]);
  assert.deepEqual(startingNotes(notes), [
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --decode-concurrency 2 (/mlx-start), --prompt-concurrency 4 (/mlx-start), --prefill-step-size 1024 (/mlx-start), --prompt-cache-size 5 (/mlx-start), --prompt-cache-bytes 8589934592 (/mlx-start)`,
  ]);
});

test("mlx-start with a prefill step size of 0 is refused, naming the key and the flag, and nothing happens", async () => {
  const h = await setup();

  await h.commands.get("mlx-start")!("qwen3_4b --prefill-step-size 0", h.ctx);

  const [message] = errors(h.notes);
  assert.ok(message?.startsWith("mlx-start failed: invalid configuration"), message);
  assert.ok(message.includes("server.prefillStepSize (/mlx-start --prefill-step-size)"), message);
  assert.equal(errors(h.notes).length, 1);
  assertNothingHappened(h);
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
    readModelConfig: makeFakeModelConfig().read,
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

  assert.deepEqual(errors(h.notes), [
    "mlx-start failed: unknown flag --bogus (valid flags: --host, --port, --allowed-origins, --log-level, --trust-remote-code, --decode-concurrency, --prompt-concurrency, --prefill-step-size, --prompt-cache-size, --prompt-cache-bytes, --kv-bits, --kv-group-size, --quantized-kv-start, --adapter-path, --draft-model, --num-draft-tokens, --chat-template, --use-default-chat-template, --chat-template-args, --profile)",
  ]);
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

// ---- the project file layer and the trust gate (plan 02-05: CFG-01, CFG-06) ----

type Harness = Awaited<ReturnType<typeof setup>>;

const newCwd = () => mkdtempSync(join(tmpdir(), "pi-mlx-cwd-"));
const writeProject = (cwd: string, content: unknown) => {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-mlx-models.json"), typeof content === "string" ? content : JSON.stringify(content));
};
const writeGlobal = (settings: ReturnType<typeof freshSettings>, content: unknown) =>
  writeFileSync(settings.globalConfigPath, JSON.stringify(content));
const infos = (notes: Note[]) => notes.filter((n) => n.type === "info").map((n) => n.message);

/** Replace the answers the fake confirm gives, one per dialog in order; a dialog beyond the list is declined. */
function scriptConfirms(h: Harness, answers: Array<boolean | Promise<boolean>>) {
  h.ctx.ui.confirm = async (title: string, message: string) => {
    h.confirms.push({ title, message });
    return (await answers.shift()) ?? false;
  };
}

const TRUST_TITLE = "Allow remote code from the model repository?";
const HOST_TITLE = "Listen on a non-loopback address?";
const URL_TITLE = "Send prompts to a non-loopback address?";
/** Spelled out here, not imported, so changing the production sentence is a deliberate edit of two places. */
const SAFE_CHOICE_NOTE = "Yes allows this. No or Esc cancels. Check which option is highlighted before pressing Enter.";
const refusalText = (settings: ReturnType<typeof freshSettings>, lines: string[]) =>
  [
    "mlx-start failed: .pi/pi-mlx-models.json cannot enable settings that run code or open the network:",
    ...lines,
    `Move them to ${settings.globalConfigPath}; starting then asks for confirmation.`,
  ].join("\n");

test("the project file is read from the working directory only: a file in a parent directory is ignored", async () => {
  const parent = newCwd();
  writeProject(parent, { server: { logLevel: "DEBUG" } });
  const cwd = join(parent, "child");
  mkdirSync(cwd);
  const h = await setup({ ctx: { cwd } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(errors(h.notes), []);
  assert.deepEqual(h.server.launches[0]?.extraArgs, []);
  assert.deepEqual(startingNotes(h.notes), [`Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...`]);
});

test("the project file in the working directory is read on every start and labelled as such", async () => {
  const cwd = newCwd();
  const h = await setup({ ctx: { cwd } });
  const start = () => h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  await start();
  assert.deepEqual(h.server.launches[0]?.extraArgs, [], "no file yet: absent is not an error");
  writeProject(cwd, { server: { logLevel: "DEBUG" } });
  await start();

  assert.deepEqual(h.server.launches[1]?.extraArgs, ["--log-level=DEBUG"]);
  assert.equal(startingNotes(h.notes)[1].split("\n")[1], "flags: --log-level DEBUG (project file)");
  assert.deepEqual(errors(h.notes), []);
});

test("the project value beats the global file and loses to the environment, a pi flag and a /mlx-start flag", async () => {
  const cwd = newCwd();
  writeProject(cwd, { server: { port: 9301, logLevel: "DEBUG" } });
  const settings = freshSettings({});
  writeGlobal(settings, { server: { port: 9400, logLevel: "INFO" } });
  const h = await setup({ settings, ctx: { cwd } });
  const start = (input: string) => h.commands.get("mlx-start")!(input, h.ctx);
  const last = () => h.server.launches.at(-1)!;

  await start("qwen3_4b");
  assert.equal(last().address.port, 9301, "project beats global");
  assert.deepEqual(last().extraArgs, ["--log-level=DEBUG"]);

  h.setFlag("mlx-log-level", "ERROR");
  await start("qwen3_4b");
  assert.deepEqual(last().extraArgs, ["--log-level=ERROR"], "a pi flag beats the project file");

  await start("qwen3_4b --log-level WARNING --port 9500");
  assert.deepEqual(last().extraArgs, ["--log-level=WARNING"], "a /mlx-start flag beats a pi flag");
  assert.equal(last().address.port, 9500);
});

test("the environment beats the project file", async () => {
  const cwd = newCwd();
  writeProject(cwd, { server: { port: 9301 } });
  const h = await setup({ env: { PI_MLX_MODELS_PORT: "9200" }, ctx: { cwd } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.equal(h.server.launches[0]?.address.port, 9200);
});

test("a project baseUrl that does not match the launch address warns and names the project file", async () => {
  const cwd = newCwd();
  writeProject(cwd, { baseUrl: "http://localhost:9999/v1" });
  const h = await setup({ ctx: { cwd } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  const [warning] = warnings(h.notes);
  assert.ok(warning?.startsWith("baseUrl in project .pi/pi-mlx-models.json points at localhost:9999"), warning);
  assert.equal(h.server.startCalls.length, 1, "a mismatch warns and does not refuse");
  assert.equal(h.confirms.length, 0, "a loopback project base URL needs no confirm");
});

test("an invalid project file is refused with the usual report naming it, and nothing happens", async () => {
  const cwd = newCwd();
  writeProject(cwd, { server: { port: 99999 } });
  const h = await setup({ ctx: { cwd } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(errors(h.notes), [
    "mlx-start failed: invalid configuration\n  server.port (project .pi/pi-mlx-models.json): 99999 is not an integer from 1 to 65535 (flag --port)",
  ]);
  assertNothingHappened(h);
});

const REFUSED_PROJECTS: Array<[string, unknown, string[]]> = [
  ["trustRemoteCode", { server: { trustRemoteCode: true } }, ["  server.trustRemoteCode: lets the model repository run Python code"]],
  ["host 0.0.0.0", { server: { host: "0.0.0.0" } }, ["  server.host (0.0.0.0): listens on a non-loopback address"]],
  ["host ::", { server: { host: "::" } }, ["  server.host (::): listens on a non-loopback address"]],
  ["host example.test", { server: { host: "example.test" } }, ["  server.host (example.test): listens on a non-loopback address"]],
  [
    "a remote baseUrl",
    { baseUrl: "http://example.test:8080/v1" },
    ["  baseUrl (http://example.test:8080/v1): sends prompts to a non-loopback address"],
  ],
  [
    "all three at once",
    { baseUrl: "http://example.test/v1", server: { host: "0.0.0.0", trustRemoteCode: true } },
    [
      "  server.trustRemoteCode: lets the model repository run Python code",
      "  server.host (0.0.0.0): listens on a non-loopback address",
      "  baseUrl (http://example.test/v1): sends prompts to a non-loopback address",
    ],
  ],
];

for (const [name, project, lines] of REFUSED_PROJECTS) {
  test(`a project file with ${name} is refused with one message and no side effect, and no dialog is offered`, async () => {
    const cwd = newCwd();
    writeProject(cwd, project);
    const settings = freshSettings({});
    const h = await setup({ settings, ctx: { cwd } });

    await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

    assert.deepEqual(
      h.notes.filter((n) => n.type !== "warning"),
      [{ type: "error", message: refusalText(settings, lines) }],
    );
    assert.equal(h.confirms.length, 0, "no prompt can override a project file");
    assertNothingHappened(h);
    assert.deepEqual(h.statuses, []);
  });
}

// GAP-01 (manual UAT): a top-level key written inside server was reported with a did-you-mean that repeated
// the name the user typed. Expected strings are written out here, not built from settings.ts.
const MISPLACED_PROJECTS: ReadonlyArray<[string, unknown, string[]]> = [
  [
    "baseUrl inside server (the UAT file)",
    { server: { baseUrl: "http://example.com:8080/v1" } },
    ['server.baseUrl (project .pi/pi-mlx-models.json): unknown key (baseUrl is a top-level key, not part of "server")'],
  ],
  [
    "defaultModel inside server",
    { server: { defaultModel: "org/m" } },
    ['server.defaultModel (project .pi/pi-mlx-models.json): unknown key (defaultModel is a top-level key, not part of "server")'],
  ],
  [
    "baseUrl and defaultModel both inside server",
    { server: { baseUrl: "http://example.com:8080/v1", defaultModel: "org/m" } },
    [
      'server.baseUrl (project .pi/pi-mlx-models.json): unknown key (baseUrl is a top-level key, not part of "server")',
      'server.defaultModel (project .pi/pi-mlx-models.json): unknown key (defaultModel is a top-level key, not part of "server")',
    ],
  ],
];

for (const [name, project, lines] of MISPLACED_PROJECTS) {
  test(`a project file with ${name} is refused as one error that says where the key lives, and nothing runs`, async () => {
    const cwd = newCwd();
    writeProject(cwd, project);
    const h = await setup({ ctx: { cwd } });

    await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

    assert.deepEqual(errors(h.notes), [["mlx-start failed: invalid configuration", ...lines.map((line) => `  ${line}`)].join("\n")]);
    assert.equal(h.confirms.length, 0, "no dialog is asked for an invalid file");
    assertNothingHappened(h);
  });
}

test("a project file asking for something risky is refused even for a start that names a model, a picker choice or flags", async () => {
  const cwd = newCwd();
  writeProject(cwd, { server: { trustRemoteCode: true } });
  const h = await setup({ ctx: { cwd } });

  await h.commands.get("mlx-start")!("org/some-model --port 9000", h.ctx);
  await h.commands.get("mlx-start")!("", h.ctx);

  assert.equal(errors(h.notes).length, 2, "the picker is never even opened for the second");
  assert.equal(h.confirms.length, 0);
  assertNothingHappened(h);
});

test("an environment override of a risky project value does not launder it", async () => {
  const cwd = newCwd();
  writeProject(cwd, { server: { host: "0.0.0.0" } });
  const settings = freshSettings({ PI_MLX_MODELS_HOST: "127.0.0.1" });
  const h = await setup({ settings, ctx: { cwd } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(h.notes, [{ type: "error", message: refusalText(settings, ["  server.host (0.0.0.0): listens on a non-loopback address"]) }]);
  assertNothingHappened(h);
});

test("a flag on /mlx-start does not launder a risky project value either", async () => {
  const cwd = newCwd();
  writeProject(cwd, { server: { trustRemoteCode: true } });
  const h = await setup({ ctx: { cwd } });

  await h.commands.get("mlx-start")!("qwen3_4b --trust-remote-code", h.ctx);

  assert.equal(errors(h.notes).length, 1);
  assert.ok(errors(h.notes)[0].includes("server.trustRemoteCode: lets the model repository run Python code"));
  assert.equal(h.confirms.length, 0);
  assertNothingHappened(h);
});

test("loopback project values and trustRemoteCode false launch normally with no dialog", async () => {
  for (const project of [
    { server: { host: "localhost" } },
    { server: { host: "127.0.0.1" } },
    { server: { host: "::1" } },
    { server: { trustRemoteCode: false } },
    { baseUrl: "http://localhost:8080/v1" },
  ]) {
    const cwd = newCwd();
    writeProject(cwd, project);
    const h = await setup({ ctx: { cwd } });

    await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

    assert.equal(h.server.startCalls.length, 1, JSON.stringify(project));
    assert.deepEqual(errors(h.notes), [], JSON.stringify(project));
    assert.equal(h.confirms.length, 0, JSON.stringify(project));
  }
});

test("trustRemoteCode in the global file asks once per start, names its source, and passes the bare flag on", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings });
  const start = () => h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  await start();

  assert.deepEqual(h.confirms, [
    {
      title: TRUST_TITLE,
      message:
        "--trust-remote-code (from global file) lets the model repository run Python code on this machine. Only continue for repositories you trust." +
        `\n\n${SAFE_CHOICE_NOTE}`,
    },
  ]);
  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--trust-remote-code"]);
  assert.equal(startingNotes(h.notes)[0].split("\n")[1], "flags: --trust-remote-code (global file)");

  await start();

  assert.equal(h.confirms.length, 2, "nothing is remembered: the next start asks again");
  assert.equal(h.server.launches.length, 2);
});

test("declining the dialog reports a cancel and installs, spawns and registers nothing", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings, ctx: { confirm: false } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(h.notes, [{ type: "info", message: "mlx-start cancelled: --trust-remote-code was not confirmed." }]);
  assert.equal(h.confirms.length, 1);
  assertNothingHappened(h);
  assert.deepEqual(h.statuses, []);
});

test("a dialog that throws counts as declined", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings });
  h.ctx.ui.confirm = async () => {
    throw new Error("ui went away");
  };

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(h.notes, [{ type: "info", message: "mlx-start cancelled: --trust-remote-code was not confirmed." }]);
  assertNothingHappened(h);
});

test("without a UI a risky start is refused, the dialog is never asked, and there is no way around it", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_ALLOW_REMOTE: "1", PI_MLX_MODELS_TRUST_REMOTE_CODE: "true" });
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings, ctx: { hasUI: false } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(h.notes, [
    {
      type: "error",
      message: "mlx-start failed: --trust-remote-code needs interactive confirmation; run /mlx-start in an interactive pi session",
    },
  ]);
  assert.equal(h.confirms.length, 0);
  assertNothingHappened(h);
});

test("without a UI two risks are named together and the verb is plural", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_HOST: "0.0.0.0" });
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings, ctx: { hasUI: false } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(errors(h.notes), [
    "mlx-start failed: --trust-remote-code and listening on 0.0.0.0 need interactive confirmation; run /mlx-start in an interactive pi session",
  ]);
  assertNothingHappened(h);
});

test("three risks without a UI are joined with commas and one 'and'", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_HOST: "0.0.0.0" });
  writeGlobal(settings, { baseUrl: "http://example.test/v1", server: { trustRemoteCode: true } });
  const h = await setup({ settings, ctx: { hasUI: false } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(errors(h.notes), [
    "mlx-start failed: --trust-remote-code, listening on 0.0.0.0 and sending prompts to http://example.test/v1 need interactive confirmation; run /mlx-start in an interactive pi session",
  ]);
});

test("a start with no risk needs no UI", async () => {
  const h = await setup({ ctx: { hasUI: false } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.equal(h.server.startCalls.length, 1);
  assert.deepEqual(errors(h.notes), []);
});

const SOURCES: Array<[string, { env?: Record<string, string>; global?: unknown; input?: string; flag?: [string, string] }, string, string, string[]]> = [
  ["env PI_MLX_MODELS_HOST=0.0.0.0", { env: { PI_MLX_MODELS_HOST: "0.0.0.0" } }, HOST_TITLE, "(from env PI_MLX_MODELS_HOST)", []],
  ["/mlx-start --host 0.0.0.0", { input: "qwen3_4b --host 0.0.0.0" }, HOST_TITLE, "(from /mlx-start)", []],
  ["/mlx-start --trust-remote-code", { input: "qwen3_4b --trust-remote-code" }, TRUST_TITLE, "(from /mlx-start)", ["--trust-remote-code"]],
  ["pi flag --mlx-host ::", { flag: ["mlx-host", "::"] }, HOST_TITLE, "(from pi flag --mlx-host)", []],
  ["a remote baseUrl in the global file", { global: { baseUrl: "http://example.test/v1" } }, URL_TITLE, "(from global file)", []],
  [
    "a remote PI_MLX_MODELS_BASE_URL",
    { env: { PI_MLX_MODELS_BASE_URL: "https://example.test/v1" } },
    URL_TITLE,
    "(from env PI_MLX_MODELS_BASE_URL)",
    [],
  ],
  ["a non-loopback host in the global file", { global: { server: { host: "example.test" } } }, HOST_TITLE, "(from global file)", []],
];

for (const [name, source, title, label, extra] of SOURCES) {
  test(`${name} needs the same dialog, naming where it came from`, async () => {
    const settings = freshSettings(source.env ?? {});
    if (source.global !== undefined) writeGlobal(settings, source.global);
    const h = await setup({ settings });
    if (source.flag) h.setFlag(source.flag[0], source.flag[1]);

    await h.commands.get("mlx-start")!(source.input ?? "qwen3_4b", h.ctx);

    assert.equal(h.confirms.length, 1);
    assert.equal(h.confirms[0].title, title);
    assert.ok(h.confirms[0].message.includes(label), h.confirms[0].message);
    assert.ok(h.confirms[0].message.endsWith(`\n\n${SAFE_CHOICE_NOTE}`), h.confirms[0].message);
    assert.equal(h.server.startCalls.length, 1, "confirmed, so it launched");
    assert.deepEqual(h.server.launches[0]?.extraArgs, extra);
  });
}

test("declining a non-project risk from any source launches nothing", async () => {
  const h = await setup({ env: { PI_MLX_MODELS_HOST: "0.0.0.0" }, ctx: { confirm: false } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(infos(h.notes), ["mlx-start cancelled: listening on 0.0.0.0 was not confirmed."]);
  assertNothingHappened(h);
});

test("the host dialog shows an IPv6 address bracketed in front of the port, and the base URL dialog shows the URL", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_HOST: "::" });
  writeGlobal(settings, { baseUrl: "http://example.test:8080/v1" });
  const h = await setup({ settings, ctx: { confirm: false } });

  await h.commands.get("mlx-start")!("qwen3_4b --port 9000", h.ctx);

  assert.deepEqual(h.confirms, [
    {
      title: HOST_TITLE,
      message: "The MLX server will listen on [::]:9000 (from env PI_MLX_MODELS_HOST), reachable from your network. mlx_lm.server has no authentication." +
        `\n\n${SAFE_CHOICE_NOTE}`,
    },
  ]);
});

test("every trust dialog ends with the safe-choice sentence, exactly once", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_HOST: "0.0.0.0" });
  writeGlobal(settings, { baseUrl: "http://example.test:8080/v1", server: { trustRemoteCode: true } });
  const h = await setup({ settings });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(
    h.confirms.map((c) => c.title),
    [TRUST_TITLE, HOST_TITLE, URL_TITLE],
  );
  for (const { message } of h.confirms) {
    assert.ok(message.endsWith(`\n\n${SAFE_CHOICE_NOTE}`), message);
    assert.equal(message.split(SAFE_CHOICE_NOTE).length - 1, 1, message);
  }
});

test("a trust dialog is asked with exactly a title and a message: no options, timeout or signal", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings });
  const argCounts: number[] = [];
  h.ctx.ui.confirm = async (...args: unknown[]) => {
    argCounts.push(args.length);
    return true;
  };

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(argCounts, [2]);
  assert.equal(h.server.startCalls.length, 1, "confirmed, so it launched");
});

test("--trust-remote-code takes no value on /mlx-start", async () => {
  const h = await setup();

  await h.commands.get("mlx-start")!("qwen3_4b --trust-remote-code=true", h.ctx);

  assert.deepEqual(errors(h.notes), ["mlx-start failed: --trust-remote-code takes no value"]);
  assert.equal(h.confirms.length, 0);
  assertNothingHappened(h);
});

test("two risks ask two dialogs in the order trust, host, base URL; declining the first never asks the second", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_HOST: "0.0.0.0" });
  writeGlobal(settings, { baseUrl: "http://example.test:8080/v1", server: { trustRemoteCode: true } });
  const accepted = await setup({ settings });
  await accepted.commands.get("mlx-start")!("qwen3_4b", accepted.ctx);
  assert.deepEqual(
    accepted.confirms.map((c) => c.title),
    [TRUST_TITLE, HOST_TITLE, URL_TITLE],
  );
  assert.equal(accepted.server.startCalls.length, 1);

  const declinedFirst = await setup({ settings });
  scriptConfirms(declinedFirst, [false, true, true]);
  await declinedFirst.commands.get("mlx-start")!("qwen3_4b", declinedFirst.ctx);
  assert.deepEqual(
    declinedFirst.confirms.map((c) => c.title),
    [TRUST_TITLE],
  );
  assert.deepEqual(infos(declinedFirst.notes), ["mlx-start cancelled: --trust-remote-code was not confirmed."]);
  assertNothingHappened(declinedFirst);

  const declinedSecond = await setup({ settings });
  scriptConfirms(declinedSecond, [true, false, true]);
  await declinedSecond.commands.get("mlx-start")!("qwen3_4b", declinedSecond.ctx);
  assert.deepEqual(
    declinedSecond.confirms.map((c) => c.title),
    [TRUST_TITLE, HOST_TITLE],
  );
  assert.deepEqual(infos(declinedSecond.notes), ["mlx-start cancelled: listening on 0.0.0.0 was not confirmed."]);
  assertNothingHappened(declinedSecond);
});

test("loopback values in every layer need no dialog at all", async () => {
  const settings = freshSettings({ PI_MLX_MODELS_HOST: "127.0.0.1", PI_MLX_MODELS_BASE_URL: "http://localhost:8080/v1" });
  writeGlobal(settings, { server: { host: "::1", trustRemoteCode: false } });
  const h = await setup({ settings, ctx: { hasUI: false } });

  await h.commands.get("mlx-start")!("qwen3_4b --host localhost", h.ctx);

  assert.equal(h.confirms.length, 0);
  assert.equal(h.server.startCalls.length, 1);
});

test("the dialog comes after the model is chosen and before the install, the provider refresh and the spawn", async () => {
  const order: string[] = [];
  const settings = freshSettings({});
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({
    settings,
    select: (options) => {
      order.push("select");
      return options[0];
    },
    ensureInstalled: async () => {
      order.push("install");
    },
  });
  h.ctx.ui.confirm = async (title: string, message: string) => {
    h.confirms.push({ title, message });
    order.push(`confirm after ${h.providerCalls.length} provider call(s)`);
    return true;
  };

  await h.commands.get("mlx-start")!("", h.ctx);

  assert.deepEqual(order, ["select", "confirm after 1 provider call(s)", "install"]);
});

test("a bad model is reported before any dialog is asked", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings });

  await h.commands.get("mlx-start")!("9", h.ctx);

  assert.equal(errors(h.notes).length, 1);
  assert.equal(h.confirms.length, 0);
  assertNothingHappened(h);
});

test("a /mlx-stop while a dialog is open abandons the pending start quietly", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings });
  const answer = deferred<boolean>();
  scriptConfirms(h, [answer.promise]);

  const starting = h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  await flush();
  assert.equal(h.confirms.length, 1, "premise: the dialog is open");
  await h.commands.get("mlx-stop")!("", h.ctx);
  const marks = () => [h.notes.length, h.statuses.length, h.widgets.length, h.providerCalls.length];
  const before = marks();
  answer.resolve(true);
  await starting;

  assert.deepEqual(marks(), before, "no UI write and no provider registration after the stop");
  assert.deepEqual(h.server.startCalls, []);
  assert.equal(h.installCalls.length, 0);
});

test("a declined answer that arrives after a /mlx-stop is quiet too", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings });
  const answer = deferred<boolean>();
  scriptConfirms(h, [answer.promise]);

  const starting = h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  await flush();
  await h.commands.get("mlx-stop")!("", h.ctx);
  const notesBefore = h.notes.length;
  answer.resolve(false);
  await starting;

  assert.equal(h.notes.length, notesBefore, "no cancel notice for a start that was already abandoned");
});

test("a newer start that finishes while an older one's dialog is open wins; the older one is abandoned", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const h = await setup({ settings });
  const first = deferred<boolean>();
  scriptConfirms(h, [first.promise, true]);

  const older = h.commands.get("mlx-start")!("org/older", h.ctx);
  await flush();
  await h.commands.get("mlx-start")!("org/newer", h.ctx);
  assert.deepEqual(h.server.startCalls, ["org/newer"]);
  const before = [h.notes.length, h.statuses.length, h.providerCalls.length];
  first.resolve(true);
  await older;

  assert.deepEqual(h.server.startCalls, ["org/newer"], "the older start never launched");
  assert.deepEqual([h.notes.length, h.statuses.length, h.providerCalls.length], before);
});

test("a start that is refused or declined does not cancel a start already in flight", async () => {
  const gate = deferred();
  const settings = freshSettings({});
  const h = await setup({ settings, ensureInstalled: () => gate.promise, ctx: { confirm: false } });

  const inFlight = h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  await flush();
  writeGlobal(settings, { server: { trustRemoteCode: true } });
  const declined = h.commands.get("mlx-start")!("org/other", h.ctx);
  await flush();
  assert.deepEqual(
    infos(h.notes).filter((m) => m.startsWith("mlx-start cancelled")),
    ["mlx-start cancelled: --trust-remote-code was not confirmed."],
  );
  gate.resolve();
  await Promise.all([inFlight, declined]);

  assert.deepEqual(h.server.startCalls, [QWEN.modelId], "the first start completed");
  assert.equal(lastStatus(h.statuses), `mlx: running (${QWEN.modelId})`);
});

test("the provider registered when pi loads the extension comes from the environment and the global file only", async () => {
  const cwd = newCwd();
  writeProject(cwd, { baseUrl: "http://example.test/v1" });
  const settings = freshSettings({});
  writeGlobal(settings, { baseUrl: "http://localhost:9999/v1" });

  const h = await setup({ settings, ctx: { cwd } });

  assert.equal(h.providerCalls[0].config.baseUrl, "http://localhost:9999/v1");
  assert.equal(h.confirms.length, 0);
});

// ---- the model options and the models block (plan 02-06: SRV-02, D-21, D-22, D-23) ----

const startMlx = (h: Harness, input: string) => h.commands.get("mlx-start")!(input, h.ctx);
const flagsLineOf = (notes: Note[], index: number) => startingNotes(notes)[index].split("\n")[1];

test("a global draft model and a per-model token count reach each launch; another model gets only the shared block", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { model: { draftModel: "mlx-community/draft" }, models: { qwen3_4b: { numDraftTokens: 4 } } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");
  await startMlx(h, "llama3_2_3b");

  assert.deepEqual(errors(h.notes), []);
  assert.deepEqual(
    h.server.launches.map((launch) => launch?.extraArgs),
    [["--draft-model=mlx-community/draft", "--num-draft-tokens=4"], ["--draft-model=mlx-community/draft"]],
  );
  assert.equal(flagsLineOf(h.notes, 0), "flags: --draft-model mlx-community/draft (global file), --num-draft-tokens 4 (global file)");
  assert.equal(flagsLineOf(h.notes, 1), "flags: --draft-model mlx-community/draft (global file)");
});

const WAYS_TO_CHOOSE_QWEN: Array<[string, { input: string; flag?: string; pick?: boolean }]> = [
  ["its number", { input: "4" }],
  ["its preset key", { input: "qwen3_4b" }],
  ["its full model id", { input: QWEN.modelId }],
  ["the picker", { input: "", pick: true }],
  ["the mlx-model pi flag", { input: "", flag: "qwen3_4b" }],
];

for (const [way, choice] of WAYS_TO_CHOOSE_QWEN) {
  test(`the entry for qwen3_4b applies when the model is chosen by ${way}`, async () => {
    const settings = freshSettings({});
    writeGlobal(settings, { models: { qwen3_4b: { numDraftTokens: 4 } }, model: { draftModel: "d" } });
    const h = await setup({ settings, ...(choice.pick ? { select: (options: string[]) => options[3] } : {}) });
    if (choice.flag !== undefined) h.setFlag("mlx-model", choice.flag);

    await startMlx(h, choice.input);

    assert.deepEqual(errors(h.notes), []);
    assert.deepEqual(h.server.startCalls, [QWEN.modelId]);
    assert.deepEqual(h.server.launches[0]?.extraArgs, ["--draft-model=d", "--num-draft-tokens=4"]);
  });
}

test("an entry keyed by the full model id applies and beats the entry keyed by the preset key", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { models: { qwen3_4b: { draftModel: "by-key", numDraftTokens: 3 }, [QWEN.modelId]: { draftModel: "by-id" } } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--draft-model=by-id", "--num-draft-tokens=3"]);
});

test("a project model block beats a global entry for the same model, and the flags line names each layer", async () => {
  const cwd = newCwd();
  writeProject(cwd, { model: { numDraftTokens: 2 } });
  const settings = freshSettings({});
  writeGlobal(settings, { models: { qwen3_4b: { draftModel: "g", numDraftTokens: 3 } } });
  const h = await setup({ settings, ctx: { cwd } });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--draft-model=g", "--num-draft-tokens=2"]);
  assert.equal(flagsLineOf(h.notes, 0), "flags: --draft-model g (global file), --num-draft-tokens 2 (project file)");
});

test("/mlx-start with every model flag passes them in schema order, the template as text; relative paths are under the working directory", async () => {
  const cwd = newCwd();
  writeFileSync(join(cwd, "tpl.jinja"), "{{ messages }}\n");
  const h = await setup({ ctx: { cwd } });

  await startMlx(
    h,
    `qwen3_4b --chat-template-args '{"enable_thinking":false}' --use-default-chat-template --chat-template tpl.jinja --num-draft-tokens 4 --draft-model mlx-community/draft --adapter-path adapters/x`,
  );

  assert.deepEqual(errors(h.notes), []);
  assert.deepEqual(h.server.launches[0]?.extraArgs, [
    `--adapter-path=${join(cwd, "adapters", "x")}`,
    "--draft-model=mlx-community/draft",
    "--num-draft-tokens=4",
    "--chat-template={{ messages }}\n",
    "--use-default-chat-template",
    '--chat-template-args={"enable_thinking":false}',
  ]);
  assert.equal(
    flagsLineOf(h.notes, 0),
    `flags: --adapter-path ${join(cwd, "adapters", "x")} (/mlx-start), --draft-model mlx-community/draft (/mlx-start), --num-draft-tokens 4 (/mlx-start), --chat-template ${join(cwd, "tpl.jinja")} (/mlx-start), --use-default-chat-template (/mlx-start), --chat-template-args {"enable_thinking":false} (/mlx-start)`,
  );
});

test("a project file's relative chat template is read from the working directory, and ~ is the configured home directory", async () => {
  const cwd = newCwd();
  writeFileSync(join(cwd, "tpl.jinja"), "{{ project }}");
  writeProject(cwd, { model: { chatTemplate: "tpl.jinja" } });
  const settings = freshSettings({});
  writeGlobal(settings, { model: { adapterPath: "~/adapters/a" } });
  const h = await setup({ settings, ctx: { cwd } });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(h.server.launches[0]?.extraArgs, [`--adapter-path=${join(settings.home, "adapters", "a")}`, "--chat-template={{ project }}"]);
});

test("a missing chat template is one invalid-configuration report before anything runs, and it comes before any trust dialog", async () => {
  const settings = freshSettings({});
  const missing = join(settings.home, "missing.jinja");
  writeGlobal(settings, { server: { trustRemoteCode: true }, model: { chatTemplate: missing } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(errors(h.notes), [
    `mlx-start failed: invalid configuration\n  model.chatTemplate (global config.json): cannot read ${missing}: cannot be read (ENOENT)`,
  ]);
  assert.equal(h.notes.length, 1);
  assert.equal(h.confirms.length, 0, "the report comes before the dialog");
  assertNothingHappened(h);
});

test("a broken template path in an entry for another model does not stop this launch", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { models: { llama3_2_3b: { chatTemplate: join(settings.home, "missing.jinja") } } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");
  assert.deepEqual(errors(h.notes), []);
  assert.deepEqual(h.server.startCalls, [QWEN.modelId]);

  await startMlx(h, "llama3_2_3b");
  assert.equal(errors(h.notes).length, 1, "the model that uses the broken path is refused");
  assert.deepEqual(h.server.startCalls, [QWEN.modelId]);
});

test("a trustRemoteCode key inside a models entry is reported as an unknown key and nothing runs", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { models: { qwen3_4b: { trustRemoteCode: true } } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(errors(h.notes), [
    'mlx-start failed: invalid configuration\n  models["qwen3_4b"].trustRemoteCode (global config.json): unknown key (trustRemoteCode is a "server" key, not part of a "models" entry)',
  ]);
  assert.equal(h.confirms.length, 0);
  assertNothingHappened(h);
});

test("a bad chat-template-args text on /mlx-start is refused before anything runs", async () => {
  const h = await setup();

  await startMlx(h, "qwen3_4b --chat-template-args {bad");

  assert.deepEqual(errors(h.notes), [
    'mlx-start failed: invalid configuration\n  model.chatTemplateArgs (/mlx-start --chat-template-args): "{bad" is not valid JSON; give a JSON object',
  ]);
  assertNothingHappened(h);
});

test("merged chat template args across the global file, a models entry and the command line", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, {
    model: { chatTemplateArgs: { enable_thinking: false, x: 1 } },
    models: { qwen3_4b: { chatTemplateArgs: { x: 2, y: 3 } } },
  });
  const h = await setup({ settings });

  await startMlx(h, `qwen3_4b --chat-template-args '{"z":4}'`);

  assert.deepEqual(h.server.launches[0]?.extraArgs, ['--chat-template-args={"enable_thinking":false,"x":2,"y":3,"z":4}']);
});

// ---- the flag probe: older mlx-lm degrades instead of crashing (plan 02-07: SRV-06, D-18, D-19, D-20) ----

const flagSet = (...flags: string[]): ProbeResult => ({ ok: true, version: "0.24.0", flags: new Set(flags) });
/** An mlx-lm 0.24.0 install: no --allowed-origins, no --num-draft-tokens. */
const OLD_INSTALL = flagSet("--help", "--model", "--host", "--port", "--log-level", "--draft-model");
const warningTexts = (notes: Note[]) => notes.filter((n) => n.type === "warning").map((n) => n.message);
const PROBE_DETAIL = "Checking which server flags mlx-lm supports";

test("a launch with only host and port never probes and shows no probe progress", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { host: "localhost", port: 9123 } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");

  assert.equal(h.server.startCalls.length, 1);
  assert.equal(h.probeCalls, 0);
  assert.ok(!h.widgets.some((w) => w.lines?.some((line) => line.includes(PROBE_DETAIL))));
  assert.deepEqual(warningTexts(h.notes), []);
});

test("a default launch never probes", async () => {
  const h = await setup();

  await startMlx(h, "qwen3_4b");

  assert.equal(h.server.startCalls.length, 1);
  assert.equal(h.probeCalls, 0);
});

test("a launch with an optional flag probes exactly once, after the install and before the server starts", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { logLevel: "DEBUG" } });
  const events: string[] = [];
  const h = await setup({
    settings,
    ensureInstalled: async () => {
      events.push("install");
    },
    probe: async () => {
      events.push("probe");
      return ALL_SUPPORTED;
    },
    server: {
      start: async (_model, onEvent) => {
        events.push("start");
        for (const type of ["launched", "loading", "warming", "ready"] as const) onEvent?.({ type });
      },
    },
  });

  await startMlx(h, "qwen3_4b");

  assert.equal(h.probeCalls, 1);
  assert.deepEqual(events, ["install", "probe", "start"]);
  assert.ok(h.widgets.some((w) => w.lines?.some((line) => line.includes(PROBE_DETAIL))), "the pause is explained in the progress widget");
  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--log-level=DEBUG"]);
  assert.deepEqual(warningTexts(h.notes), []);
});

test("a flag the install does not list is skipped with one warning, the server still starts, and the flags line marks it", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { allowedOrigins: ["http://a.test"], logLevel: "DEBUG" } });
  const h = await setup({ settings, probe: async () => OLD_INSTALL });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), ["Skipped --allowed-origins: not supported by mlx-lm 0.24.0 (run /mlx-init to upgrade)"]);
  assert.deepEqual(h.server.startCalls.length, 1);
  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--log-level=DEBUG"]);
  assert.equal(
    startingNotes(h.notes)[0].split("\n")[1],
    "flags: --allowed-origins http://a.test (global file, skipped), --log-level DEBUG (global file)",
  );
  assert.ok(infos(h.notes).includes("MLX server is ready for prompts. Use /model and pick pi-mlx-models/..."));
});

test("two skipped flags make one warning naming both in row order, and a second start warns again", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { allowedOrigins: ["http://a.test"] }, model: { numDraftTokens: 4 } });
  const h = await setup({ settings, probe: async () => OLD_INSTALL });

  await startMlx(h, "qwen3_4b");
  await startMlx(h, "qwen3_4b");

  const expected = "Skipped --allowed-origins, --num-draft-tokens: not supported by mlx-lm 0.24.0 (run /mlx-init to upgrade)";
  assert.deepEqual(warningTexts(h.notes), [expected, expected], "skip notices are shown on every launch, not once");
  assert.deepEqual(h.server.launches.map((l) => l?.extraArgs), [[], []]);
});

test("an install that lists every flag adds no warning and passes everything", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { allowedOrigins: ["http://a.test"], logLevel: "DEBUG" }, model: { numDraftTokens: 4 } });
  const h = await setup({ settings, probe: async () => ALL_SUPPORTED });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), []);
  assert.deepEqual(h.server.launches[0]?.extraArgs, [
    "--allowed-origins=http://a.test",
    "--log-level=DEBUG",
    "--num-draft-tokens=4",
  ]);
});

const helpFixture = (name: string): string => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
const probeFromHelp = (version: string, fixtureName: string): ProbeResult => ({
  ok: true,
  version,
  flags: parseHelpFlags(helpFixture(fixtureName)),
});
const ALL_PERFORMANCE = {
  decodeConcurrency: 2,
  promptConcurrency: 4,
  prefillStepSize: 1024,
  promptCacheSize: 5,
  promptCacheBytes: 8589934592,
};
const PERFORMANCE_ELEMENTS = [
  "--decode-concurrency=2",
  "--prompt-concurrency=4",
  "--prefill-step-size=1024",
  "--prompt-cache-size=5",
  "--prompt-cache-bytes=8589934592",
];

test("mlx-lm 0.30.7 passes the two concurrency flags, skips the other three performance flags with one warning, and still starts", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: ALL_PERFORMANCE });
  const h = await setup({ settings, probe: async () => probeFromHelp("0.30.7", "mlx-server-help-0.30.7.txt") });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), [
    "Skipped --prefill-step-size, --prompt-cache-size, --prompt-cache-bytes: not supported by mlx-lm 0.30.7 (run /mlx-init to upgrade)",
  ]);
  assert.equal(h.server.startCalls.length, 1);
  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--decode-concurrency=2", "--prompt-concurrency=4"]);
  assert.equal(
    startingNotes(h.notes)[0].split("\n")[1],
    "flags: --decode-concurrency 2 (global file), --prompt-concurrency 4 (global file), --prefill-step-size 1024 (global file, skipped), --prompt-cache-size 5 (global file, skipped), --prompt-cache-bytes 8589934592 (global file, skipped)",
  );
});

test("mlx-lm 0.31.1 passes all five performance flags with no warning", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: ALL_PERFORMANCE });
  const h = await setup({ settings, probe: async () => probeFromHelp("0.31.1", "mlx-server-help-0.31.1.txt") });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), []);
  assert.deepEqual(h.server.launches[0]?.extraArgs, PERFORMANCE_ELEMENTS);
});

test("mlx-lm 0.24.0 skips all five performance flags with one warning naming them in row order", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: ALL_PERFORMANCE });
  const h = await setup({ settings, probe: async () => probeFromHelp("0.24.0", "mlx-server-help-0.24.0.txt") });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), [
    "Skipped --decode-concurrency, --prompt-concurrency, --prefill-step-size, --prompt-cache-size, --prompt-cache-bytes: not supported by mlx-lm 0.24.0 (run /mlx-init to upgrade)",
  ]);
  assert.equal(h.server.startCalls.length, 1);
  assert.deepEqual(h.server.launches[0]?.extraArgs, []);
});

// ---- sampling flags and the probe (plan 04-01: SRV-03, D-09) ----

const SAMPLING_FILE = {
  model: {
    sampling: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      maxTokens: 2048,
      repetitionPenalty: 1.1,
      stop: ["END"],
      seed: 7,
    },
  },
};

test("mlx-lm 0.24.0 skips all five sampling flags with one warning, the request-only keys add nothing, and the server still starts", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, SAMPLING_FILE);
  const h = await setup({ settings, probe: async () => probeFromHelp("0.24.0", "mlx-server-help-0.24.0.txt") });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), [
    "Skipped --temp, --top-p, --top-k, --min-p, --max-tokens: not supported by mlx-lm 0.24.0 (run /mlx-init to upgrade)",
  ]);
  assert.equal(h.server.startCalls.length, 1);
  assert.deepEqual(h.server.launches[0]?.extraArgs, []);
  assert.equal(
    startingNotes(h.notes)[0].split("\n")[1],
    "flags: --temp 0.2 (global file, skipped), --top-p 0.9 (global file, skipped), --top-k 40 (global file, skipped), --min-p 0.05 (global file, skipped), --max-tokens 2048 (global file, skipped)",
  );
});

test("mlx-lm 0.28.1 passes all five sampling flags in schema order with no warning", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, SAMPLING_FILE);
  const h = await setup({ settings, probe: async () => probeFromHelp("0.28.1", "mlx-server-help-0.28.1.txt") });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), []);
  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--temp=0.2", "--top-p=0.9", "--top-k=40", "--min-p=0.05", "--max-tokens=2048"]);
});

test("a sampling flag typed on /mlx-start is refused: the decisions add no typed flag", async () => {
  const h = await setup();

  await startMlx(h, "qwen3_4b --temp 0.2");

  assert.equal(errors(h.notes).length, 1, errors(h.notes).join("|"));
  assert.ok(errors(h.notes)[0].startsWith("mlx-start failed: unknown flag --temp"), errors(h.notes)[0]);
  assertNothingHappened(h);
});

test("a failed probe warns, passes every configured flag, and the start goes on", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { allowedOrigins: ["http://a.test"], logLevel: "DEBUG" } });
  const h = await setup({ settings, probe: async () => ({ ok: false, reason: "boom" }) });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), ["Could not check which flags mlx-lm supports (boom); passing every configured flag."]);
  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--allowed-origins=http://a.test", "--log-level=DEBUG"]);
  assert.equal(h.server.startCalls.length, 1);
  assert.equal(
    startingNotes(h.notes)[0].split("\n")[1],
    "flags: --allowed-origins http://a.test (global file), --log-level DEBUG (global file)",
  );
});

test("a /mlx-stop while the probe is pending abandons the start: no server, no later UI writes", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { allowedOrigins: ["http://a.test"] } });
  const gate = deferred<ProbeResult>();
  const h = await setup({ settings, probe: () => gate.promise });

  const starting = startMlx(h, "qwen3_4b");
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(h.probeCalls, 1, "the start is waiting on the probe");

  await h.commands.get("mlx-stop")!("", h.ctx);
  const before = { notes: h.notes.length, statuses: h.statuses.length, widgets: h.widgets.length };
  gate.resolve(OLD_INSTALL);
  await starting;

  assert.deepEqual(h.server.startCalls, []);
  assert.deepEqual(
    { notes: h.notes.length, statuses: h.statuses.length, widgets: h.widgets.length },
    before,
    "nothing is written after the stop, not even the skip warning",
  );
});

// ---- KV quantization: the batching warning on every launch (plan 03-02: SRV-05, D-09, D-10, D-12) ----

const KV_BATCHING_4 = "KV quantization (--kv-bits 4, global file): Disables batching, so requests are served one at a time.";

test("kvBits in the global file reaches argv and each launch shows the batching warning once, at level warning", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { kvBits: 4 } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");
  await startMlx(h, "qwen3_4b");

  assert.deepEqual(
    h.notes.filter((n) => n.message.startsWith("KV quantization")),
    [
      { message: KV_BATCHING_4, type: "warning" },
      { message: KV_BATCHING_4, type: "warning" },
    ],
    "shown on every launch, not once per session",
  );
  assert.deepEqual(h.server.launches.map((l) => l?.extraArgs), [["--kv-bits=4"], ["--kv-bits=4"]]);
  assert.deepEqual(errors(h.notes), []);
});

test("an install without --kv-bits gets only the skip notice and the start goes on", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { kvBits: 4 } });
  const h = await setup({ settings, probe: async () => OLD_INSTALL });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), ["Skipped --kv-bits: not supported by mlx-lm 0.24.0 (run /mlx-init to upgrade)"]);
  assert.equal(h.server.startCalls.length, 1);
  assert.deepEqual(h.server.launches[0]?.extraArgs, []);
});

test("a failed probe shows the could-not-check warning and the batching warning, because the flag is passed", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { kvBits: 4 } });
  const h = await setup({ settings, probe: async () => ({ ok: false, reason: "boom" }) });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), ["Could not check which flags mlx-lm supports (boom); passing every configured flag.", KV_BATCHING_4]);
  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--kv-bits=4"]);
});

test("kvBits with decodeConcurrency launches with both flags and the warning says the concurrency has no effect", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { kvBits: 4, decodeConcurrency: 2 } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--decode-concurrency=2", "--kv-bits=4"], "nothing is dropped");
  assert.deepEqual(warningTexts(h.notes), [`${KV_BATCHING_4} --decode-concurrency 2 has no effect while --kv-bits is set.`]);
  assert.deepEqual(errors(h.notes), []);
});

test("kvGroupSize alone launches with its flag and shows one info note that it has no effect without kvBits", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { kvGroupSize: 32 } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--kv-group-size=32"]);
  assert.deepEqual(warningTexts(h.notes), []);
  assert.deepEqual(
    h.notes.filter((n) => n.message.includes("has no effect")),
    [{ message: "--kv-group-size 32 has no effect without --kv-bits.", type: "info" }],
  );
  assert.equal(flagsLineOf(h.notes, 0), "flags: --kv-group-size 32 (global file)");
});

test("mlx-lm 0.31.1 has no KV flags: all three are skipped with one notice and neither the batching warning nor the info note appears", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { kvBits: 4, kvGroupSize: 32, quantizedKvStart: 0 } });
  const h = await setup({ settings, probe: async () => probeFromHelp("0.31.1", "mlx-server-help-0.31.1.txt") });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), ["Skipped --kv-bits, --kv-group-size, --quantized-kv-start: not supported by mlx-lm 0.31.1 (run /mlx-init to upgrade)"]);
  assert.deepEqual(h.server.launches[0]?.extraArgs, []);
  assert.ok(!h.notes.some((n) => n.message.includes("Disables batching") || n.message.includes("has no effect")));
  assert.equal(h.server.startCalls.length, 1);
});

test("an install that lists every KV flag passes all three in schema order with only the batching warning", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { server: { quantizedKvStart: 0, kvGroupSize: 32, kvBits: 4 } });
  const h = await setup({ settings, probe: async () => ALL_SUPPORTED });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--kv-bits=4", "--kv-group-size=32", "--quantized-kv-start=0"]);
  assert.deepEqual(warningTexts(h.notes), [KV_BATCHING_4]);
  assert.ok(!h.notes.some((n) => n.message.includes("has no effect")));
});

// ---- the mlx-lm version policy reaches pip through /mlx-init (plan 03-03, RUN-02) ----

const PIP_INDEX_ARG = "--index-url=https://pypi.org/simple/";

/** An extension around the REAL ensureInstalled over a scripted host: no network and no real pip. */
async function setupRealInstall(
  globalFile?: unknown,
  extra: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    /** The text a pip step fails with, for the step whose argv this returns text for. */
    failWith?: (args: string[]) => string | undefined;
    /** Whether the venv's python exists; default true. False scripts a first run with no virtual environment yet. */
    venvExists?: boolean;
    /** What the cheap installed-version query answers; default: mlx-lm 0.32.2. */
    installed?: VersionResult;
  } = {},
) {
  const settings = freshSettings(extra.env ?? {});
  if (globalFile !== undefined) writeGlobal(settings, globalFile);
  const hostCalls: string[][] = [];
  const host: RuntimeHost = {
    findPython: () => "/py3",
    exists: () => extra.venvExists ?? true,
    run: async (cmd, args, onLine) => {
      hostCalls.push([cmd, ...args]);
      if (args[0] === "--version") onLine?.("Python 3.13.1");
      const failure = extra.failWith?.(args);
      if (failure !== undefined) throw new Error(failure);
    },
  };
  const fakePi = makeFakePi();
  const fakeCtx = makeCtx(undefined, extra.cwd === undefined ? undefined : { cwd: extra.cwd });
  const server = makeFakeServer();
  const extension = createExtension({
    server,
    ensureInstalled: ((opts?: any) => ensureInstalled({ ...opts, host })) as any,
    discoverModelIds: async () => [],
    readModelConfig: makeFakeModelConfig().read,
    settings,
    installedVersion: async () => extra.installed ?? { ok: true, version: "0.32.2" },
  });
  await extension(fakePi.pi);
  return { hostCalls, server, settings, ...fakePi, ...fakeCtx };
}

const pipStep = (spec: string) => [VENV_PYTHON, "-m", "pip", "install", "--upgrade", spec, PIP_INDEX_ARG];

test("an exact pin in the global file reaches pip as the single spec mlx-lm==X through mlx-init", async () => {
  const h = await setupRealInstall({ mlxLm: { version: "0.31.1" } });

  await h.commands.get("mlx-init")!("", h.ctx);

  assert.deepEqual(h.hostCalls.filter((call) => call.includes("pip")), [pipStep("pip"), pipStep("mlx-lm==0.31.1")]);
  assert.ok(h.notes.some((n) => n.type === "info" && n.message === "MLX runtime installed."));
  assert.deepEqual(errors(h.notes), []);
});

test("with no mlxLm key mlx-init floats: the mlx-lm step keeps the floor spec", async () => {
  const h = await setupRealInstall();

  await h.commands.get("mlx-init")!("", h.ctx);

  assert.deepEqual(h.hostCalls.filter((call) => call.includes("pip")), [pipStep("pip"), pipStep("mlx-lm>=0.24.0")]);
});

test("the word latest floats exactly like no setting", async () => {
  const h = await setupRealInstall({ mlxLm: { version: "latest" } });

  await h.commands.get("mlx-init")!("", h.ctx);

  assert.deepEqual(h.hostCalls.filter((call) => call.includes("pip")), [pipStep("pip"), pipStep("mlx-lm>=0.24.0")]);
});

test("a bad mlxLm.version refuses mlx-init before any side effect", async () => {
  const h = await setupRealInstall({ mlxLm: { version: "^0.32" } });

  await h.commands.get("mlx-init")!("", h.ctx);

  assert.equal(errors(h.notes).length, 1);
  assert.ok(errors(h.notes)[0].startsWith("mlx-init failed: invalid configuration"), errors(h.notes)[0]);
  assert.ok(
    errors(h.notes)[0].includes('mlxLm.version (global config.json): "^0.32" must be "latest" or an exact version such as 0.32.2'),
    errors(h.notes)[0],
  );
  assert.deepEqual(h.hostCalls, [], "the scripted host was never called");
  assert.deepEqual(h.widgets, [], "no progress widget was drawn");
});

// ---- /mlx-init flags: strict parsing, one run only, the progress line, installs that never share a policy (plan 03-03) ----

/** The mlx-lm spec of every pip install step the scripted host saw. */
const mlxLmSpecs = (calls: string[][]) => calls.filter((call) => call[5]?.startsWith("mlx-lm")).map((call) => call[5]);

test("mlx-init --mlx-lm-version 0.31.1 runs the mlx-lm pip step with mlx-lm==0.31.1", async () => {
  const h = await setupRealInstall();

  await h.commands.get("mlx-init")!("--mlx-lm-version 0.31.1", h.ctx);

  assert.deepEqual(mlxLmSpecs(h.hostCalls), ["mlx-lm==0.31.1"]);
  assert.deepEqual(errors(h.notes), []);
});

test("nothing typed on mlx-init is remembered: the next plain mlx-init floats again", async () => {
  const h = await setupRealInstall();

  await h.commands.get("mlx-init")!("--mlx-lm-version 0.31.1", h.ctx);
  await h.commands.get("mlx-init")!("", h.ctx);

  assert.deepEqual(mlxLmSpecs(h.hostCalls), ["mlx-lm==0.31.1", "mlx-lm>=0.24.0"]);
});

test("mlx-init --mlx-lm-version=latest over a global pin floats", async () => {
  const h = await setupRealInstall({ mlxLm: { version: "0.31.1" } });

  await h.commands.get("mlx-init")!("--mlx-lm-version=latest", h.ctx);

  assert.deepEqual(mlxLmSpecs(h.hostCalls), ["mlx-lm>=0.24.0"]);
});

test("a bad typed version ends with one invalid-configuration error naming the /mlx-init flag, and nothing happens", async () => {
  const h = await setup();

  await h.commands.get("mlx-init")!('--mlx-lm-version "^0.32"', h.ctx);

  assert.equal(errors(h.notes).length, 1);
  assert.ok(errors(h.notes)[0].startsWith("mlx-init failed: invalid configuration"), errors(h.notes)[0]);
  assert.ok(
    errors(h.notes)[0].includes('mlxLm.version (/mlx-init --mlx-lm-version): "^0.32" must be "latest" or an exact version such as 0.32.2'),
    errors(h.notes)[0],
  );
  assertNothingHappened(h);
});

test("mlx-init with an unknown flag is refused, with its own flag list, and nothing happens", async () => {
  const h = await setup();

  await h.commands.get("mlx-init")!("--bogus 1", h.ctx);

  assert.deepEqual(errors(h.notes), ["mlx-init failed: unknown flag --bogus (valid flags: --mlx-lm-version, --pip-index)"]);
  assertNothingHappened(h);
});

test("mlx-init with a repeated flag is refused", async () => {
  const h = await setup();

  await h.commands.get("mlx-init")!("--mlx-lm-version 1.0 --mlx-lm-version 2.0", h.ctx);

  assert.deepEqual(errors(h.notes), ["mlx-init failed: --mlx-lm-version was given twice"]);
  assertNothingHappened(h);
});

test("mlx-init takes no model", async () => {
  const h = await setup();

  await h.commands.get("mlx-init")!("qwen3_4b", h.ctx);

  assert.deepEqual(errors(h.notes), ["mlx-init failed: unexpected argument qwen3_4b (/mlx-init takes no model)"]);
  assertNothingHappened(h);
});

test("mlx-start still rejects --mlx-lm-version as an unknown flag and does not list it", async () => {
  const h = await setup();

  await h.commands.get("mlx-start")!("qwen3_4b --mlx-lm-version 0.31.1", h.ctx);

  assert.deepEqual(errors(h.notes), [
    "mlx-start failed: unknown flag --mlx-lm-version (valid flags: --host, --port, --allowed-origins, --log-level, --trust-remote-code, --decode-concurrency, --prompt-concurrency, --prefill-step-size, --prompt-cache-size, --prompt-cache-bytes, --kv-bits, --kv-group-size, --quantized-kv-start, --adapter-path, --draft-model, --num-draft-tokens, --chat-template, --use-default-chat-template, --chat-template-args, --profile)",
  ]);
  assertNothingHappened(h);
});

test("two mlx-init runs with different policies never share one install", async () => {
  const gate = deferred();
  let running = 0;
  let maxRunning = 0;
  let call = 0;
  const h = await setup({
    ensureInstalled: async () => {
      call += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (call === 1) await gate.promise;
      running -= 1;
    },
  });

  const first = h.commands.get("mlx-init")!("", h.ctx);
  await flush();
  const second = h.commands.get("mlx-init")!("--mlx-lm-version 0.31.1", h.ctx);
  await flush();
  assert.equal(h.installCalls.length, 1, "the second run waits: it does not join an install with another policy");
  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(h.installCalls.length, 2);
  assert.equal(maxRunning, 1);
  assert.equal(h.installCalls[1].policy.version, "0.31.1");
  assert.ok(h.notes.some((n) => n.type === "info" && n.message === "MLX runtime installed."));
  assert.deepEqual(errors(h.notes), []);
});

test("mlx-init says which mlx-lm version and index it uses and where each came from", async () => {
  const plain = await setup();
  await plain.commands.get("mlx-init")!("", plain.ctx);
  assert.ok(infos(plain.notes).includes("Installing mlx-lm latest (default) from https://pypi.org/simple/ (default)"), infos(plain.notes).join("|"));

  const typed = await setup();
  await typed.commands.get("mlx-init")!("--mlx-lm-version 0.31.1", typed.ctx);
  assert.ok(infos(typed.notes).includes("Installing mlx-lm 0.31.1 (/mlx-init) from https://pypi.org/simple/ (default)"), infos(typed.notes).join("|"));

  const settings = freshSettings({});
  writeGlobal(settings, { mlxLm: { version: "0.32.2" } });
  const filed = await setup({ settings });
  await filed.commands.get("mlx-init")!("", filed.ctx);
  assert.ok(infos(filed.notes).includes("Installing mlx-lm 0.32.2 (global file) from https://pypi.org/simple/ (default)"), infos(filed.notes).join("|"));
});

// ---- the pip index reaches pip through /mlx-init (plan 03-04, RUN-04) ----

const MIRROR = "https://mirror.example/simple/";

test("a mirror in the global file is the only index in both pip steps, as one element each", async () => {
  const h = await setupRealInstall({ mlxLm: { pipIndex: MIRROR } });

  await h.commands.get("mlx-init")!("", h.ctx);

  const mirrorArg = `--index-url=${MIRROR}`;
  assert.deepEqual(
    h.hostCalls.filter((call) => call.includes("pip")),
    [
      [VENV_PYTHON, "-m", "pip", "install", "--upgrade", "pip", mirrorArg],
      [VENV_PYTHON, "-m", "pip", "install", "--upgrade", "mlx-lm>=0.24.0", mirrorArg],
    ],
  );
  assert.ok(!h.hostCalls.flat().some((element) => element.includes("pypi.org")), "no element names the default index");
  assert.deepEqual(errors(h.notes), []);
});

test("mlx-init shows the configured index and where it came from in its progress line", async () => {
  const h = await setupRealInstall({ mlxLm: { pipIndex: MIRROR } });

  await h.commands.get("mlx-init")!("", h.ctx);

  assert.ok(infos(h.notes).includes(`Installing mlx-lm latest (default) from ${MIRROR} (global file)`), infos(h.notes).join("|"));
});

test("a failing mlx-lm step ends mlx-init with one error that names the spec and the index before pip's text", async () => {
  const original = "ERROR: Could not find a version that satisfies the requirement mlx-lm>=0.24.0";
  const h = await setupRealInstall(undefined, { failWith: (args) => (args.includes("install") && args.includes("mlx-lm>=0.24.0") ? original : undefined) });

  await h.commands.get("mlx-init")!("", h.ctx);

  assert.deepEqual(errors(h.notes), [`mlx-init failed: Installing mlx-lm>=0.24.0 from https://pypi.org/simple/ failed: ${original}`]);
});

// ---- the pip index is user-level: a project file may not choose it (plan 03-04, D-01, D-02, D-18) ----

const PIP_PROJECT = { mlxLm: { pipIndex: MIRROR } };
const PIP_VIOLATION_LINE = `  mlxLm.pipIndex (${MIRROR}): chooses where mlx-lm is installed from`;
/** Spelled out here, not imported, so changing the production sentence is a deliberate edit of two places. */
const installRefusalText = (command: string, settings: { globalConfigPath: string }, lines: string[]) =>
  [
    `${command} failed: .pi/pi-mlx-models.json cannot set options that run code, open the network or choose where mlx-lm is installed from:`,
    ...lines,
    `Move them to ${settings.globalConfigPath}. Settings that run code or open the network then ask for confirmation at every start; the pip index applies without asking.`,
  ].join("\n");

test("a project file with a pip index makes mlx-init end with the refusal, and nothing is installed or drawn", async () => {
  const cwd = newCwd();
  writeProject(cwd, PIP_PROJECT);
  const h = await setupRealInstall(undefined, { cwd });

  await h.commands.get("mlx-init")!("", h.ctx);

  assert.deepEqual(errors(h.notes), [installRefusalText("mlx-init", h.settings, [PIP_VIOLATION_LINE])]);
  assert.deepEqual(h.hostCalls, [], "the installer was never called");
  assert.deepEqual(h.widgets, [], "no progress widget was drawn");
  assert.equal(h.confirms.length, 0);
});

test("a project file with a pip index makes mlx-start end with the same refusal, and nothing is installed, spawned or registered", async () => {
  const cwd = newCwd();
  writeProject(cwd, PIP_PROJECT);
  const h = await setupRealInstall(undefined, { cwd });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(errors(h.notes), [installRefusalText("mlx-start", h.settings, [PIP_VIOLATION_LINE])]);
  assert.deepEqual(h.hostCalls, [], "nothing was installed");
  assert.deepEqual(h.server.startCalls, [], "no server was spawned");
  assert.equal(h.providerCalls.length, 1, "no provider beyond the initial one");
  assert.deepEqual(h.widgets, []);
  assert.equal(h.confirms.length, 0);
});

test("an environment index does not launder a project file's index: both commands still refuse", async () => {
  const cwd = newCwd();
  writeProject(cwd, PIP_PROJECT);
  const h = await setupRealInstall(undefined, { cwd, env: { PI_MLX_MODELS_PIP_INDEX: "https://other.example/simple/" } });

  await h.commands.get("mlx-init")!("", h.ctx);
  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  await h.commands.get("mlx-init")!("--pip-index https://typed.example/simple/", h.ctx);

  assert.deepEqual(errors(h.notes), [
    installRefusalText("mlx-init", h.settings, [PIP_VIOLATION_LINE]),
    installRefusalText("mlx-start", h.settings, [PIP_VIOLATION_LINE]),
    installRefusalText("mlx-init", h.settings, [PIP_VIOLATION_LINE]),
  ]);
  assert.deepEqual(h.hostCalls, []);
  assert.deepEqual(h.server.startCalls, []);
});

test("an index from the global file, the environment or the flag reaches the installer unchanged with no dialog and no warning", async () => {
  const typedIndex = "https://typed.example/simple/";
  const fromFile = freshSettings({});
  writeGlobal(fromFile, { mlxLm: { pipIndex: MIRROR } });
  const cases: Array<[string, Awaited<ReturnType<typeof setup>>, string, string]> = [
    ["the global file", await setup({ settings: fromFile }), "", MIRROR],
    ["the environment", await setup({ env: { PI_MLX_MODELS_PIP_INDEX: "https://env.example/simple/" } }), "", "https://env.example/simple/"],
    ["the flag", await setup(), `--pip-index ${typedIndex}`, typedIndex],
  ];
  for (const [name, h, args, expected] of cases) {
    await h.commands.get("mlx-init")!(args, h.ctx);

    assert.equal(h.installCalls.length, 1, name);
    assert.equal(h.installCalls[0].policy.pipIndex, expected, name);
    assert.equal(h.confirms.length, 0, `${name}: no dialog`);
    assert.deepEqual(warnings(h.notes), [], `${name}: no warning`);
    assert.deepEqual(errors(h.notes), [], name);
  }
});

test("mlx-init --pip-index applies to that run only and a bad one is refused with nothing happening", async () => {
  const h = await setup();

  await h.commands.get("mlx-init")!("--pip-index https://typed.example/simple/", h.ctx);
  await h.commands.get("mlx-init")!("", h.ctx);

  assert.deepEqual(
    h.installCalls.map((call) => call.policy.pipIndex),
    ["https://typed.example/simple/", "https://pypi.org/simple/"],
  );
  assert.ok(
    infos(h.notes).includes("Installing mlx-lm latest (default) from https://typed.example/simple/ (/mlx-init)"),
    infos(h.notes).join("|"),
  );

  const bad = await setup();
  await bad.commands.get("mlx-init")!("--pip-index http://example.com/simple/", bad.ctx);

  assert.equal(errors(bad.notes).length, 1);
  assert.ok(
    errors(bad.notes)[0].includes(
      'mlxLm.pipIndex (/mlx-init --pip-index): "http://example.com/simple/" must be an https URL without credentials or spaces (http only for a loopback host)',
    ),
    errors(bad.notes)[0],
  );
  assertNothingHappened(bad);
});

test("a pasted pip index secret that contains a slash never reaches a note, from the environment to the mlx-init error (WR-01)", async () => {
  const h = await setup({ env: { PI_MLX_MODELS_PIP_INDEX: "https://__token__:abc/def+ghi@mirror.example/simple/" } });

  await h.commands.get("mlx-init")!("", h.ctx);

  const failures = errors(h.notes);
  assert.equal(failures.length, 1, failures.join("|"));
  assert.ok(failures[0].startsWith("mlx-init failed:"), failures[0]);
  assert.ok(failures[0].includes("PI_MLX_MODELS_PIP_INDEX"), failures[0]);
  assert.ok(failures[0].includes("https://***@mirror.example"), failures[0]);
  for (const note of h.notes) {
    for (const secret of ["abc/def", "ghi", "__token__"]) {
      assert.ok(!note.message.includes(secret), `a ${note.type} note shows ${secret}: ${note.message}`);
    }
  }
  assertNothingHappened(h);
});

// ---- a pin that differs from the installed mlx-lm is reported on every start and applied only by mlx-init (plan 03-05, D-07, D-08) ----

const PIN_MISMATCH = "mlx-lm pinned 0.31.1 (project file), installed 0.32.2; run /mlx-init to apply";

test("a project pin that differs from the installed mlx-lm warns once, before the start message, starts what is installed and never upgrades", async () => {
  const cwd = newCwd();
  writeProject(cwd, { mlxLm: { version: "0.31.1" } });
  const h = await setup({ ctx: { cwd }, installed: async () => ({ ok: true, version: "0.32.2" }) });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), [PIN_MISMATCH]);
  const warningAt = h.notes.findIndex((n) => n.message === PIN_MISMATCH);
  const startingAt = h.notes.findIndex((n) => n.message.startsWith("Starting MLX server with"));
  assert.ok(warningAt >= 0 && startingAt > warningAt, `the warning (${warningAt}) comes before the start message (${startingAt})`);
  assert.equal(h.server.startCalls.length, 1, "the server still starts");
  assert.equal(h.installCalls.length, 1);
  assert.ok(!("upgrade" in h.installCalls[0]), "the start never upgrades or downgrades");
  assert.equal(h.installedCalls, 1);
});

test("a pin equal to the installed version shows no warning", async () => {
  const cwd = newCwd();
  writeProject(cwd, { mlxLm: { version: "0.32.2" } });
  const h = await setup({ ctx: { cwd } });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), []);
  assert.equal(h.installedCalls, 1, "the version was compared");
  assert.equal(h.server.startCalls.length, 1);
});

test("with no pin, or the word latest, the installed version is never asked and nothing is shown", async () => {
  const floating = await setup();
  await startMlx(floating, "qwen3_4b");

  const settings = freshSettings({});
  writeGlobal(settings, { mlxLm: { version: "latest" } });
  const latest = await setup({ settings });
  await startMlx(latest, "qwen3_4b");

  for (const h of [floating, latest]) {
    assert.equal(h.installedCalls, 0);
    assert.deepEqual(warningTexts(h.notes), []);
    assert.equal(h.server.startCalls.length, 1);
  }
});

test("when the installed version cannot be read the pin is reported as not compared and the start goes on", async () => {
  const cwd = newCwd();
  writeProject(cwd, { mlxLm: { version: "0.31.1" } });
  const h = await setup({ ctx: { cwd }, installed: async () => ({ ok: false, reason: "could not read the mlx-lm version (python exited with 1)" }) });

  await startMlx(h, "qwen3_4b");

  const NOT_COMPARED =
    "mlx-lm pinned 0.31.1 (project file) was not compared with the installed version: could not read the mlx-lm version (python exited with 1)";
  assert.equal(h.installedCalls, 1);
  assert.deepEqual(warningTexts(h.notes), [NOT_COMPARED]);
  const warningAt = h.notes.findIndex((n) => n.message === NOT_COMPARED);
  const startingAt = h.notes.findIndex((n) => n.message.startsWith("Starting MLX server with"));
  assert.ok(warningAt >= 0 && startingAt > warningAt, `the warning (${warningAt}) comes before the start message (${startingAt})`);
  assert.deepEqual(errors(h.notes), []);
  assert.equal(h.server.startCalls.length, 1);
});

// ---- under a pin: the skip notice names the pin, the first install honours the policy, an existing install is left alone (plan 03-05) ----

test("a project pin of 0.30.7 makes the skip notice name the pin, and shows no pin-mismatch notice for the matching install", async () => {
  const cwd = newCwd();
  writeProject(cwd, { mlxLm: { version: "0.30.7" } });
  const settings = freshSettings({});
  writeGlobal(settings, { server: { prefillStepSize: 1024 } });
  const h = await setup({
    settings,
    ctx: { cwd },
    probe: async () => probeFromHelp("0.30.7", "mlx-server-help-0.30.7.txt"),
    installed: async () => ({ ok: true, version: "0.30.7" }),
  });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(warningTexts(h.notes), [
    "Skipped --prefill-step-size: not supported by mlx-lm 0.30.7 (mlx-lm is pinned to 0.30.7 by project file; raise or remove the pin, then run /mlx-init)",
  ]);
  assert.equal(h.server.startCalls.length, 1);
});

test("the first launch with no virtual environment installs at the configured pin from the configured index", async () => {
  const mirror = "https://mirror.example/simple/";
  const settings = freshSettings({});
  writeGlobal(settings, { mlxLm: { version: "0.31.1", pipIndex: mirror } });
  const recorded = await setup({ settings });

  await startMlx(recorded, "qwen3_4b");

  assert.equal(recorded.installCalls.length, 1);
  assert.deepEqual(recorded.installCalls[0].policy, { version: "0.31.1", pipIndex: mirror });
  assert.ok(!("upgrade" in recorded.installCalls[0]), "a start never asks for an upgrade");

  const h = await setupRealInstall({ mlxLm: { version: "0.31.1", pipIndex: mirror } }, { venvExists: false, installed: { ok: true, version: "0.31.1" } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  const pipCalls = h.hostCalls.filter((call) => call.includes("pip"));
  const indexArg = `--index-url=${mirror}`;
  assert.deepEqual(pipCalls, [
    [VENV_PYTHON, "-m", "pip", "install", "--upgrade", "pip", indexArg],
    [VENV_PYTHON, "-m", "pip", "install", "--upgrade", "mlx-lm==0.31.1", indexArg],
  ]);
  assert.deepEqual(errors(h.notes), []);
  assert.equal(h.server.startCalls.length, 1);
});

test("an existing install makes exactly one host call, the import check, even when the pin differs from what is installed", async () => {
  const h = await setupRealInstall({ mlxLm: { version: "0.31.1" } }, { venvExists: true, installed: { ok: true, version: "0.32.2" } });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(h.hostCalls, [[VENV_PYTHON, "-c", "import mlx_lm"]]);
  assert.deepEqual(warningTexts(h.notes), ["mlx-lm pinned 0.31.1 (global file), installed 0.32.2; run /mlx-init to apply"]);
  assert.equal(h.server.startCalls.length, 1);
});

// ---- a bad install-only setting does not change the provider pi registers at load; the install commands still refuse (plan 03-07, WR-02, T-03-27, T-03-28) ----

test("a bad PI_MLX_MODELS_PIP_INDEX leaves the provider on PI_MLX_MODELS_BASE_URL, and /mlx-init and /mlx-start still refuse naming it", async () => {
  const env = { PI_MLX_MODELS_PIP_INDEX: "http://example.com/simple/", PI_MLX_MODELS_BASE_URL: "http://127.0.0.1:9000/v1" };
  const loaded = await setup({ env });
  assert.equal(loaded.providerCalls[0].config.baseUrl, "http://127.0.0.1:9000/v1");

  const init = await setup({ env });
  await init.commands.get("mlx-init")!("", init.ctx);
  assert.equal(errors(init.notes).length, 1, errors(init.notes).join("|"));
  assert.ok(errors(init.notes)[0].includes("PI_MLX_MODELS_PIP_INDEX"), errors(init.notes)[0]);
  assertNothingHappened(init);

  const start = await setup({ env });
  await startMlx(start, "qwen3_4b");
  assert.equal(errors(start.notes).length, 1, errors(start.notes).join("|"));
  assert.ok(errors(start.notes)[0].includes("PI_MLX_MODELS_PIP_INDEX"), errors(start.notes)[0]);
  assertNothingHappened(start);
});

test("a bad mlxLm.version in the global file leaves the provider on the file's baseUrl, and /mlx-init still refuses naming it", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { baseUrl: "http://127.0.0.1:9100/v1", mlxLm: { version: "^0.32" } });
  const loaded = await setup({ settings });
  assert.equal(loaded.providerCalls[0].config.baseUrl, "http://127.0.0.1:9100/v1");

  await loaded.commands.get("mlx-init")!("", loaded.ctx);
  assert.equal(errors(loaded.notes).length, 1, errors(loaded.notes).join("|"));
  assert.ok(errors(loaded.notes)[0].includes("mlxLm.version"), errors(loaded.notes)[0]);
  assert.equal(loaded.installCalls.length, 0, "nothing was installed");
  assert.deepEqual(loaded.server.startCalls, []);
});

// ---- the before_provider_request hook (GEN-01, GEN-02): provider, model, context, launch, shape, notice (plan 04-03) ----

/** A started qwen3_4b over a global file that sets one temperature, and the registered hook with a ctx that records its notices. */
async function hookSetup(options: Parameters<typeof setup>[0] = {}, file: unknown = { model: { sampling: { temperature: 0.2 } } }) {
  const settings = options.settings ?? freshSettings({});
  writeGlobal(settings, file);
  const h = await setup({ ...options, settings });
  await startMlx(h, "qwen3_4b");
  const hook = h.handlers.get("before_provider_request");
  assert.ok(hook, "the extension registers a before_provider_request handler");
  const hookNotes: Array<{ message: string; type: string | undefined }> = [];
  const hookCtx = (overrides: Record<string, unknown> = {}) => ({
    model: { provider: PROVIDER_ID, id: QWEN.modelId },
    ui: {
      notify(message: string, type?: string) {
        hookNotes.push({ message, type });
      },
    },
    ...overrides,
  });
  return { h, hook, hookNotes, hookCtx };
}

const hookPayload = (extra: Record<string, unknown> = {}) => ({
  model: QWEN.modelId,
  messages: [{ role: "user", content: "hi" }],
  temperature: 0.9,
  ...extra,
});

test("the extension registers exactly the handlers session_shutdown and before_provider_request", async () => {
  const { handlers } = await setup();

  assert.deepEqual([...handlers.keys()].sort(), ["before_provider_request", "session_shutdown"]);
});

test("the hook rewrites a matching request and shows no notice when it does (D-14)", async () => {
  const { hook, hookNotes, hookCtx } = await hookSetup();
  const payload = hookPayload();

  const result = (await hook({ payload }, hookCtx())) as Record<string, unknown>;

  assert.ok(result !== undefined && result !== payload);
  assert.equal(result.temperature, 0.2);
  assert.equal(payload.temperature, 0.9, "pi's object is not mutated");
  assert.deepEqual(hookNotes, []);
});

test("the hook leaves a request for another provider with the same model id untouched", async () => {
  const { hook, hookCtx } = await hookSetup();

  const result = await hook({ payload: hookPayload() }, hookCtx({ model: { provider: "openai", id: QWEN.modelId } }));

  assert.equal(result, undefined);
});

test("the hook leaves a request alone when ctx is undefined", async () => {
  const { hook } = await hookSetup();

  assert.equal(await hook({ payload: hookPayload() }, undefined), undefined);
});

test("the hook leaves a request alone when ctx has no model", async () => {
  const { hook, hookNotes } = await hookSetup();

  assert.equal(await hook({ payload: hookPayload() }, { ui: { notify: () => {} } }), undefined);
  assert.deepEqual(hookNotes, []);
});

test("the hook leaves a request alone when ctx.model has no provider", async () => {
  const { hook, hookCtx } = await hookSetup();

  assert.equal(await hook({ payload: hookPayload() }, hookCtx({ model: { id: QWEN.modelId } })), undefined);
});

test("before any /mlx-start the hook leaves every request untouched", async () => {
  const h = await setup();
  const hook = h.handlers.get("before_provider_request")!;

  const result = await hook({ payload: hookPayload() }, { model: { provider: PROVIDER_ID, id: QWEN.modelId } });

  assert.equal(result, undefined);
});

test("after a start whose server.start rejects the hook leaves every request untouched", async () => {
  const { hook, hookCtx, h } = await hookSetup({
    server: {
      start: async () => {
        throw new Error("boom");
      },
    },
  });

  assert.equal(errors(h.notes).length, 1, errors(h.notes).join("|"));
  assert.equal(await hook({ payload: hookPayload() }, hookCtx()), undefined);
});

test("a payload for another model id is left alone", async () => {
  const { hook, hookCtx } = await hookSetup();

  const result = await hook({ payload: hookPayload({ model: "some/other-model" }) }, hookCtx());

  assert.equal(result, undefined);
});

test("a request for this provider whose model id is not the launched one shows one warning naming the launched id (WR-02)", async () => {
  const { hook, hookNotes, hookCtx } = await hookSetup();
  const payload = hookPayload({ model: "SECRET-MARKER-mismatch" });

  assert.equal(await hook({ payload }, hookCtx()), undefined);
  assert.equal(await hook({ payload: hookPayload({ model: "another/one" }) }, hookCtx()), undefined);

  assert.equal(hookNotes.length, 1, "once per session, however many follow");
  assert.equal(hookNotes[0].type, "warning");
  const text = hookNotes[0].message;
  assert.ok(text.startsWith("pi-mlx-models:"), text);
  assert.ok(text.includes(QWEN.modelId), `names the launched id: ${text}`);
  assert.ok(!text.includes("SECRET-MARKER-mismatch") && !text.includes("another/one"), `no payload text: ${text}`);
  assert.equal(payload.model, "SECRET-MARKER-mismatch", "pi's object is not touched");
});

test("a model id mismatch is not reported for another provider, a matching request or a request with no model id (WR-02)", async () => {
  const { hook, hookNotes, hookCtx } = await hookSetup();

  await hook({ payload: hookPayload({ model: "some/other-model" }) }, hookCtx({ model: { provider: "openai", id: "x" } }));
  await hook({ payload: hookPayload() }, hookCtx());
  await hook({ payload: { messages: [] } }, hookCtx());
  await hook({ payload: hookPayload({ model: 42 }) }, hookCtx());

  assert.deepEqual(hookNotes, []);
});

test("the mismatch warning cleans and clips a long launched model id and is still bounded (WR-02)", async () => {
  const longId = `org/${"m".repeat(300)}\u001b[31mred`;
  const { h, hook, hookNotes, hookCtx } = await hookSetup({}, {});
  await startMlx(h, longId);
  const result = await hook({ payload: hookPayload({ model: "some/other-model" }) }, hookCtx());

  assert.equal(result, undefined);
  assert.equal(hookNotes.length, 1);
  const text = hookNotes[0].message;
  assert.ok(text.length <= 300, `${text.length} characters`);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text), "no control characters");
});

test("a mismatch with a ctx that has no ui does not throw (WR-02)", async () => {
  const { hook, hookCtx } = await hookSetup();

  assert.equal(await hook({ payload: hookPayload({ model: "some/other-model" }) }, { model: hookCtx().model }), undefined);
});

const throwing = (): never => {
  throw new Error("hostile");
};
const hostileInputs: Array<[string, () => { event: unknown; ctx: (base: (o?: Record<string, unknown>) => any) => unknown }]> = [
  ["a null payload", () => ({ event: { payload: null }, ctx: (c) => c() })],
  ["an array payload", () => ({ event: { payload: [1, 2] }, ctx: (c) => c() })],
  ["a string payload", () => ({ event: { payload: "text" }, ctx: (c) => c() })],
  ["a number payload", () => ({ event: { payload: 42 }, ctx: (c) => c() })],
  [
    "a payload whose model getter throws",
    () => ({
      event: {
        payload: {
          get model() {
            return throwing();
          },
          messages: [],
        },
      },
      ctx: (c) => c(),
    }),
  ],
  [
    "a proxy whose get trap throws",
    () => ({
      event: { payload: new Proxy({}, { get: throwing, getPrototypeOf: throwing, has: throwing, ownKeys: throwing }) },
      ctx: (c) => c(),
    }),
  ],
  [
    "a ctx whose model getter throws",
    () => ({
      event: { payload: hookPayload() },
      ctx: () => ({
        get model() {
          return throwing();
        },
      }),
    }),
  ],
];
for (const [name, build] of hostileInputs) {
  test(`the hook never throws on ${name}`, async () => {
    const { hook, hookCtx } = await hookSetup();
    const { event, ctx } = build();

    let result: unknown = "not called";
    await assert.doesNotReject(async () => {
      result = await hook(event, ctx(hookCtx));
    });
    assert.equal(result, undefined);
  });
}

test("a malformed payload for this provider's launched model shows one warning per session, however many follow", async () => {
  const { hook, hookNotes, hookCtx } = await hookSetup();

  assert.equal(await hook({ payload: [1] }, hookCtx()), undefined);
  assert.equal(await hook({ payload: "x" }, hookCtx()), undefined);

  assert.equal(hookNotes.length, 1);
  assert.equal(hookNotes[0].type, "warning");
});

test("the bad-shape warning is a bounded constant that never contains payload text", async () => {
  const marker = "SECRET-MARKER-7f3a";
  const { hook, hookNotes, hookCtx } = await hookSetup();

  await hook({ payload: [marker, { content: marker }] }, hookCtx());

  assert.equal(hookNotes.length, 1);
  const text = hookNotes[0].message;
  assert.ok(text.startsWith("pi-mlx-models:"), text);
  assert.ok(/unexpected shape/.test(text), text);
  assert.ok(text.length <= 200, `${text.length} characters`);
  assert.ok(!text.includes(marker), text);
});

test("an object for the launched model without a messages array triggers the same warning", async () => {
  const marker = "SECRET-MARKER-91bc";
  const { hook, hookNotes, hookCtx } = await hookSetup();

  const result = await hook({ payload: { model: QWEN.modelId, messages: marker, temperature: 0.9 } }, hookCtx());

  assert.equal(result, undefined);
  assert.equal(hookNotes.length, 1);
  assert.equal(hookNotes[0].type, "warning");
  assert.ok(!hookNotes[0].message.includes(marker));
});

test("a bad payload with a ctx that has no ui does not throw", async () => {
  const { hook, hookCtx } = await hookSetup();

  const result = await hook({ payload: [1] }, { model: hookCtx().model });

  assert.equal(result, undefined);
});

test("the template arguments still reach the requests when the probe skips --chat-template-args on mlx-lm 0.24.0 (D-15)", async () => {
  const settings = freshSettings({});
  const { h, hook, hookCtx } = await hookSetup(
    { settings, probe: async () => probeFromHelp("0.24.0", "mlx-server-help-0.24.0.txt") },
    { model: { chatTemplateArgs: { enable_thinking: false } } },
  );

  assert.equal(h.server.launches[0]?.extraArgs.some((arg) => arg.startsWith("--chat-template-args")), false);
  const result = (await hook(
    { payload: hookPayload({ reasoning_effort: "high", chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }) },
    hookCtx(),
  )) as Record<string, unknown>;

  assert.deepEqual(result.chat_template_kwargs, { enable_thinking: false });
  assert.equal("reasoning_effort" in result, false);
});

// ---- the rest of the launch record's life and the request: line in the start message (plan 04-03: D-12, D-13, A7, A8) ----

const T02 = { model: { sampling: { temperature: 0.2 } } };
const OTHER_PRESET = MODEL_PRESETS.find((p) => p.key !== "qwen3_4b")!;
const hookReady = (h: Harness) => {
  const hook = h.handlers.get("before_provider_request");
  assert.ok(hook, "the extension registers a before_provider_request handler");
  return (modelId: string = QWEN.modelId) =>
    hook({ payload: { model: modelId, messages: [{ role: "user", content: "hi" }], temperature: 0.9 } }, { model: { provider: PROVIDER_ID, id: modelId } }) as
      | Record<string, unknown>
      | undefined;
};

test("when the server process exits the hook stops applying the launch's values (assumption A7)", async () => {
  let emit: ((event: ServerEvent) => void) | undefined;
  const settings = freshSettings({});
  writeGlobal(settings, T02);
  const h = await setup({
    settings,
    server: {
      start: async (_model, onEvent) => {
        emit = onEvent;
        onEvent?.({ type: "ready" });
      },
    },
  });
  await startMlx(h, "qwen3_4b");
  const call = hookReady(h);
  assert.equal(call()?.temperature, 0.2, "premise: the values apply while the launch lives");

  emit?.({ type: "exited" });

  assert.equal(call(), undefined);
});

test("a start stopped before server.start resolves never installs a launch record", async () => {
  const gate = deferred();
  let calls = 0;
  const settings = freshSettings({});
  writeGlobal(settings, T02);
  const h = await setup({
    settings,
    server: {
      start: async () => {
        calls += 1;
        await gate.promise;
      },
    },
  });

  const starting = startMlx(h, "qwen3_4b");
  await flush();
  assert.equal(calls, 1, "premise: server.start is in flight");
  await h.commands.get("mlx-stop")!("", h.ctx);
  gate.resolve();
  await starting;

  assert.equal(hookReady(h)(), undefined);
});

test("a superseded start cannot replace the newer start's launch record", async () => {
  const gate = deferred();
  let calls = 0;
  const settings = freshSettings({});
  writeGlobal(settings, T02);
  const h = await setup({
    settings,
    server: {
      start: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
      },
    },
  });

  const first = startMlx(h, "qwen3_4b");
  await flush();
  assert.equal(calls, 1, "premise: the first server.start is in flight");
  writeGlobal(settings, { model: { sampling: { temperature: 0.5 } } });
  await startMlx(h, "qwen3_4b");
  gate.resolve();
  await first;

  assert.equal(hookReady(h)()?.temperature, 0.5);
});

test("a second /mlx-start of another model moves the values to that model (D-13 across launches)", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, T02);
  const h = await setup({ settings });
  await startMlx(h, "qwen3_4b");
  await startMlx(h, OTHER_PRESET.key);
  const call = hookReady(h);

  assert.equal(call(QWEN.modelId), undefined);
  assert.equal(call(OTHER_PRESET.modelId)?.temperature, 0.2);
});

test("a second start whose server.start rejects leaves no record for the first model", async () => {
  let calls = 0;
  const settings = freshSettings({});
  writeGlobal(settings, T02);
  const h = await setup({
    settings,
    server: {
      start: async (_model, onEvent) => {
        calls += 1;
        if (calls === 2) throw new Error("boom");
        onEvent?.({ type: "ready" });
      },
    },
  });
  await startMlx(h, "qwen3_4b");
  assert.equal(hookReady(h)()?.temperature, 0.2, "premise: the first launch applies");

  await startMlx(h, "qwen3_4b");

  assert.equal(errors(h.notes).length, 1, errors(h.notes).join("|"));
  assert.equal(hookReady(h)(), undefined);
});

test("editing the config between two starts: the second launch's values apply", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, T02);
  const h = await setup({ settings });
  await startMlx(h, "qwen3_4b");
  assert.equal(hookReady(h)()?.temperature, 0.2);

  writeGlobal(settings, { model: { sampling: { temperature: 0.5 } } });
  await startMlx(h, "qwen3_4b");

  assert.equal(hookReady(h)()?.temperature, 0.5);
});

test("the start message lists the values that have no server flag on a request: line after the flags line", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { model: { sampling: { repetitionPenalty: 1.1, stop: ["END"], seed: 7, temperature: 0.2 } } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");

  assert.equal(startingNotes(h.notes).length, 1);
  assert.equal(
    startingNotes(h.notes)[0],
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --temp 0.2 (global file)\nrequest: repetition_penalty 1.1 (global file), stop ["END"] (global file), seed 7 (global file)`,
  );
});

test("with only a request-only value there is no flags line and the request: line is the second line", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { model: { sampling: { repetitionPenalty: 1.1 } } });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");

  assert.equal(
    startingNotes(h.notes)[0],
    `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nrequest: repetition_penalty 1.1 (global file)`,
  );
});

test("a launch with only server-capable sampling values has no request: line and reads as before", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, T02);
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");

  assert.equal(startingNotes(h.notes)[0], `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nflags: --temp 0.2 (global file)`);
});

// ---- profiles and the trust boundary (plan 04-05: CFG-04, D-03, D-04, T-04-13) ----

test("a project profile that asks for trustRemoteCode ends the start with a configuration error, no dialog and no side effect", async () => {
  const cwd = newCwd();
  writeProject(cwd, { models: { qwen3_4b: { profiles: { fast: { trustRemoteCode: true } } } } });
  const h = await setup({ ctx: { cwd } });

  await startMlx(h, "qwen3_4b --profile fast");

  assert.deepEqual(errors(h.notes), [
    'mlx-start failed: invalid configuration\n  models["qwen3_4b"].profiles["fast"].trustRemoteCode (project .pi/pi-mlx-models.json): unknown key (trustRemoteCode is a "server" key, not part of a profile)',
  ]);
  assert.equal(h.confirms.length, 0, "no dialog was asked");
  assertNothingHappened(h);
});

test("a profile adds no trust dialog and removes none: the dialogs of a start are the same with and without --profile", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, {
    server: { trustRemoteCode: true },
    models: { qwen3_4b: { profiles: { fast: { sampling: { temperature: 0.2 } } } } },
  });
  const h = await setup({ settings });

  await startMlx(h, "qwen3_4b");
  const without = h.confirms.splice(0);
  await startMlx(h, "qwen3_4b --profile fast");
  const withProfile = h.confirms.splice(0);

  assert.deepEqual(errors(h.notes), []);
  assert.ok(without.length > 0, "premise: a global trustRemoteCode asks");
  assert.deepEqual(withProfile, without);
  assert.deepEqual(h.server.startCalls, [QWEN.modelId, QWEN.modelId], "both starts went through");
});

// ---- --profile through every start path, and the refusals before any side effect (plan 04-05: CFG-04, D-02, D-06) ----

const FAST_GLOBAL = { models: { qwen3_4b: { profiles: { fast: { sampling: { temperature: 0.2 } } } } } };
const FAST_START = `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...\nprofile: fast (/mlx-start)\nflags: --temp 0.2 (profile fast)`;

/** A harness whose global file holds the `fast` profile of qwen3_4b. */
async function profileHarness(options: Parameters<typeof setup>[0] = {}) {
  const settings = freshSettings({});
  writeGlobal(settings, FAST_GLOBAL);
  return setup({ settings, ...options });
}

test("--profile NAME after a typed model starts it with the profile: the profile line and the profile-labelled flag", async () => {
  const h = await profileHarness();

  await startMlx(h, "qwen3_4b --profile fast");

  assert.deepEqual(errors(h.notes), []);
  assert.deepEqual(h.server.startCalls, [QWEN.modelId]);
  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--temp=0.2"]);
  assert.deepEqual(startingNotes(h.notes), [FAST_START]);
});

test("--profile=NAME, the attached form, gives the same start", async () => {
  const h = await profileHarness();

  await startMlx(h, "qwen3_4b --profile=fast");

  assert.deepEqual(errors(h.notes), []);
  assert.deepEqual(startingNotes(h.notes), [FAST_START]);
});

test("--profile works through the picker: the chosen preset starts with the profile applied", async () => {
  const h = await profileHarness({ select: (options) => options[3] });

  await startMlx(h, "--profile fast");

  assert.deepEqual(errors(h.notes), []);
  assert.deepEqual(h.server.startCalls, [QWEN.modelId]);
  assert.deepEqual(h.server.launches[0]?.extraArgs, ["--temp=0.2"]);
  assert.deepEqual(startingNotes(h.notes), [FAST_START]);
});

test("--profile works with the mlx-model pi flag naming the model", async () => {
  const h = await profileHarness();
  h.setFlag("mlx-model", "qwen3_4b");

  await startMlx(h, "--profile fast");

  assert.deepEqual(errors(h.notes), []);
  assert.deepEqual(h.server.startCalls, [QWEN.modelId]);
  assert.deepEqual(startingNotes(h.notes), [FAST_START]);
});

test("--profile with no value is refused by the parser before anything happens", async () => {
  const h = await profileHarness();

  await startMlx(h, "qwen3_4b --profile");

  assert.deepEqual(errors(h.notes), ["mlx-start failed: --profile needs a value"]);
  assertNothingHappened(h);
});

for (const [shape, input] of [
  ["--profile=", "qwen3_4b --profile="],
  ["--profile with an empty quoted value", 'qwen3_4b --profile ""'],
] as const) {
  test(`${shape} is refused for its empty name before any file is read`, async () => {
    // The global path is a directory, so reading it would add an invalid-configuration error to the one expected here.
    const dir = mkdtempSync(join(tmpdir(), "pi-mlx-unreadable-"));
    const h = await setup({ settings: { env: {}, globalConfigPath: dir, home: dir } });

    await startMlx(h, input);

    assert.deepEqual(errors(h.notes), ["mlx-start failed: --profile needs a profile name"]);
    assertNothingHappened(h);
  });
}

test("--profile given twice is refused", async () => {
  const h = await profileHarness();

  await startMlx(h, "qwen3_4b --profile fast --profile careful");

  assert.deepEqual(errors(h.notes), ["mlx-start failed: --profile was given twice"]);
  assertNothingHappened(h);
});

test("an unknown profile ends with one error naming the available profiles, before any install, probe, provider refresh or spawn", async () => {
  const h = await profileHarness();

  await startMlx(h, "qwen3_4b --profile nope");

  assert.deepEqual(errors(h.notes), [
    `mlx-start failed: invalid configuration\n  profile "nope" (/mlx-start --profile): not defined for ${QWEN.modelId}; available profiles: fast`,
  ]);
  assertNothingHappened(h);
  assert.equal(h.probeCalls, 0);
});

test("/mlx-init refuses --profile as an unknown flag and lists only its own flags", async () => {
  const h = await profileHarness();

  await h.commands.get("mlx-init")!("--profile fast", h.ctx);

  const list = initFlagSpecs().map((spec) => spec.flag);
  assert.ok(!list.includes("--profile"));
  assert.deepEqual(errors(h.notes), [`mlx-init failed: unknown flag --profile (valid flags: ${list.join(", ")})`]);
  assert.equal(h.installCalls.length, 0);
});

test("nothing is remembered: the next start of the same model without --profile has no profile line and no profile flag", async () => {
  const h = await profileHarness();
  await startMlx(h, "qwen3_4b --profile fast");

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(errors(h.notes), []);
  assert.equal(startingNotes(h.notes)[0], FAST_START);
  assert.equal(startingNotes(h.notes)[1], `Starting MLX server with ${QWEN.modelId} (preset: qwen3_4b)...`);
  assert.deepEqual(h.server.launches[1]?.extraArgs, []);
});

test("a hostile profile name is shown without control characters", async () => {
  const h = await profileHarness();

  await startMlx(h, `qwen3_4b --profile "fast\u001b]0;pwned\u0007"`);

  const [message] = errors(h.notes);
  assert.equal(errors(h.notes).length, 1);
  assert.ok(message.startsWith("mlx-start failed: invalid configuration\n  profile "), message);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(message), JSON.stringify(message));
  assertNothingHappened(h);
});

// ---- which models the provider lists (MOD-04) ----

test("by default a start registers only the launched model although the server reports others", async () => {
  const { commands, ctx, providerCalls } = await setup({ discovered: [MODEL_PRESETS[3].modelId, "org/a", "org/b"] });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(modelIdsOf(providerCalls.at(-1)), [MODEL_PRESETS[3].modelId]);
});

test("with provider.listAllModels true in the global file a start registers every model the server reports, in order", async () => {
  const settings = freshSettings({});
  writeFileSync(settings.globalConfigPath, '{"provider":{"listAllModels":true}}');
  const { commands, ctx, providerCalls } = await setup({
    settings,
    discovered: [MODEL_PRESETS[3].modelId, "org/a", "org/b"],
  });

  await commands.get("mlx-start")!("qwen3_4b", ctx);

  assert.deepEqual(modelIdsOf(providerCalls.at(-1)), [MODEL_PRESETS[3].modelId, "org/a", "org/b"]);
});

test("by default the model discovery is never asked: not at load, not for a start, not for a stop and not at shutdown", async () => {
  const h = await setup({ discovered: [QWEN.modelId, "org/a", "org/b"], sleep: never });
  assert.equal(h.discoveryCalls, 0, "after the load-time registration");

  await startMlx(h, "qwen3_4b");
  assert.equal(h.discoveryCalls, 0, "after a start");

  await h.commands.get("mlx-stop")!("", h.ctx);
  assert.equal(h.discoveryCalls, 0, "after /mlx-stop");

  await h.handlers.get("session_shutdown")!();
  assert.equal(h.discoveryCalls, 0, "after session_shutdown");
});

test("by default nothing is listed before a start, and a start registers twice: an empty list before it, the launched model after ready", async () => {
  const h = await setup({ discovered: [QWEN.modelId, "org/a"] });

  assert.deepEqual(h.providerCalls.map(modelIdsOf), [[]], "the load-time registration lists nothing although the server reports models");

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(h.providerCalls.map(modelIdsOf), [[], [], [QWEN.modelId]]);
});

test("provider.listAllModels true in the global file is honoured at load, and a stop registers whatever discovery reports then", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { provider: { listAllModels: true } });
  const options = { settings, discovered: [QWEN.modelId, "org/a"], sleep: never };
  const h = await setup(options);

  assert.deepEqual(modelIdsOf(h.providerCalls[0]), [QWEN.modelId, "org/a"], "the load-time list is the discovery result");

  options.discovered = ["org/c"];
  await h.commands.get("mlx-stop")!("", h.ctx);
  assert.deepEqual(modelIdsOf(h.providerCalls.at(-1)), ["org/c"]);

  options.discovered = [];
  await h.handlers.get("session_shutdown")!();
  assert.deepEqual(modelIdsOf(h.providerCalls.at(-1)), []);
});

test("in the all-models list a discovered id with control characters keeps its id and gets a clean display name", async () => {
  const hostile = "org/model\u001b]0;pwned\u0007\u009b31m";
  const settings = freshSettings({});
  writeGlobal(settings, { provider: { listAllModels: true } });
  const { providerCalls } = await setup({ settings, discovered: [hostile] });

  const [model] = providerCalls[0].config.models as Array<{ id: string; name: string }>;

  assert.equal(model.id, hostile);
  assert.doesNotMatch(model.name, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(model.name, /^org\/model/);
});

test("with provider.listAllModels true and nothing discovered the list is empty before a start and the launched model after ready", async () => {
  const settings = freshSettings({});
  writeGlobal(settings, { provider: { listAllModels: true } });
  const h = await setup({ settings, discovered: [] });

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(h.providerCalls.map(modelIdsOf), [[], [], [QWEN.modelId]]);
});

test("a project file holding provider.listAllModels true is honoured by the start that reads it, with no refusal", async () => {
  const cwd = newCwd();
  writeProject(cwd, { provider: { listAllModels: true } });
  const h = await setup({ ctx: { cwd }, discovered: [QWEN.modelId, "org/a"] });
  assert.deepEqual(modelIdsOf(h.providerCalls[0]), [], "the project file is not read at load");

  await startMlx(h, "qwen3_4b");

  assert.deepEqual(errors(h.notes), []);
  assert.deepEqual(modelIdsOf(h.providerCalls.at(-1)), [QWEN.modelId, "org/a"]);
});

test("by default a stop and a shutdown register an empty list, a new start replaces the old list, and pi's unregisterProvider is not needed", async () => {
  const h = await setup({ discovered: [QWEN.modelId, "org/a"], sleep: never });
  assert.ok(!("unregisterProvider" in h.pi), "premise: the fake pi has no unregisterProvider");

  await startMlx(h, "qwen3_4b");
  assert.deepEqual(modelIdsOf(h.providerCalls.at(-1)), [QWEN.modelId]);

  await h.commands.get("mlx-stop")!("", h.ctx);
  assert.deepEqual(modelIdsOf(h.providerCalls.at(-1)), []);

  await startMlx(h, QWEN.key);
  await startMlx(h, OTHER_PRESET.key);
  assert.deepEqual(modelIdsOf(h.providerCalls.at(-1)), [OTHER_PRESET.modelId], "the second start replaces the first list");

  await h.handlers.get("session_shutdown")!();
  assert.deepEqual(modelIdsOf(h.providerCalls.at(-1)), []);
  assert.deepEqual(errors(h.notes), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// The model line and the metadata step (MOD-01, D-03)
// ---------------------------------------------------------------------------------------------------------------------

const QWEN_ID = MODEL_PRESETS[3].modelId;
const READY_NOTE = "MLX server is ready for prompts. Use /model and pick pi-mlx-models/...";
const modelNotes = (notes: Note[]) => notes.filter((n) => n.message.startsWith("model: context "));

test("a completed start shows one model line after the registration and before the unchanged ready message", async () => {
  const stand = makeFakeModelConfig({ [QWEN_ID]: { max_position_embeddings: 262144 } });
  const h = await setup({ readModelConfig: stand.read });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  const lines = modelNotes(h.notes);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "info");
  assert.equal(
    lines[0].message,
    "model: context 262144 (config.json), max output 8192 (default), reasoning no (preset), input text (default)",
  );
  const registered = h.providerCalls.at(-1)?.config.models[0];
  assert.equal(registered.contextWindow, 262144);
  assert.equal(registered.maxTokens, 8192);
  const messages = h.notes.map((n) => n.message);
  const starting = messages.findIndex((m) => m.startsWith("Starting MLX server with"));
  assert.ok(starting >= 0);
  assert.ok(starting < messages.indexOf(lines[0].message));
  assert.equal(messages.indexOf(lines[0].message) + 1, messages.indexOf(READY_NOTE));
  assert.equal(messages.at(-1), READY_NOTE);
  assert.deepEqual(stand.calls, [{ modelId: QWEN_ID, hub: true }]);
});

test("the reader is asked once per start with the launched id, and not at all for a refused or failed start", async () => {
  const ok = await setup();
  await ok.commands.get("mlx-start")!("qwen3_4b", ok.ctx);
  assert.deepEqual(ok.readCalls, [{ modelId: QWEN_ID, hub: true }]);

  const refused = await setup();
  await refused.commands.get("mlx-start")!("qwen3_4b --port notanumber", refused.ctx);
  assert.equal(refused.server.startCalls.length, 0);
  assert.deepEqual(refused.readCalls, []);

  const failed = await setup({
    server: {
      start: async () => {
        throw new Error("server failed before ready");
      },
    },
  });
  await failed.commands.get("mlx-start")!("qwen3_4b", failed.ctx);
  assert.equal(failed.server.startCalls.length, 1);
  assert.deepEqual(failed.readCalls, []);
  assert.equal(modelNotes(failed.notes).length, 0);
});

test("a /mlx-stop that arrives while the model is being read abandons the start", async () => {
  const gate = deferred<{ ok: true; config: unknown; source: "cache" }>();
  let reads = 0;
  const h = await setup({
    readModelConfig: async () => {
      reads += 1;
      return gate.promise;
    },
  });

  const started = h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  for (let i = 0; i < 50 && reads === 0; i += 1) await flush();
  assert.equal(reads, 1, "the start is waiting on the read");
  await h.commands.get("mlx-stop")!("", h.ctx);
  const registrations = h.providerCalls.length;

  gate.resolve({ ok: true, config: { max_position_embeddings: 262144 }, source: "cache" });
  await started;
  await flush();

  assert.equal(h.providerCalls.length, registrations, "nothing is registered after the stop's own registration");
  assert.deepEqual(h.providerCalls.at(-1)?.config.models, []);
  assert.equal(modelNotes(h.notes).length, 0);
  assert.equal(h.notes.some((n) => n.message === READY_NOTE), false);
});

test("a reader that rejects, and one that throws, give the fallback window and a start that succeeds", async () => {
  const rejecting = await setup({ readModelConfig: () => Promise.reject(new Error("reader rejected")) });
  await rejecting.commands.get("mlx-start")!("qwen3_4b", rejecting.ctx);

  const throwing = await setup({
    readModelConfig: (() => {
      throw new Error("reader threw");
    }) as unknown as ReadModelConfig,
  });
  await throwing.commands.get("mlx-start")!("qwen3_4b", throwing.ctx);

  for (const h of [rejecting, throwing]) {
    assert.deepEqual(errors(h.notes), []);
    assert.equal(h.notes.at(-1)?.message, READY_NOTE);
    assert.equal(h.providerCalls.at(-1)?.config.models[0].contextWindow, 32768);
    assert.ok(modelNotes(h.notes)[0].message.startsWith("model: context 32768 (fallback), "));
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The fallback warning (MOD-01, D-03)
// ---------------------------------------------------------------------------------------------------------------------

const HTTP_401: ModelConfigRead = { ok: false, reason: "the Hugging Face Hub answered HTTP 401" };
const fallbackWarnings = (notes: Note[]) =>
  notes.filter((n) => n.type === "warning" && n.message.startsWith("context window unavailable for ")).map((n) => n.message);

test("a model whose config.json cannot be read still starts, with the fallback window and exactly one warning naming the reason", async () => {
  const h = await setup({ readModelConfig: makeFakeModelConfig({}, HTTP_401).read });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(errors(h.notes), []);
  assert.equal(h.notes.at(-1)?.message, READY_NOTE);
  assert.equal(h.providerCalls.at(-1)?.config.models[0].contextWindow, 32768);
  assert.ok(modelNotes(h.notes)[0].message.startsWith("model: context 32768 (fallback), "));
  assert.deepEqual(warnings(h.notes), [
    `context window unavailable for ${QWEN_ID} (the Hugging Face Hub answered HTTP 401); using 32768`,
  ]);
});

test("the fallback warning is shown once per model id and reason: the same pair again is silent, another model or reason is not", async () => {
  let reason = "the Hugging Face Hub answered HTTP 401";
  const h = await setup({ readModelConfig: async () => ({ ok: false, reason }) });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  assert.equal(fallbackWarnings(h.notes).length, 1, "the same model and reason twice");

  await h.commands.get("mlx-start")!(OTHER_PRESET.key, h.ctx);
  assert.equal(fallbackWarnings(h.notes).length, 2, "another model, the same reason");

  reason = "the Hugging Face Hub did not answer within 3000 ms";
  await h.commands.get("mlx-start")!(OTHER_PRESET.key, h.ctx);
  assert.equal(fallbackWarnings(h.notes).length, 3, "the same model, another reason");
  assert.match(fallbackWarnings(h.notes)[2], /did not answer within 3000 ms/);
});

test("the fallback warning comes before the model line and both come before the ready message", async () => {
  const h = await setup({ readModelConfig: makeFakeModelConfig({}, HTTP_401).read });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  const messages = h.notes.map((n) => n.message);
  const warning = messages.findIndex((m) => m.startsWith("context window unavailable for "));
  const line = messages.findIndex((m) => m.startsWith("model: context "));
  assert.ok(warning >= 0 && line >= 0);
  assert.ok(warning < line, "the warning precedes the model line");
  assert.equal(line + 1, messages.indexOf(READY_NOTE), "the ready message follows the model line");
});

test("the fallback warning is one clean line: control characters and credentials are gone and both parts are clipped", async () => {
  const hostileId = "org/model\u001b]0;pwned\u0007\u009b31m";
  const hostileReason = `failed via https://user:secret@host/path ${"x".repeat(500)}`;
  const h = await setup({ readModelConfig: makeFakeModelConfig({}, { ok: false, reason: hostileReason }).read });

  await h.commands.get("mlx-start")!(hostileId, h.ctx);

  assert.equal(h.server.startCalls.length, 1, "premise: the start went ahead");
  const [message] = fallbackWarnings(h.notes);
  assert.ok(message !== undefined, "a fallback warning was shown");
  assert.doesNotMatch(message, /[\u0000-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(message, /secret/);
  const parts = /^context window unavailable for ([^()]*) \((.*)\); using 32768$/.exec(message);
  assert.ok(parts, `unexpected shape: ${message}`);
  assert.ok(parts[1].length > 0 && parts[1].length <= 80, "the id part is at most 80 characters");
  assert.ok(parts[2].length > 0 && parts[2].length <= 160, "the reason part is at most 160 characters");
});

test("a readable config.json produces no warning at all", async () => {
  const h = await setup({ readModelConfig: makeFakeModelConfig({ [QWEN_ID]: { max_position_embeddings: 262144 } }).read });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(warnings(h.notes), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// The other listed models (MOD-04, D-12): local metadata and one aggregate warning
// ---------------------------------------------------------------------------------------------------------------------

const NOT_CACHED: ModelConfigRead = { ok: false, reason: "not in the Hugging Face cache" };
const windowsOf = (call: ProviderCall | undefined) =>
  Object.fromEntries((call?.config.models as Array<{ id: string; contextWindow: number }>).map((m) => [m.id, m.contextWindow]));

/** A harness with `provider.listAllModels` true in the global file; org/cached has a readable 65536 window, other ids none. */
async function setupListAll(discovered: string[], extra: { ids?: Record<string, unknown>; otherwise?: ModelConfigRead } = {}) {
  const settings = freshSettings({});
  writeGlobal(settings, { provider: { listAllModels: true } });
  const stand = makeFakeModelConfig(
    { [QWEN_ID]: { max_position_embeddings: 262144 }, "org/cached": { max_position_embeddings: 65536 }, ...extra.ids },
    extra.otherwise ?? NOT_CACHED,
  );
  const h = await setup({ settings, discovered, readModelConfig: stand.read });
  return { ...h, stand };
}

test("with provider.listAllModels true each other listed model gets its own window where it is cached and 32768 where it is not", async () => {
  const h = await setupListAll([QWEN_ID, "org/cached", "org/missing"]);

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(windowsOf(h.providerCalls.at(-1)), { [QWEN_ID]: 262144, "org/cached": 65536, "org/missing": 32768 });
});

test("the launched model is read once with the Hub allowed and every other listed model only locally, never again by the registration", async () => {
  const h = await setupListAll([QWEN_ID, "org/cached", "org/missing"]);

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  const withHub = h.stand.calls.filter((call) => call.hub);
  assert.deepEqual(withHub, [{ modelId: QWEN_ID, hub: true }]);
  assert.ok(h.stand.calls.some((call) => call.modelId === "org/cached" && !call.hub), "org/cached was read locally");
  assert.ok(h.stand.calls.some((call) => call.modelId === "org/missing" && !call.hub), "org/missing was read locally");
  const afterLaunchedRead = h.stand.calls.slice(h.stand.calls.indexOf(withHub[0]) + 1);
  assert.equal(
    afterLaunchedRead.some((call) => call.modelId === QWEN_ID),
    false,
    "the registration after ready uses the launched model's own record",
  );
});

test("the unreadable other models give one aggregate warning that has their count and the first reason and names none of them", async () => {
  const h = await setupListAll([QWEN_ID, "org/cached", "org/missing"]);

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(warnings(h.notes), [
    "context window unavailable for 1 other listed model (not in the Hugging Face cache); using 32768 for it",
  ]);
  assert.equal(warnings(h.notes).some((message) => message.includes("org/missing")), false);
});

test("with provider.listAllModels false nothing but the launched model is read", async () => {
  const stand = makeFakeModelConfig({ [QWEN_ID]: { max_position_embeddings: 262144 } }, NOT_CACHED);
  const h = await setup({ discovered: [QWEN_ID, "org/cached", "org/missing"], readModelConfig: stand.read });

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.deepEqual(stand.calls, [{ modelId: QWEN_ID, hub: true }]);
  assert.deepEqual(warnings(h.notes), []);
});

test("at load the other listed models are read locally and registered with their metadata, with no warning because there is no command context", async () => {
  const h = await setupListAll(["org/cached", "org/missing"]);

  assert.deepEqual(h.stand.calls, [
    { modelId: "org/cached", hub: false },
    { modelId: "org/missing", hub: false },
  ]);
  assert.deepEqual(windowsOf(h.providerCalls[0]), { "org/cached": 65536, "org/missing": 32768 });
  assert.deepEqual(warnings(h.notes), []);
});

test("an other listed model whose id has control characters is read under its own id, shown with a clean name, and named nowhere in the warning", async () => {
  const hostile = "org/model\u001b]0;pwned\u0007\u009b31m";
  const h = await setupListAll([QWEN_ID, hostile]);

  await h.commands.get("mlx-start")!("qwen3_4b", h.ctx);

  assert.ok(h.stand.calls.some((call) => call.modelId === hostile && !call.hub), "the reader got the id unchanged");
  const model = (h.providerCalls.at(-1)?.config.models as Array<{ id: string; name: string; contextWindow: number }>).find(
    (m) => m.id === hostile,
  );
  assert.ok(model, "the hostile id is registered");
  assert.equal(model.contextWindow, 32768);
  assert.doesNotMatch(model.name, /[\u0000-\u001f\u007f-\u009f]/);
  const [message] = warnings(h.notes);
  assert.ok(message !== undefined, "an aggregate warning was shown");
  assert.doesNotMatch(message, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(message.includes("pwned") || message.includes("org/model"), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// A server that exits while a start is still reading the model (carry-over from plan 05-02)
// ---------------------------------------------------------------------------------------------------------------------

test("a server that exits while the model's config.json is being read ends the start without a ready note, model line, warning or registration", async () => {
  const gate = deferred<ModelConfigRead>();
  let reads = 0;
  let emit: ((event: ServerEvent) => void) | undefined;
  const h = await setup({
    server: {
      start: async (_model, onEvent) => {
        emit = onEvent;
        for (const type of ["launched", "loading", "warming", "ready"] as const) onEvent?.({ type });
      },
    },
    readModelConfig: async () => {
      reads += 1;
      return gate.promise;
    },
  });

  const started = h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  for (let i = 0; i < 50 && reads === 0; i += 1) await flush();
  assert.equal(reads, 1, "the start is waiting on the read");
  emit?.({ type: "exited" });
  const registrations = h.providerCalls.length;

  gate.resolve({ ok: false, reason: "the Hugging Face Hub answered HTTP 401" });
  await started;
  await flush();

  assert.equal(h.providerCalls.length, registrations, "nothing is registered after the server exited");
  assert.deepEqual(h.providerCalls.at(-1)?.config.models, []);
  assert.equal(modelNotes(h.notes).length, 0, "no model line");
  assert.deepEqual(fallbackWarnings(h.notes), []);
  assert.equal(h.notes.some((n) => n.message === READY_NOTE), false, "no ready message");
  assert.equal(lastStatus(h.statuses), "mlx: stopped");
});

test("a server that exits while the other listed models are being read ends the start before its registration, model line and ready message", async () => {
  const gate = deferred<ModelConfigRead>();
  let hold = false;
  let held = 0;
  let emit: ((event: ServerEvent) => void) | undefined;
  const settings = freshSettings({});
  writeGlobal(settings, { provider: { listAllModels: true } });
  const h = await setup({
    settings,
    discovered: [QWEN_ID, "org/cached"],
    server: {
      start: async (_model, onEvent) => {
        emit = onEvent;
        for (const type of ["launched", "loading", "warming", "ready"] as const) onEvent?.({ type });
        hold = true;
      },
    },
    readModelConfig: async (id) => {
      if (hold && id === "org/cached") {
        held += 1;
        return gate.promise;
      }
      return { ok: true, config: { max_position_embeddings: 65536 }, source: "cache" };
    },
  });

  const started = h.commands.get("mlx-start")!("qwen3_4b", h.ctx);
  for (let i = 0; i < 50 && held === 0; i += 1) await flush();
  assert.equal(held, 1, "the post-ready registration is waiting on a read");
  emit?.({ type: "exited" });
  const registrations = h.providerCalls.length;

  gate.resolve({ ok: true, config: { max_position_embeddings: 65536 }, source: "cache" });
  await started;
  await flush();

  assert.equal(h.providerCalls.length, registrations, "nothing is registered after the server exited");
  assert.equal(modelNotes(h.notes).length, 0, "no model line");
  assert.equal(h.notes.some((n) => n.message === READY_NOTE), false, "no ready message");
  assert.equal(lastStatus(h.statuses), "mlx: stopped");
});

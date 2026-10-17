import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_ID } from "./config.js";
import { createExtension, type PiHost } from "./index.js";
import { MODEL_PRESETS } from "./presets.js";
import type { MlxServer, ServerEvent } from "./server.js";

type Handler = (args: string, ctx: any) => Promise<void>;
type ProviderCall = { name: string; config: any };
type Note = { message: string; type: string };

/** A fake pi that records what the extension registers, so tests can drive the handlers directly. */
function makeFakePi() {
  const commands = new Map<string, Handler>();
  const handlers = new Map<string, () => Promise<void> | void>();
  const providerCalls: ProviderCall[] = [];
  const pi: PiHost = {
    registerCommand(name, options) {
      commands.set(name, options.handler);
    },
    registerProvider(name, config) {
      providerCalls.push({ name, config });
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  return { pi, commands, handlers, providerCalls };
}

/** A fake ctx.ui; `select` decides what the picker returns (default: the first option). */
function makeCtx(select: (options: string[]) => string | undefined = (options) => options[0]) {
  const notes: Note[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const widgets: Array<{ id: string; lines: string[] | undefined }> = [];
  const ctx = {
    ui: {
      notify(message: string, type: string) {
        notes.push({ message, type });
      },
      async select(_title: string, options: string[]) {
        return select(options);
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
      setWidget(id: string, lines: string[] | undefined) {
        widgets.push({ id, lines });
      },
    },
  };
  return { ctx, notes, statuses, widgets };
}

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
    baseUrl: "http://127.0.0.1:1/v1",
    configWarnings: [],
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

/** An extension over a fresh fake pi, with a counting installer that succeeds unless told otherwise. */
async function setup(
  options: { server?: FakeServerOptions; ensureInstalled?: (opts?: any) => Promise<void>; discovered?: string[]; select?: (options: string[]) => string | undefined } = {},
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
    baseUrl: "http://127.0.0.1:1/v1",
    configWarnings: [],
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
  assert.equal(providerCalls[0].config.baseUrl, "http://127.0.0.1:1/v1");
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

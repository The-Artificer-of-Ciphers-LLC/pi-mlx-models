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

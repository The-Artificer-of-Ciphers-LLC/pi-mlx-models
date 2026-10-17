import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BASE_URL, CONFIG_WARNINGS, DEFAULT_MODEL, PROVIDER_ID } from "./config.js";
import { cleanLabel } from "./diagnostic.js";
import { discoverModelIds } from "./discovery.js";
import { MODEL_PRESETS, resolveModel, type ModelPreset } from "./presets.js";
import { createProgress, type Progress } from "./progress.js";
import { ensureInstalled, type RuntimeEvent } from "./runtime.js";
import { createMlxServer, type MlxServer } from "./server.js";

const PROGRESS_WIDGET = "mlx-progress";
const PICKER_WIDGET = "mlx-preset-picker";

/** The part of pi's ExtensionAPI this extension uses; tests supply a fake. */
export interface PiHost {
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: any) => Promise<void> },
  ): void;
  registerProvider(name: string, config: any): void;
  on(event: "session_shutdown", handler: () => Promise<void> | void): void;
}

/** Everything the extension reaches outside itself for, injectable so tests need no process, network or port. */
export interface ExtensionDeps {
  server: MlxServer;
  ensureInstalled: typeof ensureInstalled;
  discoverModelIds: () => Promise<string[]>;
  baseUrl: string;
  defaultModel: string;
  configWarnings: readonly string[];
  /** How long session_shutdown waits for the server to stop before letting pi exit. */
  shutdownWaitMs: number;
  sleep: (ms: number) => Promise<void>;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function pickPreset(ctx: any): Promise<ModelPreset | undefined> {
  const options = MODEL_PRESETS.map((p, i) => `${i + 1}. ${p.key} — ${p.tags.slice(0, 2).join(", ")}`);
  const selected = await ctx.ui.select("Select MLX model preset", options);
  if (!selected) return undefined;
  const idx = options.indexOf(selected);
  if (idx < 0) return undefined;
  return MODEL_PRESETS[idx];
}

function asProviderModels(ids: string[]) {
  return ids.map((id) => ({
    id,
    // The id is what the server expects; only the display name is cleaned of terminal control characters.
    name: `${cleanLabel(id)} (Local)`,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }));
}

const INIT_STEPS: Record<RuntimeEvent["phase"], number> = { python: 0, venv: 1, pip: 2, "mlx-lm": 3 };

/** A sleep whose timer never keeps the process alive. */
const unrefSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

function withDefaults(overrides: Partial<ExtensionDeps>): ExtensionDeps {
  const baseUrl = overrides.baseUrl ?? BASE_URL;
  return {
    server: overrides.server ?? createMlxServer(),
    ensureInstalled: overrides.ensureInstalled ?? ensureInstalled,
    discoverModelIds: overrides.discoverModelIds ?? (() => discoverModelIds({ baseUrl })),
    baseUrl,
    defaultModel: overrides.defaultModel ?? DEFAULT_MODEL,
    configWarnings: overrides.configWarnings ?? CONFIG_WARNINGS,
    shutdownWaitMs: overrides.shutdownWaitMs ?? 5000,
    sleep: overrides.sleep ?? unrefSleep,
  };
}

/** Build the extension. All mutable state lives in this closure, so each call is an independent instance. */
export function createExtension(overrides: Partial<ExtensionDeps> = {}) {
  const deps = withDefaults(overrides);
  const { server } = deps;
  let currentModel = deps.defaultModel;
  let activeProgress: Progress | null = null;
  let configWarningsShown = false;

  /**
   * Bumped by every /mlx-start, /mlx-init, /mlx-stop and session_shutdown. A flow compares its own value
   * after each await: if it moved, the flow was stopped or superseded and must not touch the server or UI.
   */
  let epoch = 0;

  /** The one runtime install that may touch the venv at a time. */
  let installing: { promise: Promise<void>; upgrade: boolean; listeners: Set<(event: RuntimeEvent) => void> } | null = null;

  /**
   * Run (or join) the runtime install. Concurrent callers never run two installs in one venv: a caller
   * that a running install already satisfies shares it (and its progress events); an upgrade request
   * waits for a plain install to finish and then runs its own.
   */
  async function install(options: { upgrade: boolean; onEvent: (event: RuntimeEvent) => void }): Promise<void> {
    while (installing && options.upgrade && !installing.upgrade) await installing.promise.catch(() => {});
    if (installing) {
      installing.listeners.add(options.onEvent);
      return installing.promise;
    }
    const listeners = new Set([options.onEvent]);
    const promise: Promise<void> = deps
      .ensureInstalled({
        ...(options.upgrade ? { upgrade: true } : {}),
        onEvent: (event) => listeners.forEach((listener) => listener(event)),
      })
      .finally(() => {
        if (installing?.promise === promise) installing = null;
      });
    installing = { promise, upgrade: options.upgrade, listeners };
    return promise;
  }

  async function registerProvider(pi: PiHost, options?: { includeFallback?: boolean }) {
    const discovered = await deps.discoverModelIds();
    const includeFallback = options?.includeFallback ?? false;
    const modelIds = discovered.length ? discovered : includeFallback ? [currentModel] : [];

    pi.registerProvider(PROVIDER_ID, {
      name: "PI MLX Models",
      baseUrl: deps.baseUrl,
      apiKey: "DUMMY",
      api: "openai-completions",
      models: asProviderModels(modelIds),
    });
  }

  function newProgress(ctx: any, title: string, steps: string[]): Progress {
    activeProgress?.stop();
    const progress = createProgress(ctx.ui, { widgetId: PROGRESS_WIDGET, statusKey: PROVIDER_ID, title, steps });
    activeProgress = progress;
    return progress;
  }

  async function stopServer(ctx: any) {
    epoch += 1; // cancels an in-flight start or init, including one still waiting on the installer
    activeProgress?.clear();
    activeProgress = null;
    await server.stop();
    ctx.ui.setStatus(PROVIDER_ID, "mlx: stopped");
    ctx.ui.setWidget(PICKER_WIDGET, undefined);
  }

  async function startModelFromInput(pi: PiHost, ctx: any, args: string | undefined) {
    const selected = resolveModel(args, deps.defaultModel);
    // Bad input is reported before anything runs: no provider refresh, no install, no spawn.
    if (selected.error !== undefined) {
      ctx.ui.notify(`mlx-start failed: ${selected.error}`, "error");
      return;
    }
    const model = selected.modelId;
    const mine = (epoch += 1);
    const isStale = () => epoch !== mine;
    currentModel = model;
    await registerProvider(pi, { includeFallback: false });
    if (isStale()) return;

    const progress = newProgress(ctx, `MLX start progress (${model})`, [
      "Ensure runtime is installed",
      "Start MLX server process",
      "Wait for server health endpoint",
      "Download/load model",
      "Warm up first inference",
      "Register provider models",
    ]);

    // The step that was last activated is the one an error is reported against.
    let step = 0;
    const activate = (index: number, detail?: string) => {
      step = index;
      progress.activate(index, detail);
    };

    try {
      activate(0, "Checking runtime");
      await install({
        upgrade: false,
        onEvent: (e) => {
          if (!isStale()) progress.update(0, { state: "active", detail: e.detail });
        },
      });
      if (isStale()) return; // stopped or superseded while installing
      progress.done(0, "Runtime ready");

      ctx.ui.notify(
        `Starting MLX server with ${model}${selected.preset ? ` (preset: ${selected.preset.key})` : ""}...`,
        "info",
      );
      progress.status(`Start MLX server process (${model})`);
      activate(1, "Launching mlx_lm.server");

      await server.start(model, (event) => {
        if (isStale()) return;
        switch (event.type) {
          case "launched":
            progress.done(1, "Server process started");
            activate(2, "Probing /v1/models");
            progress.status("Wait for server health endpoint");
            break;
          case "starting":
            progress.status(`Start MLX server process (${model})`);
            break;
          case "downloading": {
            const files = event.done != null ? ` (${event.done}/${event.total} files)` : "";
            progress.update(3, {
              state: "active",
              detail: event.done != null ? `Downloading model files (${event.done}/${event.total})` : "Downloading model files...",
              progress: event.progress,
            });
            progress.status(`Download/load model${files}`, { progress: event.progress });
            break;
          }
          case "loading":
            progress.done(2, "Server responded on /v1/models");
            activate(3, "Loading model (first run may download GBs)");
            progress.status("Download/load model");
            break;
          case "warming":
            activate(4, "Running first lightweight completion");
            progress.status("Warm up first inference", { showElapsed: true });
            break;
          case "ready":
            progress.done(4, "Model is inference-ready");
            progress.done(3, "Model loaded");
            break;
          case "exited":
            progress.stop();
            ctx.ui.setStatus(PROVIDER_ID, "mlx: stopped");
            break;
        }
      });

      if (isStale()) return;
      activate(5, "Refreshing provider model list");
      await registerProvider(pi, { includeFallback: true });
      if (isStale()) return;
      progress.done(5, "Provider ready");

      progress.clear();
      ctx.ui.setStatus(PROVIDER_ID, `mlx: running (${model})`);
      ctx.ui.setWidget(PICKER_WIDGET, undefined);
      ctx.ui.notify("MLX server is ready for prompts. Use /model and pick pi-mlx-models/...", "info");
    } catch (e) {
      // /mlx-stop or a newer /mlx-start took over; their UI state wins.
      if (isStale()) return;
      progress.stop();
      // stop() only halts the animation; replace the last frame it drew so it cannot linger.
      ctx.ui.setStatus(PROVIDER_ID, "mlx: failed");
      progress.fail(step, errorMessage(e));
      ctx.ui.notify(`mlx-start failed: ${errorMessage(e)}`, "error");
    }
  }

  return async function extension(pi: PiHost) {
    await registerProvider(pi, { includeFallback: false });

    pi.registerCommand("mlx-init", {
      description: "Initialize local MLX runtime (python venv + mlx-lm)",
      handler: async (_args, ctx) => {
        ctx.ui.setWidget(PICKER_WIDGET, undefined);
        const mine = (epoch += 1);
        const isStale = () => epoch !== mine;
        const progress = newProgress(ctx, "MLX init progress", [
          "Find compatible Python",
          "Create virtual environment",
          "Upgrade pip",
          "Install mlx-lm",
        ]);
        let step = 0;
        try {
          ctx.ui.notify("Installing local MLX runtime...", "info");
          await install({
            upgrade: true,
            onEvent: (e) => {
              if (isStale()) return;
              step = INIT_STEPS[e.phase];
              if (e.state === "done") return progress.done(step, e.detail);
              progress.activate(step, e.detail);
              if (e.progress != null) progress.update(step, { progress: e.progress });
            },
          });
          if (isStale()) return;
          ctx.ui.notify("MLX runtime installed.", "info");
          progress.clear();
        } catch (e) {
          if (isStale()) return;
          progress.fail(step, errorMessage(e));
          ctx.ui.notify(`mlx-init failed: ${errorMessage(e)}`, "error");
        }
      },
    });

    pi.registerCommand("mlx-start", {
      description: "Start local MLX server. Usage: /mlx-start [preset-number|preset-key|hf-model-id]",
      handler: async (args, ctx) => {
        if (!configWarningsShown) {
          configWarningsShown = true;
          for (const warning of deps.configWarnings) ctx.ui.notify(warning, "warning");
        }

        const normalizedArgs = (args || "").trim();
        if (!normalizedArgs) {
          const preset = await pickPreset(ctx);
          if (!preset) {
            ctx.ui.notify("Preset selection cancelled.", "info");
            return;
          }
          await startModelFromInput(pi, ctx, preset.key);
          return;
        }

        ctx.ui.setWidget(PICKER_WIDGET, undefined);
        await startModelFromInput(pi, ctx, normalizedArgs);
      },
    });

    pi.registerCommand("mlx-stop", {
      description: "Stop local MLX server",
      handler: async (_args, ctx) => {
        await stopServer(ctx);
        await registerProvider(pi, { includeFallback: false });
        ctx.ui.notify("MLX server stopped.", "info");
      },
    });

    pi.on("session_shutdown", async () => {
      epoch += 1; // a start still waiting on the installer must not launch a server after shutdown
      activeProgress?.stop();
      // Wait for the child to exit so a quitting pi does not leave it holding the port, but never
      // let a stop that hangs (or rejects) hold up the exit or the provider clean-up below.
      await Promise.race([server.stop().catch(() => {}), deps.sleep(deps.shutdownWaitMs)]);
      await registerProvider(pi, { includeFallback: false });
    });
  };
}

// Compile-time guarantee that the real ExtensionAPI satisfies the narrow PiHost the factory takes.
type AssertExtends<T extends U, U> = T;
export type RealApiIsPiHost = AssertExtends<ExtensionAPI, PiHost>;

export default createExtension();

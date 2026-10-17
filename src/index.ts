import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BASE_URL, DEFAULT_MODEL, PROVIDER_ID } from "./config.js";
import { MODEL_PRESETS, resolveModel, type ModelPreset } from "./presets.js";
import { createProgress, type Progress } from "./progress.js";
import { ensureInstalled, type RuntimeEvent } from "./runtime.js";
import { createMlxServer } from "./server.js";

const PROGRESS_WIDGET = "mlx-progress";
const PICKER_WIDGET = "mlx-preset-picker";

const server = createMlxServer();
let currentModel = DEFAULT_MODEL;
let activeProgress: Progress | null = null;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function pickPreset(ctx: any): Promise<ModelPreset | undefined> {
  const options = MODEL_PRESETS.map((p, i) => `${i + 1}. ${p.key} — ${p.tags.slice(0, 2).join(", ")}`);
  const selected = await ctx.ui.select("Select MLX model preset", options);
  if (!selected) return undefined;
  const idx = options.indexOf(selected);
  if (idx < 0) return undefined;
  return MODEL_PRESETS[idx];
}

async function discoverModelIds(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE_URL}/models`);
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

function asProviderModels(ids: string[]) {
  return ids.map((id) => ({
    id,
    name: `${id} (Local)`,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }));
}

async function registerProvider(pi: ExtensionAPI, options?: { includeFallback?: boolean }) {
  const discovered = await discoverModelIds();
  const includeFallback = options?.includeFallback ?? false;
  const modelIds = discovered.length ? discovered : includeFallback ? [currentModel] : [];

  pi.registerProvider(PROVIDER_ID, {
    name: "PI MLX Models",
    baseUrl: BASE_URL,
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

function stopServer(ctx: any) {
  activeProgress?.clear();
  activeProgress = null;
  server.stop();
  ctx.ui.setStatus(PROVIDER_ID, "mlx: stopped");
  ctx.ui.setWidget(PICKER_WIDGET, undefined);
}

async function startModelFromInput(pi: ExtensionAPI, ctx: any, args: string | undefined) {
  const selected = resolveModel(args, DEFAULT_MODEL);
  const model = selected.modelId;
  currentModel = model;
  await registerProvider(pi, { includeFallback: false });

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
    await ensureInstalled({ onEvent: (e) => progress.update(0, { state: "active", detail: e.detail }) });
    progress.done(0, "Runtime ready");

    ctx.ui.notify(
      `Starting MLX server with ${model}${selected.preset ? ` (preset: ${selected.preset.key})` : ""}...`,
      "info",
    );
    progress.status(`Start MLX server process (${model})`);
    activate(1, "Launching mlx_lm.server");

    await server.start(model, (event) => {
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

    activate(5, "Refreshing provider model list");
    await registerProvider(pi, { includeFallback: true });
    progress.done(5, "Provider ready");

    progress.clear();
    ctx.ui.setStatus(PROVIDER_ID, `mlx: running (${model})`);
    ctx.ui.setWidget(PICKER_WIDGET, undefined);
    ctx.ui.notify("MLX server is ready for prompts. Use /model and pick pi-mlx-models/...", "info");
  } catch (e) {
    // /mlx-stop or a newer /mlx-start took over; their UI state wins.
    if (activeProgress !== progress) return;
    progress.stop();
    progress.fail(step, errorMessage(e));
    ctx.ui.notify(`mlx-start failed: ${errorMessage(e)}`, "error");
  }
}

const INIT_STEPS: Record<RuntimeEvent["phase"], number> = { python: 0, venv: 1, pip: 2, "mlx-lm": 3 };

export default async function (pi: ExtensionAPI) {
  await registerProvider(pi, { includeFallback: false });

  pi.registerCommand("mlx-init", {
    description: "Initialize local MLX runtime (python venv + mlx-lm)",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget(PICKER_WIDGET, undefined);
      const progress = newProgress(ctx, "MLX init progress", [
        "Find compatible Python",
        "Create virtual environment",
        "Upgrade pip",
        "Install mlx-lm",
      ]);
      let step = 0;
      try {
        ctx.ui.notify("Installing local MLX runtime...", "info");
        await ensureInstalled({
          upgrade: true,
          onEvent: (e) => {
            step = INIT_STEPS[e.phase];
            if (e.state === "done") return progress.done(step, e.detail);
            progress.activate(step, e.detail);
            if (e.progress != null) progress.update(step, { progress: e.progress });
          },
        });
        ctx.ui.notify("MLX runtime installed.", "info");
        progress.clear();
      } catch (e) {
        progress.fail(step, errorMessage(e));
        ctx.ui.notify(`mlx-init failed: ${errorMessage(e)}`, "error");
      }
    },
  });

  pi.registerCommand("mlx-start", {
    description: "Start local MLX server. Usage: /mlx-start [preset-number|preset-key|hf-model-id]",
    handler: async (args, ctx) => {
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
      stopServer(ctx);
      await registerProvider(pi, { includeFallback: false });
      ctx.ui.notify("MLX server stopped.", "info");
    },
  });

  pi.on("session_shutdown", async () => {
    activeProgress?.stop();
    server.stop();
    await registerProvider(pi, { includeFallback: false });
  });
}

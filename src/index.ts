import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_HOST,
  DEFAULT_MODEL_ID,
  DEFAULT_PIP_INDEX,
  DEFAULT_PORT,
  GLOBAL_CONFIG_PATH,
  PROJECT_CONFIG_RELPATH,
  PROVIDER_ID,
  VENV_PYTHON,
  deriveBaseUrl,
} from "./config.js";
import { cleanLabel } from "./diagnostic.js";
import { discoverModelIds } from "./discovery.js";
import { createFlagProbe, partitionFlags, skippedNotice, type ProbeResult, type VersionResult } from "./flagprobe.js";
import { MODEL_PRESETS, resolveModel, type ModelPreset } from "./presets.js";
import { createProgress, type Progress } from "./progress.js";
import { applyRequestOverrides, type ActiveLaunch } from "./request.js";
import { ensureInstalled, type InstallPolicy, type RuntimeEvent } from "./runtime.js";
import { createMlxServer, type MlxServer } from "./server.js";
import {
  PI_FLAGS,
  buildLaunch,
  cliFlagSpecs,
  describeFlags,
  describeInstall,
  formatConfigErrors,
  formatProjectRefusal,
  initFlagSpecs,
  kvNotices,
  pinNotice,
  pinUnreadableNotice,
  prepareSettings,
  readLayerFile,
  toLaunchSpec,
  trustRisks,
  type InstallSettings,
  type Prepared,
  type ResolvedLaunch,
  type SettingsSource,
} from "./settings.js";
import { parseStartArgs } from "./startargs.js";

const PROGRESS_WIDGET = "mlx-progress";

/** What a pi hook receives next to its event; only the model of the request is used. */
export interface HookContext {
  model?: { provider?: string; id?: string };
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

/** The part of pi's ExtensionAPI this extension uses; tests supply a fake. */
export interface PiHost {
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: any) => Promise<void> },
  ): void;
  registerProvider(name: string, config: any): void;
  /** Register a pi command-line flag. The extension registers string flags and never passes a default. */
  registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string }): void;
  /** The value of a registered flag; read it inside handlers, not while the factory runs. */
  getFlag(name: string): boolean | string | undefined;
  on(event: "session_shutdown", handler: () => Promise<void> | void): void;
  /** Called with the payload pi is about to send; a returned value replaces it, undefined leaves it. */
  on(event: "before_provider_request", handler: (event: { payload: unknown }, ctx: HookContext) => unknown): void;
}

/** Everything the extension reaches outside itself for, injectable so tests need no process, network or port. */
export interface ExtensionDeps {
  server: MlxServer;
  ensureInstalled: typeof ensureInstalled;
  /** Lists the model ids the server at `baseUrl` serves; the base URL is the launch's own, not a constant. */
  discoverModelIds: (baseUrl: string) => Promise<string[]>;
  /** Where layered settings are read from; the global file is read again on every /mlx-start. */
  settings: SettingsSource;
  /** Asks the installed mlx-lm which server flags it supports (the venv must exist). */
  probeFlags: () => Promise<ProbeResult>;
  /** Asks the installed mlx-lm for its version only (cheap, no mlx import); used when an exact pin is configured. */
  installedVersion: () => Promise<VersionResult>;
  /** How long session_shutdown waits for the server to stop before letting pi exit. */
  shutdownWaitMs: number;
  sleep: (ms: number) => Promise<void>;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The project directory of a command: pi's `ctx.cwd`, or the process's own when pi gives none. */
const workingDirectory = (ctx: any): string => (typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd());

/** "a", "a and b", "a, b and c". */
const joinPhrases = (phrases: readonly string[]): string =>
  phrases.length > 1 ? `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}` : (phrases[0] ?? "");

/**
 * The last line of every trust dialog (CFG-06, GAP-02). pi's `ctx.ui.confirm(title, message, opts?)` takes options of
 * type `ExtensionUIDialogOptions`, which carries only `signal` and `timeout` (checked in @earendil-works/pi-coding-agent
 * 0.73.0 and @earendil-works/pi-coding-agent 1.3.0). An extension therefore cannot choose which choice is highlighted,
 * and interactive pi opens the dialog with Yes highlighted. This sentence is the only protection available while the
 * call stays `ctx.ui.confirm` (D-13); pressing Enter without reading still selects Yes. The real fix is a default option
 * in pi, or a decision to amend D-13 and ask with `ctx.ui.select` with No first. A constant on purpose: no text from a
 * file, the environment or a flag is ever added to it (T-02-31).
 */
const SAFE_CHOICE_NOTE = "Yes allows this. No or Esc cancels. Check which option is highlighted before pressing Enter.";

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
  // One probe per extension instance: its cache is keyed by the installed mlx-lm version and lives as long as the session.
  const probe = createFlagProbe({ python: VENV_PYTHON });
  return {
    server: overrides.server ?? createMlxServer(),
    ensureInstalled: overrides.ensureInstalled ?? ensureInstalled,
    discoverModelIds: overrides.discoverModelIds ?? ((baseUrl) => discoverModelIds({ baseUrl })),
    settings: overrides.settings ?? { env: process.env, globalConfigPath: GLOBAL_CONFIG_PATH, home: homedir() },
    probeFlags: overrides.probeFlags ?? probe.probe,
    installedVersion: overrides.installedVersion ?? probe.installedVersion,
    shutdownWaitMs: overrides.shutdownWaitMs ?? 5000,
    sleep: overrides.sleep ?? unrefSleep,
  };
}

/** Build the extension. All mutable state lives in this closure, so each call is an independent instance. */
export function createExtension(overrides: Partial<ExtensionDeps> = {}) {
  const deps = withDefaults(overrides);
  const { server } = deps;
  let currentModel = DEFAULT_MODEL_ID;
  /** The base URL the provider is registered with and discovery polls: the latest launch's, or the ambient one before any. */
  let activeBaseUrl = deriveBaseUrl(DEFAULT_HOST, DEFAULT_PORT);
  let activeProgress: Progress | null = null;
  /** The launch made in this session and what to write into its requests; null before any start and while a start is under way (D-12). */
  let active: ActiveLaunch | null = null;
  /** Config warnings already shown, so each distinct text appears once per extension instance. */
  const shownWarnings = new Set<string>();

  /**
   * The settings in effect outside any /mlx-start: the global file plus the environment, or the environment
   * alone when the file is unusable. Never throws; it only supplies the initial provider URL and model.
   * It deliberately ignores the install settings (the pip index and the version pin): they decide nothing about the
   * provider, so a bad value must not replace the valid base URL and default model. `/mlx-init` and `/mlx-start`
   * resolve without this option and are the ones that report such a value. Nothing is ever installed from this result.
   */
  function ambientSettings(): Pick<Prepared, "baseUrl" | "defaultModel"> {
    const env = deps.settings.env;
    const withFile = prepareSettings({ global: readLayerFile(deps.settings.globalConfigPath), env, ignoreInstall: true });
    if (withFile.ok) return withFile.prepared;
    const envOnly = prepareSettings({ global: { state: "absent" }, env, ignoreInstall: true });
    if (envOnly.ok) return envOnly.prepared;
    return { baseUrl: deriveBaseUrl(DEFAULT_HOST, DEFAULT_PORT), defaultModel: DEFAULT_MODEL_ID };
  }

  /**
   * Bumped by every /mlx-start, /mlx-stop and session_shutdown. A start compares its own value after each
   * await (and on every server event): if it moved, the start was stopped or superseded and must not touch
   * the server or UI. /mlx-init never bumps it, so an init cannot abandon a start or mute a later crash.
   */
  let startEpoch = 0;
  /** Bumped by everything that bumps `startEpoch` and by /mlx-init: a newer flow owns the progress widget. */
  let initEpoch = 0;
  /** The `startEpoch` of the start that is still running and has not been stopped, or null when none is. */
  let startInFlight: number | null = null;

  const cancelStarts = () => {
    startEpoch += 1;
    initEpoch += 1;
    startInFlight = null;
  };

  /** The one runtime install that may touch the venv at a time. */
  let installing: {
    promise: Promise<void>;
    upgrade: boolean;
    /** The policy it runs under; an omitted policy and the default one have the same key. */
    policyKey: string;
    listeners: Set<(event: RuntimeEvent) => void>;
  } | null = null;

  const policyKeyOf = (policy: InstallPolicy | undefined): string =>
    JSON.stringify([policy?.version ?? "latest", policy?.pipIndex ?? DEFAULT_PIP_INDEX]);

  /**
   * Run (or join) the runtime install. Concurrent callers never run two installs in one venv: a caller
   * that a running install already satisfies shares it (and its progress events); an upgrade request
   * waits for a plain install to finish and then runs its own. An install also satisfies only a caller with
   * the same policy: a different version or index waits and runs its own, so the line shown to the user is
   * always the policy that ran (T-03-11).
   */
  async function install(options: { upgrade: boolean; onEvent: (event: RuntimeEvent) => void; policy?: InstallPolicy }): Promise<void> {
    const wanted = policyKeyOf(options.policy);
    while (installing && ((options.upgrade && !installing.upgrade) || installing.policyKey !== wanted)) {
      await installing.promise.catch(() => {});
    }
    if (installing) {
      installing.listeners.add(options.onEvent);
      return installing.promise;
    }
    const listeners = new Set([options.onEvent]);
    const promise: Promise<void> = deps
      .ensureInstalled({
        ...(options.upgrade ? { upgrade: true } : {}),
        ...(options.policy ? { policy: options.policy } : {}),
        onEvent: (event) => listeners.forEach((listener) => listener(event)),
      })
      .finally(() => {
        if (installing?.promise === promise) installing = null;
      });
    installing = { promise, upgrade: options.upgrade, policyKey: wanted, listeners };
    return promise;
  }

  /** Show each configuration warning once per extension instance, however many commands read the same files. */
  function showConfigWarnings(ctx: any, warnings: readonly string[]) {
    for (const warning of warnings) {
      if (shownWarnings.has(warning)) continue;
      shownWarnings.add(warning);
      ctx.ui.notify(warning, "warning");
    }
  }

  async function registerProvider(pi: PiHost, options?: { includeFallback?: boolean }) {
    const discovered = await deps.discoverModelIds(activeBaseUrl);
    const includeFallback = options?.includeFallback ?? false;
    const modelIds = discovered.length ? discovered : includeFallback ? [currentModel] : [];

    pi.registerProvider(PROVIDER_ID, {
      name: "PI MLX Models",
      baseUrl: activeBaseUrl,
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
    cancelStarts(); // cancels an in-flight start or init, including one still waiting on the installer
    active = null; // the values end with the launch (D-12)
    activeProgress?.clear();
    activeProgress = null;
    await server.stop();
    ctx.ui.setStatus(PROVIDER_ID, "mlx: stopped");
  }

  /**
   * Ask the user about every setting that runs code or opens the network, one dialog each, on every start (D-13).
   * Returns true when the start may go on. Nothing is remembered, no UI means no launch (D-15), a dialog that fails
   * or is dismissed counts as declined, and a stop or newer start that happens while a dialog is open abandons this
   * start without a word. The start epoch is not touched here, so a refused or declined start cannot cancel one that
   * is already running (T-02-18).
   */
  async function confirmTrustRisks(ctx: any, prepared: Prepared): Promise<boolean> {
    const risks = trustRisks(prepared);
    if (risks.length === 0) return true;
    const phrases = joinPhrases(risks.map((risk) => risk.phrase));
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `mlx-start failed: ${phrases} ${risks.length > 1 ? "need" : "needs"} interactive confirmation; run /mlx-start in an interactive pi session`,
        "error",
      );
      return false;
    }
    const seen = startEpoch;
    for (const risk of risks) {
      let confirmed = false;
      try {
        confirmed = (await ctx.ui.confirm(risk.title, `${risk.message}\n\n${SAFE_CHOICE_NOTE}`)) === true;
      } catch {
        confirmed = false;
      }
      if (startEpoch !== seen) return false;
      if (!confirmed) {
        ctx.ui.notify(`mlx-start cancelled: ${risk.phrase} was not confirmed.`, "info");
        return false;
      }
    }
    return true;
  }

  async function startModelFromInput(pi: PiHost, ctx: any, args: string | undefined, prepared: Prepared) {
    const selected = resolveModel(args, prepared.defaultModel);
    // Bad input is reported before anything runs: no provider refresh, no install, no spawn.
    if (selected.error !== undefined) {
      ctx.ui.notify(`mlx-start failed: ${selected.error}`, "error");
      return;
    }
    // The model's own options (the `model` block and its `models` entries) are settled here; `~` and relative paths
    // resolve against the configured home directory and the project directory, and the chat template is read now.
    const built = buildLaunch(
      prepared,
      { modelId: selected.modelId, ...(selected.preset ? { presetKey: selected.preset.key } : {}) },
      { home: deps.settings.home, cwd: workingDirectory(ctx) },
    );
    if (!built.ok) {
      ctx.ui.notify(`mlx-start failed: ${formatConfigErrors(built.errors)}`, "error");
      return;
    }
    if (!(await confirmTrustRisks(ctx, prepared))) return;
    const mine = (startEpoch += 1);
    initEpoch += 1;
    startInFlight = mine;
    try {
      await runStart(pi, ctx, built.launch, prepared.install, mine);
    } finally {
      if (startInFlight === mine) startInFlight = null;
    }
  }

  async function runStart(pi: PiHost, ctx: any, launch: ResolvedLaunch, installSettings: InstallSettings, mine: number) {
    const isStale = () => startEpoch !== mine;
    active = null;
    const { modelId: model, presetKey } = launch.model;
    currentModel = model;
    activeBaseUrl = launch.baseUrl;
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
      // The first-run install honours the same index and pin as /mlx-init; an importable venv still returns before any pip call (D-07).
      await install({
        upgrade: false,
        policy: { version: installSettings.version, pipIndex: installSettings.pipIndex },
        onEvent: (e) => {
          if (!isStale()) progress.update(0, { state: "active", detail: e.detail });
        },
      });
      if (isStale()) return; // stopped or superseded while installing

      // An exact pin that is not what is installed is only reported: this start never upgrades or downgrades, and only
      // /mlx-init changes the install (D-07). The cheap version query runs here, so a floating policy pays nothing.
      if (installSettings.version !== "latest") {
        const installed = await deps.installedVersion();
        if (isStale()) return;
        if (installed.ok) {
          const mismatch = pinNotice(installSettings, installed.version);
          if (mismatch !== undefined) ctx.ui.notify(mismatch, "warning");
        } else {
          // The pin could not be compared: say so, and start what is installed (D-07).
          const unread = pinUnreadableNotice(installSettings, installed.reason);
          if (unread !== undefined) ctx.ui.notify(unread, "warning");
        }
      }

      // Ask the installed server which of the configured optional flags it supports. Only a launch that has some
      // pays for it (a default launch is exactly as fast as before), and only now: the venv has to exist (D-18).
      const skipped = new Set<string>();
      if (launch.flags.some((flag) => !flag.core)) {
        progress.update(0, { state: "active", detail: "Checking which server flags mlx-lm supports" });
        const probe = await deps.probeFlags();
        if (isStale()) return;
        const split = partitionFlags(launch.flags, probe);
        for (const flag of split.skipped) skipped.add(flag.flag);
        // A plain notification, never through the once-per-text set: every launch that skips something says so.
        if (!probe.ok) {
          ctx.ui.notify(`Could not check which flags mlx-lm supports (${probe.reason}); passing every configured flag.`, "warning");
        } else if (split.skipped.length > 0) {
          const pin =
            installSettings.version === "latest"
              ? undefined
              : { version: installSettings.version, ...(installSettings.versionSource !== undefined ? { source: installSettings.versionSource } : {}) };
          ctx.ui.notify(skippedNotice(split.skipped.map((flag) => flag.flag), probe.version, pin), "warning");
        }
      }
      progress.done(0, "Runtime ready");

      const flagsLine = describeFlags(launch, skipped);
      ctx.ui.notify(
        `Starting MLX server with ${model}${presetKey ? ` (preset: ${presetKey})` : ""}...${flagsLine ? `\n${flagsLine}` : ""}`,
        "info",
      );
      // KV quantization turns batching off. Told on every launch, through no once-per-text set and with no state kept (D-09).
      const kv = kvNotices(launch, skipped);
      if (kv.warning !== undefined) ctx.ui.notify(kv.warning, "warning");
      if (kv.info !== undefined) ctx.ui.notify(kv.info, "info");
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
      }, toLaunchSpec(launch, skipped));

      if (isStale()) return;
      active = { modelId: model, request: launch.request };
      activate(5, "Refreshing provider model list");
      await registerProvider(pi, { includeFallback: true });
      if (isStale()) return;
      progress.done(5, "Provider ready");

      progress.clear();
      ctx.ui.setStatus(PROVIDER_ID, `mlx: running (${model})`);
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
    // Registered before the first await. String flags with no default: pi writes a default into its flag values
    // at registration, which would make the flag outrank the environment and the files (D-09).
    for (const flag of PI_FLAGS) pi.registerFlag(flag.name, { description: flag.description, type: "string" });

    const ambient = ambientSettings();
    activeBaseUrl = ambient.baseUrl;
    currentModel = ambient.defaultModel;
    await registerProvider(pi, { includeFallback: false });

    pi.registerCommand("mlx-init", {
      description: "Initialize local MLX runtime (python venv + mlx-lm)",
      handler: async (args, ctx) => {
        // A start in flight owns the venv and the progress widget; replacing it would abandon the start.
        if (startInFlight !== null) {
          ctx.ui.notify("mlx-init failed: MLX server is starting; run /mlx-stop first", "error");
          return;
        }
        // Only the flags of /mlx-init's own list, and no model: typed text can never become another pip option (T-03-10).
        const parsed = parseStartArgs(args ?? "", initFlagSpecs(), { command: "/mlx-init", takesModel: false });
        if (!parsed.ok) {
          ctx.ui.notify(`mlx-init failed: ${parsed.error}`, "error");
          return;
        }
        const typed: Record<string, string | true> = {};
        for (const flag of parsed.flags) typed[flag.path] = flag.raw;
        // The same layered configuration as /mlx-start, read the same way, and refused the same way: an invalid file or
        // a project file that asks for something it may never ask for stops the init before any side effect. What was
        // typed applies to this run only and is kept nowhere (Phase 2 D-10).
        const result = prepareSettings({
          global: readLayerFile(deps.settings.globalConfigPath),
          project: readLayerFile(join(workingDirectory(ctx), PROJECT_CONFIG_RELPATH)),
          env: deps.settings.env,
          args: typed,
        });
        showConfigWarnings(ctx, result.warnings);
        if (!result.ok) {
          ctx.ui.notify(`mlx-init failed: ${formatConfigErrors(result.errors)}`, "error");
          return;
        }
        const { prepared } = result;
        if (prepared.projectViolations.length > 0) {
          ctx.ui.notify(`mlx-init failed: ${formatProjectRefusal(prepared.projectViolations, deps.settings.globalConfigPath)}`, "error");
          return;
        }
        const policy: InstallPolicy = { version: prepared.install.version, pipIndex: prepared.install.pipIndex };

        const mine = (initEpoch += 1);
        const isStale = () => initEpoch !== mine;
        const progress = newProgress(ctx, "MLX init progress", [
          "Find compatible Python",
          "Create virtual environment",
          "Upgrade pip",
          "Install mlx-lm",
        ]);
        let step = 0;
        try {
          ctx.ui.notify("Installing local MLX runtime...", "info");
          ctx.ui.notify(`Installing ${describeInstall(prepared.install)}`, "info");
          await install({
            upgrade: true,
            policy,
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
      description: "Start local MLX server. Usage: /mlx-start [preset-number|preset-key|hf-model-id] [--flag value ...]",
      handler: async (args, ctx) => {
        // Syntax errors in the arguments are reported before anything else: no unknown flag is ever passed on (D-08).
        const parsed = parseStartArgs(args ?? "", cliFlagSpecs());
        if (!parsed.ok) {
          ctx.ui.notify(`mlx-start failed: ${parsed.error}`, "error");
          return;
        }
        // Everything below is read from this call alone and kept nowhere: overrides apply to this launch only (D-10).
        // The pi flags are read here and not in the factory, because pi fills their values in after it ran (D-09).
        const piFlags: Record<string, string> = {};
        for (const flag of PI_FLAGS) {
          const value = flag.path === undefined ? undefined : pi.getFlag(flag.name);
          if (typeof value === "string") piFlags[flag.name] = value;
        }
        const modelFlag = pi.getFlag("mlx-model");
        const typed: Record<string, string | true> = {};
        for (const flag of parsed.flags) typed[flag.path] = flag.raw;

        // The global file and the project file (the working directory's own, never a parent's) are read on every
        // start, so an edit needs no reload (D-04, D-05).
        const result = prepareSettings({
          global: readLayerFile(deps.settings.globalConfigPath),
          project: readLayerFile(join(workingDirectory(ctx), PROJECT_CONFIG_RELPATH)),
          env: deps.settings.env,
          piFlags,
          args: typed,
        });
        showConfigWarnings(ctx, result.warnings);
        // Invalid configuration stops the start before any install, provider refresh or spawn (D-06).
        if (!result.ok) {
          ctx.ui.notify(`mlx-start failed: ${formatConfigErrors(result.errors)}`, "error");
          return;
        }
        const { prepared } = result;
        // A cloned repository's file may tune the server but never run code or open the network; no dialog can
        // override that, and nothing has been touched yet (D-16).
        if (prepared.projectViolations.length > 0) {
          ctx.ui.notify(`mlx-start failed: ${formatProjectRefusal(prepared.projectViolations, deps.settings.globalConfigPath)}`, "error");
          return;
        }

        // A model typed on the command line beats --mlx-model; with neither, the picker opens even when a default
        // model is configured (the default only fills in for a start that names no model at all).
        const typedModel = (parsed.model ?? "").trim();
        const flagModel = typeof modelFlag === "string" ? modelFlag.trim() : "";
        const modelInput = typedModel || flagModel;
        if (!modelInput) {
          const preset = await pickPreset(ctx);
          if (!preset) {
            ctx.ui.notify("Preset selection cancelled.", "info");
            return;
          }
          await startModelFromInput(pi, ctx, preset.key, prepared);
          return;
        }

        await startModelFromInput(pi, ctx, modelInput, prepared);
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
      cancelStarts(); // a start still waiting on the installer must not launch a server after shutdown
      active = null; // the values end with the launch, before any await (D-12)
      activeProgress?.stop();
      // Wait for the child to exit so a quitting pi does not leave it holding the port, but never
      // let a stop that hangs (or rejects) hold up the exit or the provider clean-up below.
      await Promise.race([server.stop().catch(() => {}), deps.sleep(deps.shutdownWaitMs)]);
      await registerProvider(pi, { includeFallback: false });
    });

    // The payload of every request pi sends goes through here, other providers' included. Only a request for this provider's
    // launched model is rewritten, from values held in memory: no file is read (D-12). It never throws and never mutates (D-11).
    pi.on("before_provider_request", (event, ctx) => {
      try {
        if (active === null || ctx?.model?.provider !== PROVIDER_ID) return undefined;
        const rewrite = applyRequestOverrides(event?.payload, active);
        return rewrite.kind === "rewritten" ? rewrite.payload : undefined;
      } catch {
        return undefined;
      }
    });
  };
}

// Compile-time guarantee that the real ExtensionAPI satisfies the narrow PiHost the factory takes.
type AssertExtends<T extends U, U> = T;
export type RealApiIsPiHost = AssertExtends<ExtensionAPI, PiHost>;

export default createExtension();

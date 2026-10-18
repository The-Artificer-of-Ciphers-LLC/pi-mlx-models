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
import { runConfigMenu } from "./configmenu.js";
import { cleanLabel, clipDiagnostic, redactCredentials, redactIdCredentials } from "./diagnostic.js";
import { discoverModelIds } from "./discovery.js";
import { createFlagProbe, partitionFlags, skippedNotice, type ProbeResult, type VersionResult } from "./flagprobe.js";
import { MODEL_PRESETS, resolveModel, type ModelPreset } from "./presets.js";
import {
  createModelConfigReader,
  describeModel,
  deriveModelInfo,
  extrasFallbackNotice,
  fallbackNotice,
  outputLimitNotice,
  type ModelConfigRead,
  type ModelInfo,
  type ReadModelConfig,
} from "./modelinfo.js";
import { probePort } from "./port.js";
import { createProgress, type Progress } from "./progress.js";
import { applyRequestOverrides, type ActiveLaunch } from "./request.js";
import { ensureInstalled, runtimeInstalled, type InstallPolicy, type RuntimeEvent } from "./runtime.js";
import { createMlxServer, type MlxServer, type ServerAddress } from "./server.js";
import {
  PI_FLAGS,
  PROFILE_FLAG_SPEC,
  buildLaunch,
  cliFlagSpecs,
  describeFlags,
  describeInstall,
  describeProfile,
  describeRequest,
  formatConfigErrors,
  formatProjectRefusal,
  initFlagSpecs,
  isAutoStartRequested,
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
import { lastLaunchPath, readLastLaunch, writeLastLaunch } from "./laststate.js";
import { parseStartArgs, type CliFlagValue } from "./startargs.js";
import { classifyHealth, createHealthProbe, formatStatus, type ProbeHealth, type SessionState, type StatusView } from "./status.js";

const PROGRESS_WIDGET = "mlx-progress";

/**
 * The launches, as their names without the slash: the three commands that start a model and auto-start, which starts one
 * when pi opens. A closed set of constants: no user text becomes one (T-06-05).
 */
type LaunchCommand = "mlx-start" | "mlx-last" | "mlx-restart" | "auto-start";

/** Every name whose failures and refusals are worded by `failed` and `refusal`: the launches and the read-only commands. Constants only. */
type CommandName = LaunchCommand | "mlx-status" | "mlx-config";

/** The text of a failed launch of `command`. The only place a command name is joined to a failure message. */
const failed = (command: CommandName, text: string): string => `${command} failed: ${text}`;

/**
 * The text of a launch of `command` that was refused before any server was launched. Auto-start has nobody to tell "failed"
 * to, so its refusals read "skipped" and point at /mlx-start; every other command words them exactly as `failed` does.
 */
const refusal = (command: CommandName, text: string): string => (command === "auto-start" ? `auto-start skipped: ${text}` : failed(command, text));

/** The text of a launch of `command` the user declined. The only place a command name is joined to a cancel message. */
const cancelled = (command: CommandName, text: string): string => `${command} cancelled: ${text}`;

/** What one launch needs to know about the command that asked for it. */
interface LaunchRun {
  command: LaunchCommand;
  /** The profile selection handed to `buildLaunch`; absent means the model's own default applies. */
  profile?: string;
  /** Whether `profile` was typed in this command or kept from an earlier launch; it words the profile source in the start message. */
  profileOrigin?: "typed" | "kept";
  /** Whether the ready start selects the model in pi (default true). Auto-start passes false: it never changes the model the user chose (A5). */
  select?: boolean;
  /** Whether a person is at the keyboard to confirm (default true). Auto-start passes false: it refuses a launch that needs a confirmation (D-27). */
  interactive?: boolean;
}

/** The slash form of each launch command, as `buildLaunch` words its profile lines. A fixed map: no user text is ever looked up in it. */
const SLASH_FORM: Record<LaunchCommand, "/mlx-start" | "/mlx-last" | "/mlx-restart"> = {
  "mlx-start": "/mlx-start",
  "mlx-last": "/mlx-last",
  "mlx-restart": "/mlx-restart",
  // Auto-start has no slash form of its own; the command that starts by hand is the one its notices point to.
  "auto-start": "/mlx-start",
};

/**
 * What this session knows about the launch it made, kept in memory from the moment a start begins until its server ends
 * (D-10, D-11). The profile, flags and request lines are the strings the start message showed; /mlx-status repeats them and
 * derives nothing again. Separate from `active` (the request rewrite) and `loaded` (the model information) because each of
 * those is cleared and set on its own schedule.
 */
interface LaunchRecord {
  /** The start epoch of the start that made it: a stale start never touches a newer record. */
  epoch: number;
  modelId: string;
  presetKey?: string;
  /** The selection handed to `buildLaunch`; absent when none was typed or kept, so `defaultProfile` decided. A restart replays it. */
  profile?: string;
  command: LaunchCommand;
  address: ServerAddress;
  baseUrl: string;
  profileLine: string;
  flagsLine: string;
  requestLine: string;
  /** True once the model information is stored; until then /mlx-status says loading. */
  ready: boolean;
}

/**
 * Shown once per session when a request for this provider's launched model has a payload the rewrite cannot read (D-11).
 * A constant on purpose: no part of the payload is ever added to it (T-04-11).
 */
const BAD_SHAPE_NOTICE =
  "pi-mlx-models: a request to the MLX server had an unexpected shape, so the profile and sampling settings were not applied to it. Shown once per session.";

/**
 * Shown once per session when a request for this provider carries a model id other than the launched one, so the profile and
 * sampling settings did not apply to it (WR-02). The text names only the launched id, cleaned and clipped; nothing from the
 * payload is ever added to it.
 */
const modelMismatchNotice = (launchedId: string): string =>
  `pi-mlx-models: a request to the MLX server named a different model than the one launched (${clipDiagnostic(redactIdCredentials(cleanLabel(launchedId)), 80, "start")}), so the profile and sampling settings were not applied to it. Shown once per session.`;

/** The ready message when the started model could not be selected for the user: the user picks it themselves. */
const READY_HINT = "MLX server is ready for prompts. Use /model and pick pi-mlx-models/...";
const shownModelId = (model: string): string => clipDiagnostic(redactIdCredentials(cleanLabel(model)), 80, "start");
/** The ready message after pi switched to the started model. The id came from user input or a project file, so it is cleaned. */
const readySelectedNotice = (model: string): string =>
  `MLX server is ready for prompts. ${PROVIDER_ID}/${shownModelId(model)} is now the selected model.`;
/** Shown when pi answers that it did not make the switch. */
const selectRefusedNotice = (model: string): string =>
  `pi-mlx-models: pi did not select ${PROVIDER_ID}/${shownModelId(model)}; it reports that authentication is not configured for the provider.`;

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
  /** Fires every time a session starts, whatever the reason (startup, reload, new, resume or fork); pi waits for the handler it returns from. */
  on(event: "session_start", handler: (event: { reason?: string }, ctx: any) => Promise<void> | void): void;
  /** Called with the payload pi is about to send; a returned value replaces it, undefined leaves it. */
  on(event: "before_provider_request", handler: (event: { payload: unknown }, ctx: HookContext) => unknown): void;
  /** Fires on every change of the active model, the ones this extension makes included. */
  on(event: "model_select", handler: (event: { model?: { provider?: string; id?: string }; source?: string }) => void): void;
  /** pi's `ExtensionAPI.setModel`: selects a model for the current session only; resolves false when the model's provider has no authentication. */
  setModel(model: any): Promise<boolean>;
}

/** Everything the extension reaches outside itself for, injectable so tests need no process, network or port. */
export interface ExtensionDeps {
  server: MlxServer;
  ensureInstalled: typeof ensureInstalled;
  /** Lists the model ids the server at `baseUrl` serves; the base URL is the launch's own, not a constant. */
  discoverModelIds: (baseUrl: string) => Promise<string[]>;
  /** Looks up a model's `config.json` (the Hugging Face cache, then a local path); it never throws or rejects. */
  readModelConfig: ReadModelConfig;
  /** Where layered settings are read from; the global file is read again on every /mlx-start. */
  settings: SettingsSource;
  /** Asks the installed mlx-lm which server flags it supports (the venv must exist). */
  probeFlags: () => Promise<ProbeResult>;
  /** Asks the installed mlx-lm for its version only (cheap, no mlx import); used when an exact pin is configured. */
  installedVersion: () => Promise<VersionResult>;
  /** The probe /mlx-status uses: whether a connect to the address is accepted and, if so, whether /v1/models answers. */
  probeHealth: ProbeHealth;
  /** True when something already answers (accepts a connection or holds the bind) at the address; auto-start asks it before it starts anything. */
  probePort: (host: string, port: number) => Promise<boolean>;
  /** True when the MLX runtime (the venv and its mlx-lm) is usable; auto-start asks it and never installs anything. */
  runtimeInstalled: () => Promise<boolean>;
  /**
   * Receives the promise of the background work the session_start hook started, so a test can wait for it. Not a timeout and
   * not set in production: the hook returns at once either way.
   */
  trackBackground?: (work: Promise<void>) => void;
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

function asProviderModels(ids: string[], infoOf: (id: string) => ModelInfo) {
  return ids.map((id) => {
    const info = infoOf(id);
    return {
      id,
      // The id is what the server expects; only the display name is cleaned of terminal control characters.
      name: `${cleanLabel(id)} (Local)`,
      reasoning: info.reasoning,
      input: [...info.input],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: info.contextWindow,
      maxTokens: info.maxTokens,
      // A reasoning model gets neither the `developer` role nor `reasoning_effort` from pi: mlx-lm templates reject both (D-06).
      ...(info.reasoning ? { compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } } : {}),
    };
  });
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
    readModelConfig: overrides.readModelConfig ?? createModelConfigReader(),
    settings: overrides.settings ?? { env: process.env, globalConfigPath: GLOBAL_CONFIG_PATH, home: homedir() },
    probeFlags: overrides.probeFlags ?? probe.probe,
    installedVersion: overrides.installedVersion ?? probe.installedVersion,
    probeHealth: overrides.probeHealth ?? createHealthProbe(),
    probePort: overrides.probePort ?? probePort,
    runtimeInstalled: overrides.runtimeInstalled ?? (() => runtimeInstalled()),
    ...(overrides.trackBackground === undefined ? {} : { trackBackground: overrides.trackBackground }),
    shutdownWaitMs: overrides.shutdownWaitMs ?? 5000,
    sleep: overrides.sleep ?? unrefSleep,
  };
}

/** Build the extension. All mutable state lives in this closure, so each call is an independent instance. */
export function createExtension(overrides: Partial<ExtensionDeps> = {}) {
  const deps = withDefaults(overrides);
  const { server } = deps;
  /** The base URL the provider is registered with and discovery polls: the latest launch's, or the ambient one before any. */
  let activeBaseUrl = deriveBaseUrl(DEFAULT_HOST, DEFAULT_PORT);
  let activeProgress: Progress | null = null;
  /** The launch made in this session and what to write into its requests; null before any start and while a start is under way (D-12). */
  let active: ActiveLaunch | null = null;
  /** `provider.listAllModels` of the latest launch (the ambient value before any): whether the provider lists every model the server reports. */
  let listAllModels = false;
  /**
   * The model the running server has loaded and what pi is told about it: set when a start becomes ready, null before any
   * start, while one is under way and after a stop.
   */
  let loaded: { id: string; info: ModelInfo } | null = null;
  /**
   * The launch of this session as /mlx-status reports it: created at the top of a start, replaced by a newer start, and
   * cleared by /mlx-stop, session shutdown, the server exiting and a failed start (D-10, D-11).
   */
  let launchRecord: LaunchRecord | null = null;
  /** The record of the start with this epoch, or null when it was cleared or a newer start replaced it. */
  const recordOf = (epoch: number): LaunchRecord | null => (launchRecord !== null && launchRecord.epoch === epoch ? launchRecord : null);
  /** Config warnings already shown, so each distinct text appears once per extension instance. */
  const shownWarnings = new Set<string>();
  /** Whether the bad-payload notice has been shown in this extension instance (D-11). */
  let badShapeShown = false;
  let modelMismatchShown = false;
  /**
   * Counts model_select events that our own switch did not cause. A start compares it with the value it saw when it began:
   * a model the user picked meanwhile (set, cycle or restore) wins over the switch.
   */
  let userPicks = 0;
  /** True only while our own `pi.setModel` call is pending, so the model_select event it raises is not counted as a pick. */
  let switching = false;

  /**
   * The settings in effect outside any /mlx-start: the global file plus the environment, or the environment
   * alone when the file is unusable. Never throws; it only supplies the initial provider URL and model.
   * It deliberately ignores the install settings (the pip index and the version pin): they decide nothing about the
   * provider, so a bad value must not replace the valid base URL and default model. `/mlx-init` and `/mlx-start`
   * resolve without this option and are the ones that report such a value. Nothing is ever installed from this result.
   */
  function ambientSettings(): Pick<Prepared, "baseUrl" | "defaultModel" | "listAllModels"> {
    const env = deps.settings.env;
    const withFile = prepareSettings({ global: readLayerFile(deps.settings.globalConfigPath), env, ignoreInstall: true });
    if (withFile.ok) return withFile.prepared;
    const envOnly = prepareSettings({ global: { state: "absent" }, env, ignoreInstall: true });
    if (envOnly.ok) return envOnly.prepared;
    return { baseUrl: deriveBaseUrl(DEFAULT_HOST, DEFAULT_PORT), defaultModel: DEFAULT_MODEL_ID, listAllModels: false };
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

  /** Where the last launch is remembered: next to the global config file (D-01). */
  const statePath = (): string => lastLaunchPath(deps.settings.globalConfigPath);

  /** Show each configuration warning once per extension instance, however many commands read the same files. */
  function showConfigWarnings(ctx: any, warnings: readonly string[]) {
    for (const warning of warnings) {
      if (shownWarnings.has(warning)) continue;
      shownWarnings.add(warning);
      ctx.ui.notify(warning, "warning");
    }
  }

  /**
   * Everything a launch command does between its parsed arguments and the choice of a model: refuse an empty `--profile`,
   * read the pi flags, split the profile from the typed settings, read both configuration files, show the warnings and
   * refuse invalid configuration or a project file that asks for what it may never ask for. Shared by every command that
   * starts a model, so validation, project refusal and warnings cannot drift between them. Nothing has been installed,
   * refreshed or spawned when it returns. Returns undefined after reporting a refusal.
   *
   * The order of the `pi.getFlag` calls is observable (tests count them): the flags of PI_FLAGS first, then `mlx-model`
   * only when the caller asks for it.
   */
  function readLaunchSettings(
    pi: PiHost,
    ctx: any,
    command: LaunchCommand,
    flags: readonly CliFlagValue[],
    options: { readModelFlag?: boolean; skipProjectFile?: boolean } = {},
  ): { prepared: Prepared; profile: string | undefined; modelFlag: boolean | string | undefined } | undefined {
    // An empty profile name (`--profile=` or `--profile ""`) names nothing: it is refused here, before any file is read,
    // and never falls back to the model's defaultProfile (D-02).
    const profileFlag = flags.find((flag) => flag.path === PROFILE_FLAG_SPEC.path);
    if (profileFlag !== undefined && (typeof profileFlag.raw !== "string" || profileFlag.raw.trim() === "")) {
      ctx.ui.notify(refusal(command, "--profile needs a profile name"), "error");
      return undefined;
    }
    // Everything below is read from this call alone and kept nowhere: overrides apply to this launch only (D-10).
    // The pi flags are read here and not in the factory, because pi fills their values in after it ran (D-09).
    const piFlags: Record<string, string> = {};
    for (const flag of PI_FLAGS) {
      const value = flag.path === undefined ? undefined : pi.getFlag(flag.name);
      if (typeof value === "string") piFlags[flag.name] = value;
    }
    const modelFlag = options.readModelFlag === true ? pi.getFlag("mlx-model") : undefined;
    const typed: Record<string, string | true> = {};
    // The profile is not a setting: it picks a set of values for this launch only (D-02), so it stays out of the layers.
    let profile: string | undefined;
    for (const flag of flags) {
      if (flag.path === PROFILE_FLAG_SPEC.path) profile = typeof flag.raw === "string" ? flag.raw : undefined;
      else typed[flag.path] = flag.raw;
    }

    // The global file and the project file (the working directory's own, never a parent's) are read on every
    // start, so an edit needs no reload (D-04, D-05). An unattended start (auto-start) never reads the project file: a cloned
    // repository must not steer a launch nobody asked for (WR-03), so that layer is left out and its file is not opened.
    const result = prepareSettings({
      global: readLayerFile(deps.settings.globalConfigPath),
      ...(options.skipProjectFile === true ? {} : { project: readLayerFile(join(workingDirectory(ctx), PROJECT_CONFIG_RELPATH)) }),
      env: deps.settings.env,
      piFlags,
      args: typed,
    });
    showConfigWarnings(ctx, result.warnings);
    // Invalid configuration stops the start before any install, provider refresh or spawn (D-06).
    if (!result.ok) {
      ctx.ui.notify(refusal(command, formatConfigErrors(result.errors)), "error");
      return undefined;
    }
    const { prepared } = result;
    // A cloned repository's file may tune the server but never run code or open the network; no dialog can
    // override that, and nothing has been touched yet (D-16).
    if (prepared.projectViolations.length > 0) {
      ctx.ui.notify(refusal(command, formatProjectRefusal(prepared.projectViolations, deps.settings.globalConfigPath)), "error");
      return undefined;
    }
    return { prepared, profile, modelFlag };
  }

  /**
   * Register the provider with the models pi should list (MOD-04, D-12, D-13). By default that is the model the server has
   * loaded and nothing else, so nothing is listed before the first start, while one is under way and after a stop; the
   * model discovery is not asked at all. With `provider.listAllModels` true it is every model the server reports, or the
   * loaded model when discovery finds none and the caller asks for the fallback. Registering again replaces the provider's
   * earlier list; pi's unregisterProvider is never used, so a stop or a shutdown registers an empty list instead.
   * A user of an external server (PI_MLX_MODELS_BASE_URL) has no loaded model and so sees no models until
   * `provider.listAllModels` is true.
   *
   * Every listed model other than the loaded one gets metadata from a local-only read of its `config.json` (the Hub is never
   * asked for these), with the fallback where there is none. Those that fell back are reported by one warning that gives
   * their count and the first reason, never an id, and only when the caller has a command context (`ctx`). `launching` names
   * a model whose start is under way: it is neither read nor counted, because its own read comes after the launch. `abandon`
   * lets a start that was stopped or superseded during the reads drop the registration.
   */
  async function registerProvider(
    pi: PiHost,
    options?: { includeFallback?: boolean; ctx?: any; launching?: string; abandon?: () => boolean },
  ) {
    const includeFallback = options?.includeFallback ?? false;
    let modelIds: string[];
    if (listAllModels) {
      const discovered = await deps.discoverModelIds(activeBaseUrl);
      modelIds = discovered.length ? discovered : includeFallback && loaded !== null ? [loaded.id] : [];
    } else {
      modelIds = loaded === null ? [] : [loaded.id];
    }

    // The loaded model carries the metadata read for it; any other id the server reports is read locally, one at a time.
    const infos = new Map<string, ModelInfo>();
    const reasons: string[] = [];
    for (const id of modelIds) {
      if (loaded !== null && loaded.id === id) {
        infos.set(id, loaded.info);
        continue;
      }
      if (id === options?.launching) continue;
      let read: ModelConfigRead;
      try {
        read = await deps.readModelConfig(id, { hub: false });
      } catch {
        read = { ok: false, reason: "the model reader failed" };
      }
      const info = deriveModelInfo({ id, config: read });
      infos.set(id, info);
      if (info.fallbackReason !== undefined) reasons.push(info.fallbackReason);
    }
    if (options?.abandon?.() === true) return;
    if (options?.ctx !== undefined && reasons.length > 0) showConfigWarnings(options.ctx, [extrasFallbackNotice(reasons.length, reasons[0] ?? "")]);

    pi.registerProvider(PROVIDER_ID, {
      name: "PI MLX Models",
      baseUrl: activeBaseUrl,
      apiKey: "DUMMY",
      api: "openai-completions",
      models: asProviderModels(modelIds, (id) => infos.get(id) ?? deriveModelInfo({ id })),
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
    loaded = null;
    launchRecord = null;
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
  async function confirmTrustRisks(ctx: any, prepared: Prepared, run: LaunchRun): Promise<boolean> {
    const { command } = run;
    const risks = trustRisks(prepared);
    if (risks.length === 0) return true;
    const phrases = joinPhrases(risks.map((risk) => risk.phrase));
    // Nobody is at the keyboard for an unattended launch, so it never opens a dialog and never confirms for the user: it says
    // what needs confirming and points to the command that asks (D-27, T-06-33).
    if (run.interactive === false) {
      ctx.ui.notify(
        refusal(command, `${phrases} ${risks.length > 1 ? "need" : "needs"} your confirmation; run /mlx-start to confirm`),
        "warning",
      );
      return false;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        refusal(command, `${phrases} ${risks.length > 1 ? "need" : "needs"} interactive confirmation; run /${command} in an interactive pi session`),
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
        ctx.ui.notify(cancelled(command, `${risk.phrase} was not confirmed.`), "info");
        return false;
      }
    }
    return true;
  }

  async function startModelFromInput(pi: PiHost, ctx: any, input: string | undefined, prepared: Prepared, run: LaunchRun) {
    const selected = resolveModel(input, prepared.defaultModel);
    // Bad input is reported before anything runs: no provider refresh, no install, no spawn.
    if (selected.error !== undefined) {
      ctx.ui.notify(refusal(run.command, selected.error), "error");
      return;
    }
    // The model's own options (the `model` block and its `models` entries) are settled here; `~` and relative paths
    // resolve against the configured home directory and the project directory, and the chat template is read now.
    const built = buildLaunch(
      prepared,
      { modelId: selected.modelId, ...(selected.preset ? { presetKey: selected.preset.key } : {}) },
      { home: deps.settings.home, cwd: workingDirectory(ctx) },
      run.profile === undefined ? {} : { profile: run.profile, command: SLASH_FORM[run.command], origin: run.profileOrigin ?? "typed" },
    );
    if (!built.ok) {
      // An unattended launch that cannot be built (a profile the model no longer defines) tells the user what to do by hand.
      const errors = formatConfigErrors(built.errors);
      ctx.ui.notify(refusal(run.command, run.command === "auto-start" ? `${errors}\nRun /mlx-start to start by hand.` : errors), "error");
      return;
    }
    if (!(await confirmTrustRisks(ctx, prepared, run))) return;
    const mine = (startEpoch += 1);
    initEpoch += 1;
    startInFlight = mine;
    try {
      await runStart(pi, ctx, built.launch, prepared.install, mine, prepared.listAllModels, run);
    } finally {
      if (startInFlight === mine) startInFlight = null;
    }
  }

  /**
   * Selects the started model in pi. Never throws: a switch that cannot be made leaves the start a success and the user
   * to pick the model with /model. Only the object the registry returns is passed to pi, so no other provider's model can be chosen.
   */
  async function selectStartedModel(pi: PiHost, ctx: any, model: string, picksAtStart: number): Promise<"selected" | "refused" | "skipped"> {
    try {
      if (userPicks !== picksAtStart) return "skipped"; // the user's choice during the start wins
      const found = ctx?.modelRegistry?.find?.(PROVIDER_ID, model);
      if (found === undefined || found === null) return "skipped";
      switching = true;
      let result: unknown;
      try {
        result = await pi.setModel(found);
      } finally {
        switching = false;
      }
      return result === true ? "selected" : result === false ? "refused" : "skipped";
    } catch {
      return "skipped";
    }
  }

  async function runStart(
    pi: PiHost,
    ctx: any,
    launch: ResolvedLaunch,
    installSettings: InstallSettings,
    mine: number,
    listAll: boolean,
    run: LaunchRun,
  ) {
    const isStale = () => startEpoch !== mine;
    // Read before the first await: a model picked in pi from here on stops the switch at the end.
    const picksAtStart = userPicks;
    // The server of this start exited. That does not move the start epoch, so the awaits after the launch check it too: a
    // dead server must not be announced as ready, described or registered.
    let serverExited = false;
    const isAbandoned = () => isStale() || serverExited;
    active = null;
    loaded = null;
    const { modelId: model, presetKey } = launch.model;
    // The record exists from the first moment of the start; the flags line is replaced once the skipped set is known, and
    // `ready` is set where the model information is stored.
    launchRecord = {
      epoch: mine,
      modelId: model,
      ...(presetKey === undefined ? {} : { presetKey }),
      ...(run.profile === undefined ? {} : { profile: run.profile }),
      command: run.command,
      address: launch.address,
      baseUrl: launch.baseUrl,
      profileLine: describeProfile(launch),
      flagsLine: describeFlags(launch),
      requestLine: describeRequest(launch),
      ready: false,
    };
    activeBaseUrl = launch.baseUrl;
    listAllModels = listAll;
    await registerProvider(pi, { includeFallback: false, ctx, launching: model, abandon: isStale });
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

      const profileLine = describeProfile(launch);
      const flagsLine = describeFlags(launch, skipped);
      const requestLine = describeRequest(launch);
      const own = recordOf(mine);
      if (own !== null) own.flagsLine = flagsLine; // the line the start shows, skipped marks included
      ctx.ui.notify(
        `Starting MLX server with ${model}${presetKey ? ` (preset: ${presetKey})` : ""}...${profileLine ? `\n${profileLine}` : ""}${flagsLine ? `\n${flagsLine}` : ""}${requestLine ? `\n${requestLine}` : ""}`,
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
            serverExited = true;
            active = null; // a dead server's values must never apply to a later server on the same port (A7)
            loaded = null;
            if (recordOf(mine) !== null) launchRecord = null;
            progress.stop();
            ctx.ui.setStatus(PROVIDER_ID, "mlx: stopped");
            break;
        }
      }, toLaunchSpec(launch, skipped));

      if (isStale()) return;
      // Remembered here and nowhere else: the server has answered a completion and the start is neither stopped, superseded
      // nor over, so a failed or abandoned start can never overwrite a good record (D-03). Every route that starts a model
      // passes through this point (D-04). Only the model id and the profile that applied are kept (D-02).
      if (!serverExited) {
        const remembered = writeLastLaunch(statePath(), { model, profile: launch.profile?.name ?? null });
        if (!remembered.ok) {
          showConfigWarnings(ctx, [`pi-mlx-models: could not remember this launch (${remembered.reason}); /mlx-last keeps using the previous one.`]);
        }
      }
      active = { modelId: model, request: launch.request };
      activate(5, "Refreshing provider model list");
      // By now the server has downloaded the model, so its config.json is normally in the cache. A reader that fails gives
      // the fallback window and never fails the start (D-03). A profile that sets limits.contextWindow supplies the window
      // itself, so nothing is read: no config.json lookup, no Hub request and no fallback notice (D-03).
      let read: ModelConfigRead | undefined;
      if (launch.limits.contextWindow === undefined) {
        try {
          read = await deps.readModelConfig(model, { hub: true });
        } catch {
          read = { ok: false, reason: "the model reader failed" };
        }
      }
      if (isAbandoned()) return;
      // The local value, never the closure's, after an await.
      const info = deriveModelInfo({ id: model, ...(read === undefined ? {} : { config: read }), limits: launch.limits });
      loaded = { id: model, info };
      const stored = recordOf(mine);
      if (stored !== null) stored.ready = true;
      await registerProvider(pi, { includeFallback: true, ctx, abandon: isAbandoned });
      if (isAbandoned()) return;
      // A window that could not be read is registered as the fallback and said so once per model and reason (D-03). The
      // once-per-text set means "once per model id and reason" for the life of this extension instance.
      if (info.fallbackReason !== undefined) showConfigWarnings(ctx, [fallbackNotice(model, info.fallbackReason)]);
      // A sampling.maxTokens above the output limit pi is told about is said on every launch that has it: the condition
      // belongs to the launch, so no once-per-text set is used (D-08). The two settings stay independent.
      const requestedMaxTokens = launch.request.sampling.maxTokens;
      if (typeof requestedMaxTokens === "number") {
        const notice = outputLimitNotice(requestedMaxTokens, info);
        if (notice !== undefined) ctx.ui.notify(notice, "warning");
      }
      // What pi was told, and where each value came from, ahead of the ready message.
      ctx.ui.notify(describeModel(info), "info");
      progress.done(5, "Provider ready");

      progress.clear();
      ctx.ui.setStatus(PROVIDER_ID, `mlx: running (${model})`);
      // Auto-start never moves the model the user has selected: its ready message is the hint to pick it (A5).
      const outcome = run.select === false ? "skipped" : await selectStartedModel(pi, ctx, model, picksAtStart);
      // A stop, a newer start or a server exit during the switch: no ready message.
      if (isAbandoned()) return;
      if (outcome === "refused") ctx.ui.notify(selectRefusedNotice(model), "warning");
      ctx.ui.notify(outcome === "selected" ? readySelectedNotice(model) : READY_HINT, "info");
    } catch (e) {
      // /mlx-stop or a newer /mlx-start took over; their UI state wins.
      if (isStale()) return;
      if (recordOf(mine) !== null) launchRecord = null;
      progress.stop();
      // stop() only halts the animation; replace the last frame it drew so it cannot linger.
      ctx.ui.setStatus(PROVIDER_ID, "mlx: failed");
      progress.fail(step, errorMessage(e));
      ctx.ui.notify(failed(run.command, errorMessage(e)), "error");
    }
  }

  /**
   * Start the last-used model when pi opens, if the user asked for that (CMD-05, D-24 to D-29). Nobody is at the keyboard, so
   * every gate that is not met ends it quietly or with one notice that points to /mlx-start; it never opens a dialog, never
   * installs anything, never touches a server it did not start and never changes the model pi has selected.
   *
   * The gates run cheapest and quietest first: the option (off means no read, no probe and no notice), a UI, a start already
   * under way or made in this session, the remembered launch (absent is silent, unreadable gets one warning), the
   * configuration (the same refusals as /mlx-start), the port, the runtime, then the launch checks every start makes. A start
   * or stop that happens while it awaits ends it silently: whoever acted last owns the server.
   */
  async function autoStartLastLaunch(pi: PiHost, ctx: any): Promise<void> {
    // The option comes from the environment and the global file only; a project file can never turn it on (D-24, D-26).
    if (!isAutoStartRequested(readLayerFile(deps.settings.globalConfigPath), deps.settings.env)) return;
    // A one-shot print or JSON run has no user and may exit before the model loads (A4).
    if (ctx.hasUI !== true) return;
    if (startInFlight !== null || launchRecord !== null) return;
    const seen = startEpoch;
    const superseded = () => startEpoch !== seen || startInFlight !== null || launchRecord !== null;

    const record = readLastLaunch(statePath());
    // Nothing remembered: nothing to start, and defaultModel is never a fallback, so there is no unprompted first download (D-28).
    if (record.state === "absent") return;
    if (record.state === "unreadable") {
      ctx.ui.notify(`auto-start skipped: the remembered launch file ${record.reason}; run /mlx-start to choose a model`, "warning");
      return;
    }

    const settings = readLaunchSettings(pi, ctx, "auto-start", [], { skipProjectFile: true });
    if (settings === undefined) return;
    const { prepared } = settings;

    // Something that answers is not ours: auto-start registers, adopts and stops nothing (D-26, T-06-35).
    const occupied = await deps.probePort(prepared.address.host, prepared.address.port);
    if (superseded()) return;
    if (occupied) {
      ctx.ui.notify(`auto-start skipped: something already answers on port ${prepared.address.port}`, "info");
      return;
    }

    // The runtime is only looked at, never installed: a missing one is /mlx-init's job (D-27, T-06-36).
    const installed = await deps.runtimeInstalled();
    if (superseded()) return;
    if (!installed) {
      ctx.ui.notify("auto-start skipped: the MLX runtime is not installed; run /mlx-init, then /mlx-start", "warning");
      return;
    }

    await startModelFromInput(pi, ctx, record.value.model, prepared, {
      command: "auto-start",
      ...(record.value.profile === null ? {} : { profile: record.value.profile, profileOrigin: "kept" as const }),
      select: false,
      interactive: false,
    });
  }

  return async function extension(pi: PiHost) {
    // Registered before the first await. String flags with no default: pi writes a default into its flag values
    // at registration, which would make the flag outrank the environment and the files (D-09).
    for (const flag of PI_FLAGS) pi.registerFlag(flag.name, { description: flag.description, type: "string" });

    const ambient = ambientSettings();
    activeBaseUrl = ambient.baseUrl;
    // No project directory exists yet, so the load-time list follows the global file and the environment only; every start
    // then uses the value of its own configuration, project file included.
    listAllModels = ambient.listAllModels;
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
        const parsed = parseStartArgs(args ?? "", [...cliFlagSpecs(), PROFILE_FLAG_SPEC]);
        if (!parsed.ok) {
          ctx.ui.notify(failed("mlx-start", parsed.error), "error");
          return;
        }
        const settings = readLaunchSettings(pi, ctx, "mlx-start", parsed.flags, { readModelFlag: true });
        if (settings === undefined) return;
        const { prepared, profile, modelFlag } = settings;

        const run: LaunchRun = { command: "mlx-start", ...(profile === undefined ? {} : { profile, profileOrigin: "typed" }) };

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
          await startModelFromInput(pi, ctx, preset.key, prepared, run);
          return;
        }

        await startModelFromInput(pi, ctx, modelInput, prepared, run);
      },
    });

    pi.registerCommand("mlx-last", {
      description: "Start the model of the last launch again, with its profile. Usage: /mlx-last [--profile name] [--flag value ...]",
      handler: async (args, ctx) => {
        // The same flags as /mlx-start and no model: the model comes from the record (D-07).
        const parsed = parseStartArgs(args ?? "", [...cliFlagSpecs(), PROFILE_FLAG_SPEC], { command: "/mlx-last", takesModel: false });
        if (!parsed.ok) {
          ctx.ui.notify(failed("mlx-last", parsed.error), "error");
          return;
        }
        // The record is read before any configuration, so a user with nothing to relaunch gets that answer first (D-06).
        const record = readLastLaunch(statePath());
        if (record.state === "absent") {
          ctx.ui.notify("mlx-last: nothing is remembered yet. Run /mlx-start to pick a model; the next successful start is remembered.", "info");
          return;
        }
        if (record.state === "unreadable") {
          ctx.ui.notify(
            failed(
              "mlx-last",
              `the remembered launch file ${record.reason}; treating it as nothing remembered. Run /mlx-start to choose a model; a successful start replaces the file.`,
            ),
            "error",
          );
          return;
        }
        const settings = readLaunchSettings(pi, ctx, "mlx-last", parsed.flags);
        if (settings === undefined) return;
        const { prepared, profile: typedProfile } = settings;
        // A typed --profile beats the remembered one; a remembered profile the model no longer defines is refused by
        // buildLaunch, with no fallback to another profile or to the bare model (D-06).
        const profile = typedProfile ?? record.value.profile ?? undefined;
        const run: LaunchRun = {
          command: "mlx-last",
          ...(profile === undefined ? {} : { profile, profileOrigin: typedProfile !== undefined ? "typed" : "kept" }),
        };
        await startModelFromInput(pi, ctx, record.value.model, prepared, run);
      },
    });

    pi.registerCommand("mlx-restart", {
      description:
        "Restart the server with the same model and profile selection, through the settings as they are now. Usage: /mlx-restart [--profile name] [--flag value ...]",
      handler: async (args, ctx) => {
        // The same flags as /mlx-start and no model: the model comes from the running launch (D-14).
        const parsed = parseStartArgs(args ?? "", [...cliFlagSpecs(), PROFILE_FLAG_SPEC], { command: "/mlx-restart", takesModel: false });
        if (!parsed.ok) {
          ctx.ui.notify(failed("mlx-restart", parsed.error), "error");
          return;
        }
        // The model and the selection to keep: the launch of this session when there is one, else the remembered last launch
        // (D-16). The record is read before any configuration, as /mlx-last does, so a user with nothing to restart hears that first.
        let model: string;
        let kept: string | undefined;
        let fromLast = false;
        const running = launchRecord;
        if (running !== null) {
          model = running.modelId;
          kept = running.profile;
        } else {
          const record = readLastLaunch(statePath());
          if (record.state === "absent") {
            ctx.ui.notify("mlx-restart: nothing is running and nothing is remembered. Run /mlx-start to pick a model.", "info");
            return;
          }
          if (record.state === "unreadable") {
            ctx.ui.notify(
              failed(
                "mlx-restart",
                `the remembered launch file ${record.reason}; treating it as nothing remembered. Run /mlx-start to choose a model; a successful start replaces the file.`,
              ),
              "error",
            );
            return;
          }
          model = record.value.model;
          kept = record.value.profile ?? undefined;
          fromLast = true;
        }
        // Everything is validated and confirmed before the server is touched, and this handler never stops it: the server's
        // own start stops the previous process and waits for its port, so a refused restart leaves the running server alone.
        const settings = readLaunchSettings(pi, ctx, "mlx-restart", parsed.flags);
        if (settings === undefined) return;
        const { prepared, profile: typedProfile } = settings;
        // The selection handed to the earlier launch is kept: a name stays a name, and no selection lets defaultProfile decide
        // again. Flags are never kept; only the ones typed here apply (D-13, D-14).
        const profile = typedProfile ?? kept;
        const run: LaunchRun = {
          command: "mlx-restart",
          ...(profile === undefined ? {} : { profile, profileOrigin: typedProfile !== undefined ? "typed" : "kept" }),
        };
        // Said after the configuration validated and before the start, so an invalid file is reported first and a declined
        // confirmation after the note says what was about to start.
        if (fromLast) ctx.ui.notify(`mlx-restart: nothing was running, starting ${shownModelId(model)} from the last launch.`, "info");
        await startModelFromInput(pi, ctx, model, prepared, run);
      },
    });

    pi.registerCommand("mlx-status", {
      description: "Show the MLX server: model, profile, port, flags in effect and health (down, loading, ready)",
      handler: async (args, ctx) => {
        // No arguments: nothing typed here can choose an address or a setting.
        const parsed = parseStartArgs(args ?? "", [], { command: "/mlx-status", takesModel: false });
        if (!parsed.ok) {
          ctx.ui.notify(failed("mlx-status", parsed.error), "error");
          return;
        }
        const snapshot = launchRecord;
        let address: ServerAddress;
        let baseUrl: string;
        if (snapshot !== null) {
          ({ address, baseUrl } = snapshot);
        } else {
          // No launch of this session: look where the configuration says a server would be, read now. The refusals are the
          // launch commands' own and come before any connection, so a cloned project cannot choose where this connects (T-06-28).
          const piFlags: Record<string, string> = {};
          for (const flag of PI_FLAGS) {
            const value = flag.path === undefined ? undefined : pi.getFlag(flag.name);
            if (typeof value === "string") piFlags[flag.name] = value;
          }
          const result = prepareSettings({
            global: readLayerFile(deps.settings.globalConfigPath),
            project: readLayerFile(join(workingDirectory(ctx), PROJECT_CONFIG_RELPATH)),
            env: deps.settings.env,
            piFlags,
            ignoreInstall: true,
          });
          showConfigWarnings(ctx, result.warnings);
          if (!result.ok) {
            ctx.ui.notify(failed("mlx-status", formatConfigErrors(result.errors)), "error");
            return;
          }
          if (result.prepared.projectViolations.length > 0) {
            ctx.ui.notify(failed("mlx-status", formatProjectRefusal(result.prepared.projectViolations, deps.settings.globalConfigPath)), "error");
            return;
          }
          ({ address, baseUrl } = result.prepared);
        }

        const probe = await deps.probeHealth(address, baseUrl);
        // Health is observed, never stored. A record that was cleared or replaced during the probe no longer describes it.
        const record = snapshot !== null && recordOf(snapshot.epoch) !== null ? snapshot : null;
        const session: SessionState = record === null ? "none" : record.ready ? "ready" : "starting";
        const view: StatusView = {
          health: classifyHealth(session, probe),
          address,
          session,
          ...(record === null
            ? {}
            : {
                launch: {
                  modelId: record.modelId,
                  ...(record.presetKey === undefined ? {} : { presetKey: record.presetKey }),
                  profileLine: record.profileLine,
                  flagsLine: record.flagsLine,
                  requestLine: record.requestLine,
                  // The line the start showed, from the model information the start kept; nothing is read again (D-10).
                  ...(record.ready && loaded !== null && loaded.id === record.modelId ? { modelLine: describeModel(loaded.info) } : {}),
                },
              }),
          served: probe.models.answers ? probe.models.ids : [],
        };
        ctx.ui.notify(formatStatus(view), "info");
      },
    });

    pi.registerCommand("mlx-config", {
      description: "View and edit the global config file and its profiles in a menu. Edits take effect on the next start; no arguments",
      handler: async (args, ctx) => {
        // No arguments: nothing typed here can name a key, a value or a path (D-17, T-06-31). Refused before the menu opens.
        const parsed = parseStartArgs(args ?? "", [], { command: "/mlx-config", takesModel: false });
        if (!parsed.ok) {
          ctx.ui.notify(failed("mlx-config", parsed.error), "error");
          return;
        }
        // Only the global file is handed over, so no project file is offered or written (D-18). The command never starts, stops
        // or restarts anything (D-22); `serverRunning` only decides whether a saved notice points to /mlx-restart.
        await runConfigMenu({
          ui: ctx.ui,
          hasUI: ctx.hasUI === true,
          path: deps.settings.globalConfigPath,
          serverRunning: launchRecord !== null,
        });
      },
    });

    pi.registerCommand("mlx-stop", {
      description: "Stop local MLX server",
      handler: async (_args, ctx) => {
        await stopServer(ctx);
        await registerProvider(pi, { includeFallback: false, ctx });
        ctx.ui.notify("MLX server stopped.", "info");
      },
    });

    pi.on("session_shutdown", async () => {
      cancelStarts(); // a start still waiting on the installer must not launch a server after shutdown
      active = null; // the values end with the launch, before any await (D-12)
      loaded = null;
      launchRecord = null;
      activeProgress?.stop();
      // Wait for the child to exit so a quitting pi does not leave it holding the port, but never
      // let a stop that hangs (or rejects) hold up the exit or the provider clean-up below.
      await Promise.race([server.stop().catch(() => {}), deps.sleep(deps.shutdownWaitMs)]);
      await registerProvider(pi, { includeFallback: false });
    });

    // Fires for every session start, whatever the reason: the shutdown before a new, resumed, forked or reloaded session stopped
    // the server, so the option means "when pi opens a session". The work runs in the background and this returns at once, so
    // pi's startup is never held up (D-25, T-06-38); a failure in it becomes one notice instead of an unhandled rejection.
    pi.on("session_start", (_event, ctx) => {
      const work = autoStartLastLaunch(pi, ctx).catch((e) => {
        try {
          ctx.ui.notify(`auto-start failed: ${clipDiagnostic(redactCredentials(cleanLabel(errorMessage(e))), 300, "start")}`, "error");
        } catch {
          // No way left to tell the user; the work is over either way.
        }
      });
      deps.trackBackground?.(work);
    });

    // Every change of the active model arrives here. The ones our own switch raises are not the user's choice and are not counted.
    pi.on("model_select", () => {
      if (!switching) userPicks += 1;
    });

    // The payload of every request pi sends goes through here, other providers' included. Only a request for this provider's
    // launched model is rewritten, from values held in memory: no file is read (D-12). It never throws and never mutates (D-11).
    pi.on("before_provider_request", (event, ctx) => {
      try {
        if (active === null || ctx?.model?.provider !== PROVIDER_ID) return undefined;
        const rewrite = applyRequestOverrides(event?.payload, active);
        if (rewrite.kind === "bad-shape" && !badShapeShown) {
          badShapeShown = true;
          ctx?.ui?.notify?.(BAD_SHAPE_NOTICE, "warning");
        }
        // A payload with a model id other than the launched one is left alone (D-13); say so once, because the values the
        // user configured then never reach the server (WR-02). Only the matching rule in applyRequestOverrides decides.
        if (rewrite.kind === "unchanged" && !modelMismatchShown) {
          const model = (event?.payload as { model?: unknown } | null | undefined)?.model;
          if (typeof model === "string" && model !== active.modelId) {
            modelMismatchShown = true;
            ctx?.ui?.notify?.(modelMismatchNotice(active.modelId), "warning");
          }
        }
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

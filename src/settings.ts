import { readFileSync } from "node:fs";
import { DEFAULT_HOST, DEFAULT_MODEL_ID, DEFAULT_PORT, baseUrlWarning, deriveBaseUrl, envText } from "./config.js";
import { cleanLabel, clipDiagnostic } from "./diagnostic.js";
import type { LaunchSpec, ServerAddress } from "./server.js";

/**
 * Layered configuration. One table (`SETTINGS`) says what a setting is called in each layer, how its
 * value is checked and how it reaches the server's argv; `prepareSettings` merges the layers by a fixed
 * precedence and `buildLaunch` pairs the result with the model being started.
 *
 * Values reach the child process only as validated argv elements: nothing is concatenated into a flag
 * name, and a value that fails its row check never gets past this module.
 */

/** The layers, from highest precedence to lowest (the built-in default sits below all of them). */
export type LayerName = "args" | "piFlags" | "env" | "project" | "global";

const PRECEDENCE: readonly LayerName[] = ["args", "piFlags", "env", "project", "global"];

/** What reading a config file found. Reading never throws. */
export type LayerFile =
  | { state: "absent" }
  | { state: "unusable"; reason: string }
  | { state: "ok"; data: Record<string, unknown> };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read and parse one config file. A missing file is simply absent; anything else wrong with it is unusable. */
export function readLayerFile(path: string): LayerFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
    return { state: "unusable", reason: `cannot be read: ${clipDiagnostic(cleanLabel(String((error as Error).message ?? error)), 200, "start")}` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { state: "unusable", reason: `is not valid JSON: ${clipDiagnostic(cleanLabel(String((error as Error).message ?? error)), 200, "start")}` };
  }
  if (!isPlainObject(data)) return { state: "unusable", reason: "must contain a JSON object at the top level" };
  return { state: "ok", data };
}

/** Where settings come from. Injectable so tests need neither the real environment nor the real home directory. */
export interface SettingsSource {
  env: NodeJS.ProcessEnv;
  globalConfigPath: string;
  home: string;
}

export type SettingValue = string | number | boolean;

type CheckResult = { ok: true; value: SettingValue } | { ok: false };

export interface SettingDef {
  /** Dotted key in the config file: "server.port" is the `port` key of the `server` block; a top-level key has no dot (D-01). */
  path: string;
  kind: "string" | "integer" | "enum";
  /** The allowed values in words, used in every error and warning about this row. */
  expected: string;
  /** Strict check of a value read from a JSON file: no coercion (D-07). */
  check(value: unknown): CheckResult;
  /** Check of a value that arrives as text (environment, later command flags); same range or enum as `check`. */
  parseText(raw: string): CheckResult;
  /** Environment variable that sets this row. */
  env?: string;
  /** An empty-but-defined environment variable is an invalid value, not an unset one. */
  blankEnvInvalid?: boolean;
  /** `/mlx-start` flag name (a later plan fills this in). */
  arg?: string;
  /** pi flag name (a later plan fills this in). */
  piFlag?: string;
  /** The mlx_lm.server flag this row becomes. */
  mlxFlag?: string;
  /** Host and port become the address and are never optional argv. */
  core?: boolean;
  /** The argv elements for a value; a valued flag is a single `--flag=value` element. */
  emit(value: SettingValue): string[];
  /** The value when no layer sets the row; a row without a default is emitted whenever a layer sets it. */
  default?: SettingValue;
}

const ok = (value: SettingValue): CheckResult => ({ ok: true, value });
const bad: CheckResult = { ok: false };

const HOST_PATTERN = /^[A-Za-z0-9.:_[\]-]+$/;

function checkHost(value: unknown): CheckResult {
  if (typeof value !== "string" || value.length < 1 || value.length > 253) return bad;
  if (value.startsWith("-") || !HOST_PATTERN.test(value)) return bad;
  return ok(value);
}

function checkPort(value: unknown): CheckResult {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) return bad;
  return ok(value);
}

const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

function checkLogLevel(value: unknown): CheckResult {
  return typeof value === "string" && LOG_LEVELS.includes(value) ? ok(value) : bad;
}

function checkBaseUrl(value: unknown): CheckResult {
  if (typeof value !== "string" || value !== value.trim()) return bad;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return bad;
  // Callers append "/models" and "/chat/completions", so a trailing slash would yield "//models".
  return ok(value.replace(/\/+$/, ""));
}

function checkModel(value: unknown): CheckResult {
  if (typeof value !== "string") return bad;
  const trimmed = value.trim();
  return trimmed ? ok(trimmed) : bad;
}

const valued = (flag: string) => (value: SettingValue) => [`${flag}=${value}`];

/** The schema, in the order flags are listed in the start message. */
export const SETTINGS: readonly SettingDef[] = [
  {
    path: "server.host",
    kind: "string",
    expected: "a host name or address (1 to 253 characters: letters, digits and . : _ - [ ], not starting with -)",
    check: checkHost,
    parseText: (raw) => checkHost(raw.trim()),
    env: "PI_MLX_MODELS_HOST",
    mlxFlag: "--host",
    core: true,
    emit: valued("--host"),
    default: DEFAULT_HOST,
  },
  {
    path: "server.port",
    kind: "integer",
    expected: "a port number from 1 to 65535",
    check: checkPort,
    parseText: (raw) => {
      const trimmed = raw.trim();
      return /^\d+$/.test(trimmed) ? checkPort(Number(trimmed)) : bad;
    },
    env: "PI_MLX_MODELS_PORT",
    blankEnvInvalid: true,
    mlxFlag: "--port",
    core: true,
    emit: valued("--port"),
    default: DEFAULT_PORT,
  },
  {
    path: "server.logLevel",
    kind: "enum",
    expected: `one of ${LOG_LEVELS.join(", ")}`,
    check: checkLogLevel,
    parseText: (raw) => checkLogLevel(raw.trim()),
    mlxFlag: "--log-level",
    emit: valued("--log-level"),
  },
  {
    path: "baseUrl",
    kind: "string",
    expected: "an http or https URL",
    check: checkBaseUrl,
    parseText: (raw) => checkBaseUrl(raw.trim()),
    env: "PI_MLX_MODELS_BASE_URL",
    emit: () => [],
  },
  {
    path: "defaultModel",
    kind: "string",
    expected: "a non-empty model id or preset key",
    check: checkModel,
    parseText: checkModel,
    env: "PI_MLX_MODELS_DEFAULT_MODEL",
    emit: () => [],
  },
];

const ROWS_BY_PATH = new Map(SETTINGS.map((row) => [row.path, row]));
/** The block names of nested keys, e.g. "server". */
const BLOCKS = new Set(SETTINGS.filter((row) => row.path.includes(".")).map((row) => row.path.split(".")[0]));

const FILE_LABEL = { global: "global config.json", project: "project .pi/pi-mlx-models.json" } as const;

/** Text that came from a file, the environment or a flag, made safe and bounded before it is shown (D-24). */
const show = (text: string): string => clipDiagnostic(cleanLabel(text), 60, "start");
const showValue = (value: unknown): string => show(JSON.stringify(value) ?? String(value));

/** The layer name as it appears in the flags line. */
function displayLabel(layer: LayerName, row: SettingDef): string {
  switch (layer) {
    case "global":
      return "global file";
    case "project":
      return "project file";
    case "args":
      return "/mlx-start";
    case "piFlags":
      return `pi flag ${row.piFlag}`;
    case "env":
      return `env ${row.env}`;
  }
}

/** What names the value in a base URL warning. */
function sourceName(layer: LayerName, row: SettingDef): string {
  switch (layer) {
    case "global":
    case "project":
      return `${row.path} in ${FILE_LABEL[layer]}`;
    case "args":
      return String(row.arg);
    case "piFlags":
      return String(row.piFlag);
    case "env":
      return String(row.env);
  }
}

export interface PrepareInput {
  global: LayerFile;
  project?: LayerFile;
  env: Record<string, string | undefined>;
  piFlags?: Record<string, string | undefined>;
  args?: Record<string, string | true>;
}

export interface LaunchFlag {
  path: string;
  flag: string;
  args: string[];
  display: string;
  label: string;
  core: boolean;
}

export interface Prepared {
  address: ServerAddress;
  baseUrl: string;
  defaultModel: string;
  /** Every row with an mlx flag that some layer set to a value other than its default, in schema order. */
  flags: LaunchFlag[];
}

export type PrepareResult =
  | { ok: true; prepared: Prepared; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** The valid values of one config file, plus a line for everything wrong with it (D-06). */
function readFileLayer(file: LayerFile | undefined, layer: "global" | "project", errors: string[]): Map<string, SettingValue> {
  const values = new Map<string, SettingValue>();
  const label = FILE_LABEL[layer];
  if (file === undefined || file.state === "absent") return values;
  if (file.state === "unusable") {
    errors.push(`${label}: ${file.reason}`);
    return values;
  }
  const consider = (path: string, value: unknown, topLevel: boolean) => {
    const row = topLevel && path.includes(".") ? undefined : ROWS_BY_PATH.get(path);
    if (row === undefined) {
      errors.push(`${show(path)} (${label}): unknown key`);
      return;
    }
    const result = row.check(value);
    if (result.ok) values.set(path, result.value);
    else errors.push(`${path} (${label}): expected ${row.expected}, got ${showValue(value)}`);
  };
  for (const [key, value] of Object.entries(file.data)) {
    if (!BLOCKS.has(key)) {
      consider(key, value, true);
    } else if (!isPlainObject(value)) {
      errors.push(`${key} (${label}): expected an object of settings, got ${showValue(value)}`);
    } else {
      for (const [child, childValue] of Object.entries(value)) consider(`${key}.${child}`, childValue, false);
    }
  }
  return values;
}

/**
 * Merge the layers into one launch preparation. Precedence is fixed (D-12): `/mlx-start` flags, pi flags,
 * environment, project file, global file, built-in default. A file that is unusable, has an unknown key or
 * a value failing its check refuses the start (errors); a bad environment value is dropped with a warning
 * and resolution continues with the next lower layer.
 */
export function prepareSettings(input: PrepareInput): PrepareResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fileValues = {
    global: readFileLayer(input.global, "global", errors),
    project: readFileLayer(input.project, "project", errors),
  };

  const resolved = new Map<string, { value: SettingValue; layer: LayerName }>();
  const candidate = (row: SettingDef, layer: LayerName): SettingValue | undefined => {
    switch (layer) {
      case "global":
      case "project":
        return fileValues[layer].get(row.path);
      case "env": {
        if (row.env === undefined) return undefined;
        const raw = input.env[row.env];
        if (raw === undefined) return undefined;
        if (!row.blankEnvInvalid && envText(raw) === undefined) return undefined;
        const result = row.parseText(raw);
        if (result.ok) return result.value;
        warnings.push(`${row.env}=${showValue(raw)} is not ${row.expected}; ignoring it.`);
        return undefined;
      }
      case "args":
      case "piFlags": {
        const name = layer === "args" ? row.arg : row.piFlag;
        if (name === undefined) return undefined;
        const raw = layer === "args" ? input.args?.[name] : input.piFlags?.[name];
        if (raw === undefined) return undefined;
        const label = displayLabel(layer, row);
        if (raw === true) {
          errors.push(`${name} (${label}): needs a value (${row.expected})`);
          return undefined;
        }
        const result = row.parseText(raw);
        if (result.ok) return result.value;
        errors.push(`${name} (${label}): expected ${row.expected}, got ${showValue(raw)}`);
        return undefined;
      }
    }
  };
  for (const row of SETTINGS) {
    for (const layer of PRECEDENCE) {
      const value = candidate(row, layer);
      if (value !== undefined) {
        resolved.set(row.path, { value, layer });
        break;
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  const value = (path: string): SettingValue | undefined => resolved.get(path)?.value;
  const address: ServerAddress = {
    host: String(value("server.host") ?? DEFAULT_HOST),
    port: Number(value("server.port") ?? DEFAULT_PORT),
  };

  const baseUrlHit = resolved.get("baseUrl");
  let baseUrl: string;
  if (baseUrlHit === undefined) {
    baseUrl = deriveBaseUrl(address.host, address.port);
  } else {
    baseUrl = String(baseUrlHit.value);
    const mismatch = baseUrlWarning({
      baseUrl,
      host: address.host,
      port: address.port,
      source: sourceName(baseUrlHit.layer, ROWS_BY_PATH.get("baseUrl") as SettingDef),
    });
    if (mismatch) warnings.push(mismatch);
  }

  const flags: LaunchFlag[] = [];
  for (const row of SETTINGS) {
    const hit = resolved.get(row.path);
    if (row.mlxFlag === undefined || hit === undefined || hit.value === row.default) continue;
    flags.push({
      path: row.path,
      flag: row.mlxFlag,
      args: row.emit(hit.value),
      display: typeof hit.value === "boolean" ? "" : show(String(hit.value)),
      label: displayLabel(hit.layer, row),
      core: row.core === true,
    });
  }

  return {
    ok: true,
    prepared: { address, baseUrl, defaultModel: String(value("defaultModel") ?? DEFAULT_MODEL_ID), flags },
    warnings,
  };
}

export interface ResolvedLaunch {
  model: { modelId: string; presetKey?: string };
  address: ServerAddress;
  baseUrl: string;
  flags: LaunchFlag[];
}

export type BuildResult = { ok: true; launch: ResolvedLaunch } | { ok: false; errors: string[] };

/** Pair the prepared settings with the model being started. Later plans add model-specific rows here. */
export function buildLaunch(prepared: Prepared, model: { modelId: string; presetKey?: string }): BuildResult {
  return {
    ok: true,
    launch: { model, address: prepared.address, baseUrl: prepared.baseUrl, flags: prepared.flags },
  };
}

/** What the server host needs: the address, the URL, and the optional flags in schema order. */
export function toLaunchSpec(launch: ResolvedLaunch): LaunchSpec {
  return {
    address: launch.address,
    baseUrl: launch.baseUrl,
    extraArgs: launch.flags.filter((flag) => !flag.core).flatMap((flag) => flag.args),
  };
}

/** The "flags: ..." line of the start message, or "" when no flag differs from its default (D-11). */
export function describeFlags(launch: ResolvedLaunch): string {
  if (launch.flags.length === 0) return "";
  const parts = launch.flags.map((flag) => `${flag.flag}${flag.display ? ` ${flag.display}` : ""} (${flag.label})`);
  return `flags: ${parts.join(", ")}`;
}

/** The body of an "invalid configuration" error notification. */
export function formatConfigErrors(errors: readonly string[]): string {
  return ["invalid configuration", ...errors.map((line) => `  ${line}`)].join("\n");
}

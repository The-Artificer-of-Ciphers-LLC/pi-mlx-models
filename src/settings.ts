import { readFileSync, statSync } from "node:fs";
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

/** The largest config file that is read (T-02-07). A real config is a few hundred bytes. */
const MAX_FILE_BYTES = 256 * 1024;

/** Text from the file system or the JSON parser, made single-line, safe and bounded before it goes in a reason. */
const reasonText = (text: string, max: number): string => clipDiagnostic(cleanLabel(text), max, "start");

const unusable = (reason: string): LayerFile => ({ state: "unusable", reason });

/**
 * Read and parse one config file. Reading never throws.
 *
 * A path that is not there (or sits under something that is not a directory) is simply absent and nothing is
 * created. Anything else wrong with the file is unusable, with a reason that never contains the path: the
 * caller prefixes the layer label. The file is looked at with `stat` first so a directory, a device or a huge
 * file is refused without being read (T-02-07).
 */
export function readLayerFile(path: string): LayerFile {
  const cannotRead = (error: unknown): LayerFile => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return unusable(`cannot be read (${typeof code === "string" ? reasonText(code, 40) : "unknown error"})`);
  };
  let bytes: Buffer;
  try {
    const info = statSync(path);
    if (!info.isFile()) return unusable("is not a regular file");
    if (info.size > MAX_FILE_BYTES) return unusable("is larger than 256 KiB");
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
    return cannotRead(error);
  }
  // The file may have grown between the stat and the read.
  if (bytes.length > MAX_FILE_BYTES) return unusable("is larger than 256 KiB");
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return unusable("is empty");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return unusable(`is not valid JSON (${reasonText(String((error as Error).message ?? error), 120)})`);
  }
  if (!isPlainObject(data)) return unusable("must contain a JSON object at the top level");
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
  /** The problem line for a value that failed `check`; `shown` is the value already cleaned and clipped. */
  problem(shown: string): string;
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

/**
 * The wording of every "this value is wrong" line, one phrase per kind of row. `shown` is the offending
 * value as JSON, already cleaned and clipped, so nothing here needs to sanitize (D-24).
 */
const PHRASES = {
  integerRange: (min: number, max: number) => (shown: string) => `${shown} is not an integer from ${min} to ${max}`,
  integerAtLeast: (min: number) => (shown: string) => `${shown} is not an integer of at least ${min}`,
  oneOf: (members: readonly string[]) => (shown: string) => `${shown} must be one of ${members.join(", ")}`,
  boolean: (shown: string) => `${shown} must be true or false`,
  string: (shown: string) => `${shown} must be a non-empty string`,
  host: (shown: string) => `${shown} is not a valid host name or address`,
  url: (shown: string) => `${shown} must be an http or https URL`,
  list: (shown: string) => `${shown} must be a list of non-empty strings without commas or spaces`,
  object: (shown: string) => `${shown} must be a JSON object`,
};

/** The schema, in the order flags are listed in the start message. */
export const SETTINGS: readonly SettingDef[] = [
  {
    path: "server.host",
    kind: "string",
    expected: "a host name or address (1 to 253 characters: letters, digits and . : _ - [ ], not starting with -)",
    check: checkHost,
    problem: PHRASES.host,
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
    problem: PHRASES.integerRange(1, 65535),
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
    problem: PHRASES.oneOf(LOG_LEVELS),
    parseText: (raw) => checkLogLevel(raw.trim()),
    mlxFlag: "--log-level",
    emit: valued("--log-level"),
  },
  {
    path: "baseUrl",
    kind: "string",
    expected: "an http or https URL",
    check: checkBaseUrl,
    problem: PHRASES.url,
    parseText: (raw) => checkBaseUrl(raw.trim()),
    env: "PI_MLX_MODELS_BASE_URL",
    emit: () => [],
  },
  {
    path: "defaultModel",
    kind: "string",
    expected: "a non-empty model id or preset key",
    check: checkModel,
    problem: PHRASES.string,
    parseText: checkModel,
    env: "PI_MLX_MODELS_DEFAULT_MODEL",
    emit: () => [],
  },
];

const ROWS_BY_PATH = new Map(SETTINGS.map((row) => [row.path, row]));
/** The block names of nested keys, e.g. "server". */
const BLOCKS = new Set(SETTINGS.filter((row) => row.path.includes(".")).map((row) => row.path.split(".")[0]));

/** A key a user could have meant: its full dotted path, and the name it is written as at its own level. */
interface Candidate {
  path: string;
  name: string;
}

/** The keys valid at the top level of a file, in schema order: block names and top-level rows. */
const TOP_LEVEL: readonly Candidate[] = [...new Set(SETTINGS.map((row) => row.path.split(".")[0]))].map((name) => ({ path: name, name }));

/** The keys of nested rows, in schema order; `inBlock` keeps only that block's, `exceptBlock` drops it. */
function nestedKeys(filter: { inBlock?: string; exceptBlock?: string }): Candidate[] {
  return SETTINGS.filter((row) => row.path.includes(".")).flatMap((row) => {
    const dot = row.path.indexOf(".");
    const block = row.path.slice(0, dot);
    if (filter.inBlock !== undefined && block !== filter.inBlock) return [];
    if (filter.exceptBlock !== undefined && block === filter.exceptBlock) return [];
    return [{ path: row.path, name: row.path.slice(dot + 1) }];
  });
}

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, "");

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent swaps each cost 1. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** How far `key` is from a candidate name when they are close enough to suggest, else undefined. */
function closeness(key: string, name: string): number | undefined {
  if (normalizeKey(key) === normalizeKey(name)) return 0;
  // Two characters of difference is the limit, so a much longer or shorter key cannot match (and is not measured).
  if (key.length < 3 || name.length < 3 || Math.abs(key.length - name.length) > 2) return undefined;
  const distance = editDistance(key.toLowerCase(), name.toLowerCase());
  return distance <= 2 ? distance : undefined;
}

/** The nearest candidate, the earliest in schema order on a tie. */
function nearest(key: string, candidates: readonly Candidate[]): string | undefined {
  let best: { path: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = closeness(key, candidate.name);
    if (distance !== undefined && (best === undefined || distance < best.distance)) best = { path: candidate.path, distance };
  }
  return best?.path;
}

/**
 * The path of the key the user probably meant by an unknown `key` (inside `block`, or at the top level when
 * undefined), or undefined when nothing is close. Keys valid at the same level are tried first; only when
 * none is close are other levels tried, which catches a key written at the wrong level (D-24).
 */
function suggestKey(key: string, block: string | undefined): string | undefined {
  if (block === undefined) return nearest(key, TOP_LEVEL) ?? nearest(key, nestedKeys({}));
  return nearest(key, nestedKeys({ inBlock: block })) ?? nearest(key, [...nestedKeys({ exceptBlock: block }), ...TOP_LEVEL]);
}

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

const flagSuffix = (row: SettingDef): string => (row.mlxFlag === undefined ? "" : ` (flag ${row.mlxFlag})`);

/** A key as echoed in a message: cleaned and at most 80 characters. */
const showKey = (path: string): string => clipDiagnostic(cleanLabel(path), 80, "start");

/**
 * The valid values of one config file, plus a line in `problems` for everything wrong with it (D-06, D-07).
 * Keys are compared against the schema with Map and Set lookups only, and parsed keys are never assigned onto
 * another object, so a key such as `__proto__` is just an unknown key (T-02-08).
 */
function readFileLayer(file: LayerFile | undefined, layer: "global" | "project", problems: string[]): Map<string, SettingValue> {
  const values = new Map<string, SettingValue>();
  const label = FILE_LABEL[layer];
  if (file === undefined || file.state === "absent") return values;
  if (file.state === "unusable") {
    problems.push(`${label}: ${clipDiagnostic(cleanLabel(file.reason), 200, "start")}`);
    return values;
  }
  const consider = (block: string | undefined, key: string, value: unknown) => {
    const path = block === undefined ? key : `${block}.${key}`;
    // A top-level key that happens to contain a dot is not the nested key it resembles.
    const row = block === undefined && key.includes(".") ? undefined : ROWS_BY_PATH.get(path);
    if (row === undefined) {
      const meant = suggestKey(key, block);
      problems.push(`${showKey(path)} (${label}): unknown key${meant === undefined ? "" : ` (did you mean ${meant}?)`}`);
      return;
    }
    const result = row.check(value);
    if (result.ok) values.set(path, result.value);
    else problems.push(`${path} (${label}): ${row.problem(showValue(value))}${flagSuffix(row)}`);
  };
  for (const [key, value] of Object.entries(file.data)) {
    if (!BLOCKS.has(key)) {
      consider(undefined, key, value);
    } else if (!isPlainObject(value)) {
      problems.push(`${key} (${label}): ${PHRASES.object(showValue(value))}`);
    } else {
      for (const [child, childValue] of Object.entries(value)) consider(key, child, childValue);
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
  const warnings: string[] = [];
  // Problems are collected per layer and reported highest precedence first (the environment only warns).
  const problems: Record<LayerName, string[]> = { args: [], piFlags: [], env: [], project: [], global: [] };
  const fileValues = {
    global: readFileLayer(input.global, "global", problems.global),
    project: readFileLayer(input.project, "project", problems.project),
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
          problems[layer].push(`${name} (${label}): needs a value (${row.expected})${flagSuffix(row)}`);
          return undefined;
        }
        const result = row.parseText(raw);
        if (result.ok) return result.value;
        problems[layer].push(`${name} (${label}): ${row.problem(showValue(raw))}${flagSuffix(row)}`);
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
  const errors = PRECEDENCE.flatMap((layer) => problems[layer]);
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

/** The most problem lines one refusal shows; the rest are counted. */
const MAX_REPORT_LINES = 20;

/** The body of an "invalid configuration" error notification: every problem on its own indented line. */
export function formatConfigErrors(errors: readonly string[]): string {
  const lines = ["invalid configuration", ...errors.slice(0, MAX_REPORT_LINES).map((line) => `  ${line}`)];
  const more = errors.length - MAX_REPORT_LINES;
  if (more > 0) lines.push(`  ...and ${more} more problem${more === 1 ? "" : "s"}`);
  return lines.join("\n");
}

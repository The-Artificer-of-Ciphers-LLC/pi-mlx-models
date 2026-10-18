import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { DEFAULT_HOST, DEFAULT_MODEL_ID, DEFAULT_PIP_INDEX, DEFAULT_PORT, baseUrlWarning, deriveBaseUrl, envText, isLoopbackHost } from "./config.js";
import { cleanLabel, clipDiagnostic, redactCredentials } from "./diagnostic.js";
import type { LaunchSpec, ServerAddress } from "./server.js";
import type { CliFlagSpec } from "./startargs.js";

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

/** A JSON value as it sits in a setting that holds an object: parsed, checked and copied, never the parser's own objects. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** An object-valued setting; its objects have no prototype, so no key can reach `Object.prototype`. */
export type SettingObject = { [key: string]: JsonValue };

export type SettingValue = string | number | boolean | SettingObject;

/** A value that failed its check; `problem` words the line when this row's usual phrase does not fit the failure. */
type CheckResult = { ok: true; value: SettingValue } | { ok: false; problem?: (shown: string) => string };

export interface SettingDef {
  /** Dotted key in the config file: "server.port" is the `port` key of the `server` block; a top-level key has no dot (D-01). */
  path: string;
  kind: "string" | "integer" | "enum" | "list" | "bool" | "path" | "jsonObject";
  /** A model option: decided per model in `buildLaunch` (the `model` block and the `models` entries), not once per start. */
  perModel?: boolean;
  /** A path row whose file is read at launch time; the file's text is the value that is emitted (D-23). */
  template?: boolean;
  /** The allowed values in words, used in every error and warning about this row. */
  expected: string;
  /** Strict check of a value read from a JSON file: no coercion (D-07). */
  check(value: unknown): CheckResult;
  /** The problem line for a value that failed `check`; `shown` is the value already cleaned and clipped. */
  problem(shown: string): string;
  /** Check of a value that arrives as text (environment, command line, pi flag); same range or enum as `check`. */
  parseText(raw: string): CheckResult;
  /** Environment variable that sets this row. */
  env?: string;
  /** An empty-but-defined environment variable is an invalid value, not an unset one. */
  blankEnvInvalid?: boolean;
  /** An invalid environment value refuses the command instead of being ignored: the next layer down is not what was asked for. */
  failClosedEnv?: boolean;
  /** The flag spelling `/mlx-start` accepts for this row, for example `--port`; a row without one cannot be set there. */
  cli?: string;
  /**
   * The flag spelling `/mlx-init` accepts for this row, for example `--mlx-lm-version`. Kept separate from `cli` on
   * purpose: `cliFlagSpecs()` derives the `/mlx-start` flags from `cli`, and the install settings must not become
   * `/mlx-start` flags.
   */
  initCli?: string;
  /** The pi flag that sets this row, without its dashes, for example `mlx-port`. */
  piFlag?: string;
  /** The project file never supplies this row's value; a valid project value is a project violation instead (D-01). */
  userLevelOnly?: boolean;
  /** The mlx_lm.server flag this row becomes. */
  mlxFlag?: string;
  /** The `/mlx-start` flag takes no value: writing it turns the setting on. */
  bare?: boolean;
  /** Host and port become the address and are never optional argv. */
  core?: boolean;
  /** The argv elements for a value; a valued flag is a single `--flag=value` element. */
  emit(value: SettingValue): string[];
  /** The value when no layer sets the row; a row without a default is emitted whenever a layer sets it. */
  default?: SettingValue;
}

const ok = (value: SettingValue): CheckResult => ({ ok: true, value });
const bad: CheckResult = { ok: false };

const HOST_PATTERN = /^[A-Za-z0-9.:_-]+$/;

/**
 * The host as the server takes it. A bracketed IPv6 address ("[::1]", the URL spelling) is stored without its
 * brackets, because Python cannot bind the bracketed form; `deriveBaseUrl` puts them back for URLs.
 */
function checkHost(value: unknown): CheckResult {
  if (typeof value !== "string" || value.length < 1 || value.length > 253) return bad;
  const bracketed = value.startsWith("[") && value.endsWith("]");
  const bare = bracketed ? value.slice(1, -1) : value;
  if (bracketed && !bare.includes(":")) return bad;
  if (bare.length < 1 || bare.startsWith("-") || !HOST_PATTERN.test(bare)) return bad;
  return ok(bare);
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

/** One allowed origin: not empty, and no comma (the list separator) or whitespace, so it stays one list entry. */
const isOrigin = (entry: unknown): entry is string => typeof entry === "string" && entry.length > 0 && !/[,\s]/.test(entry);

/** A list in a file; it becomes the comma list the server flag takes. */
function checkOrigins(value: unknown): CheckResult {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isOrigin)) return bad;
  return ok(value.join(","));
}

/** A comma list typed on the command line. */
function parseOrigins(raw: string): CheckResult {
  const entries = raw.trim().split(",");
  return entries.every(isOrigin) ? ok(entries.join(",")) : bad;
}

function checkBoolean(value: unknown): CheckResult {
  return typeof value === "boolean" ? ok(value) : bad;
}

const valued = (flag: string) => (value: SettingValue) => [`${flag}=${value}`];

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** The longest path or model id a setting may hold; real ones are far shorter. */
const MAX_TEXT_LENGTH = 4096;

/**
 * A model id or a file system path: not empty after trimming, one line, no control characters (a NUL would make the
 * spawn throw). A path is kept as written; `~` and relative paths are resolved when the launch is built.
 */
function checkOneLineText(value: unknown): CheckResult {
  if (typeof value !== "string") return bad;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_TEXT_LENGTH && !CONTROL_CHARACTER.test(trimmed) ? ok(trimmed) : bad;
}

/** A JSON number that is a safe integer of at least `min`: no text, no fraction, no coercion (D-07, D-17). */
const checkIntegerAtLeast =
  (min: number) =>
  (value: unknown): CheckResult =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min ? ok(value) : bad;

/** Text that is digits only (after trimming), then the same check as a value read from a file. */
const parseDigits =
  (check: (value: unknown) => CheckResult) =>
  (raw: string): CheckResult => {
    const trimmed = raw.trim();
    return /^\d+$/.test(trimmed) ? check(Number(trimmed)) : bad;
  };

/** A JSON number that is a safe integer from `min` to `max` inclusive: no text, no fraction, no coercion (D-11). */
const checkIntegerRange =
  (min: number, max: number) =>
  (value: unknown): CheckResult =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? ok(value) : bad;

/**
 * An exact version as pip knows it, release part first: two to four numbers, then optional pre, post and dev parts.
 * No epoch, no local part, no operator, no wildcard. Only text that matches this is ever placed after `mlx-lm==`.
 */
const PIN_TEXT = /^[0-9]+(\.[0-9]+){1,3}((a|b|rc)[0-9]+)?(\.post[0-9]+)?(\.dev[0-9]+)?$/;

/** The longest pin that is looked at; real versions are far shorter. */
const MAX_PIN_LENGTH = 32;

/**
 * The mlx-lm version policy: the word "latest" or an exact version, nothing else (D-06). Not trimmed, not
 * case-folded and never a pip specifier, so the value can only ever form the argv element `mlx-lm==VALUE` (T-03-08).
 */
function checkPin(value: unknown): CheckResult {
  if (typeof value !== "string" || value.length > MAX_PIN_LENGTH) return bad;
  return value === "latest" || PIN_TEXT.test(value) ? ok(value) : bad;
}

/** The longest package index URL that is looked at; real ones are far shorter. */
const MAX_PIP_INDEX_LENGTH = 4096;
/** Whitespace and control characters anywhere in the raw text: `new URL` would silently trim or encode them. */
const PIP_INDEX_FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f]/;
/** The canonical start of an index URL: the scheme and both slashes, exactly as pip's own parser reads them (WR-02). */
const PIP_INDEX_START = /^https?:\/\//i;
/** The authority part of a URL as written: between `scheme://` and the next `/`, `?` or `#`. */
const URL_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/;

/**
 * The package index pip installs from: an https URL, or plain http only for a loopback host, with no whitespace,
 * no control character, no credentials (use pip's netrc or keyring), no query string and no fragment, because
 * either can carry a token that would then show in the install line, the progress detail and failure texts (IN-02).
 * The value is kept as written, because pip takes it as written, and can only ever form the tail of the single argv
 * element `--index-url=VALUE` (T-03-14, T-03-15, T-03-17). The loopback decision uses the parsed host name, never a
 * string prefix, and only when the host is written the way WHATWG normalises it: `127.1`, `0x7f.1`, a decimal number
 * and `[0:0:0:0:0:0:0:1]` are refused, because pip does not necessarily read them as the host that was decided on
 * (T-03-26).
 */
function checkPipIndex(value: unknown): CheckResult {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PIP_INDEX_LENGTH) return bad;
  if (PIP_INDEX_FORBIDDEN.test(value)) return bad;
  // WHATWG and Python's urlsplit read a backslash, a missing slash and an escaped host differently; only the canonical
  // spelling is accepted, so the host that is checked is the host pip connects to.
  if (!PIP_INDEX_START.test(value) || value.includes("\\") || (URL_AUTHORITY.exec(value)?.[1] ?? "").includes("%")) return bad;
  // Looked for in the raw text: `url.search` and `url.hash` are empty for a bare `?` or `#`.
  if (value.includes("?") || value.includes("#")) return bad;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad;
  }
  if (url.hostname === "") return bad;
  // An '@' anywhere in the authority is credentials, or a look-alike such as https://pypi.org@evil.example/.
  if (url.username !== "" || url.password !== "" || (URL_AUTHORITY.exec(value)?.[1] ?? "").includes("@")) return bad;
  if (url.protocol === "https:") return ok(value);
  if (url.protocol !== "http:") return bad;
  // The host as written must be the host WHATWG derived: no decision depends on an https host's spelling, but this one does.
  const authority = URL_AUTHORITY.exec(value)?.[1] ?? "";
  const written = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.replace(/:[0-9]*$/, "");
  if (written.toLowerCase() !== url.hostname) return bad;
  return isLoopbackHost(url.hostname) ? ok(value) : bad;
}

const checkDraftTokens = checkIntegerAtLeast(1);
const checkKvBits = checkIntegerRange(2, 8);

/** The most the extension will place in one argv element for the template (T-02-21). */
const MAX_TEMPLATE_BYTES = 64 * 1024;
/** The most serialized text the template arguments may hold (T-02-21). */
const MAX_TEMPLATE_ARGS_BYTES = 16 * 1024;
/** Object levels allowed in the template arguments; deeper values are refused, so no walk can exhaust the stack. */
const MAX_ARGS_DEPTH = 32;

/** Keys that could reach `Object.prototype` if a value were ever assigned through them (T-02-20). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type Sanitized = { ok: true; value: JsonValue } | { ok: false; problem: (shown: string) => string };

/**
 * Copy a parsed JSON value into objects without a prototype, refusing everything that is not plain JSON: a
 * forbidden key at any depth, a value JSON cannot hold, or nesting beyond the limit. Keys are only read here
 * (`Object.keys`), and the copy is assigned into a prototype-less object, so a hostile key has no effect.
 */
function sanitizeJson(value: unknown, depth: number): Sanitized {
  if (depth > MAX_ARGS_DEPTH) return { ok: false, problem: PHRASES.tooDeep };
  if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false, problem: PHRASES.notJson };
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const copy = sanitizeJson(item, depth + 1);
      if (!copy.ok) return copy;
      items.push(copy.value);
    }
    return { ok: true, value: items };
  }
  if (typeof value !== "object") return { ok: false, problem: PHRASES.notJson };
  const result = Object.create(null) as SettingObject;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return { ok: false, problem: PHRASES.forbiddenKey(key) };
    const copy = sanitizeJson((value as Record<string, unknown>)[key], depth + 1);
    if (!copy.ok) return copy;
    result[key] = copy.value;
  }
  return { ok: true, value: result };
}

/** The chat template arguments as a JSON object, checked and copied; the serialized text is bounded. */
function checkTemplateArgs(value: unknown): CheckResult {
  if (!isPlainObject(value)) return bad;
  const copy = sanitizeJson(value, 0);
  if (!copy.ok) return { ok: false, problem: copy.problem };
  if (Buffer.byteLength(JSON.stringify(copy.value)) > MAX_TEMPLATE_ARGS_BYTES) return { ok: false, problem: PHRASES.argsTooLarge };
  return ok(copy.value as SettingObject);
}

/** The same value typed as text, in mlx-lm's own form: a JSON string of an object. */
function parseTemplateArgs(raw: string): CheckResult {
  const text = raw.trim();
  if (Buffer.byteLength(text) > MAX_TEMPLATE_ARGS_BYTES) return { ok: false, problem: PHRASES.argsTooLarge };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: PHRASES.jsonText };
  }
  return checkTemplateArgs(parsed);
}

const emitJson = (flag: string) => (value: SettingValue) => [`${flag}=${JSON.stringify(value)}`];

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
  path: (shown: string) => `${shown} must be a non-empty path`,
  jsonText: (shown: string) => `${shown} is not valid JSON; give a JSON object`,
  forbiddenKey: (key: string) => (shown: string) => `${shown} contains the key ${showKey(key)}, which is not allowed`,
  argsTooLarge: (shown: string) => `${shown} is larger than 16 KiB`,
  pin: (shown: string) => `${shown} must be "latest" or an exact version such as 0.32.2`,
  pipIndex: (shown: string) => `${shown} must be an https URL without credentials or spaces (http only for a loopback host)`,
  tooDeep: (shown: string) => `${shown} is nested too deeply`,
  notJson: (shown: string) => `${shown} contains a value that is not JSON`,
};

interface IntegerFlagOptions {
  /** The smallest allowed value; the default is 1. */
  min?: number;
  /** The allowed values in words; the default is "an integer of at least {min}". */
  expected?: string;
  /** The problem line; the default is `PHRASES.integerAtLeast(min)`. */
  problem?: (shown: string) => string;
}

/**
 * One `server.{key}` row that is a plain integer passed through as `--flag=N`. The row carries no default, no
 * environment variable and no pi flag (D-04), so a value equal to the server's own default is still emitted and
 * shown (D-17), and it is the same on the file layers and on `/mlx-start` (D-14). The checks are sanity bounds only.
 */
function integerFlagRow(key: string, flag: string, options: IntegerFlagOptions = {}): SettingDef {
  const min = options.min ?? 1;
  const check = checkIntegerAtLeast(min);
  return {
    path: `server.${key}`,
    kind: "integer",
    expected: options.expected ?? `an integer of at least ${min}`,
    check,
    problem: options.problem ?? PHRASES.integerAtLeast(min),
    parseText: parseDigits(check),
    cli: flag,
    mlxFlag: flag,
    emit: valued(flag),
  };
}

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
    cli: "--host",
    piFlag: "mlx-host",
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
    cli: "--port",
    piFlag: "mlx-port",
    mlxFlag: "--port",
    core: true,
    emit: valued("--port"),
    default: DEFAULT_PORT,
  },
  {
    path: "server.allowedOrigins",
    kind: "list",
    expected: "a list of non-empty strings without commas or spaces",
    check: checkOrigins,
    problem: PHRASES.list,
    parseText: parseOrigins,
    cli: "--allowed-origins",
    mlxFlag: "--allowed-origins",
    emit: valued("--allowed-origins"),
  },
  {
    path: "server.logLevel",
    kind: "enum",
    expected: `one of ${LOG_LEVELS.join(", ")}`,
    check: checkLogLevel,
    problem: PHRASES.oneOf(LOG_LEVELS),
    parseText: (raw) => checkLogLevel(raw.trim()),
    cli: "--log-level",
    piFlag: "mlx-log-level",
    mlxFlag: "--log-level",
    emit: valued("--log-level"),
  },
  {
    // Runs Python code from the model repository, so no environment variable or pi flag can set it and a
    // project file may never turn it on (D-08, D-16).
    path: "server.trustRemoteCode",
    kind: "bool",
    expected: "true or false",
    check: checkBoolean,
    problem: PHRASES.boolean,
    parseText: (raw) => (raw.trim() === "true" ? ok(true) : bad),
    cli: "--trust-remote-code",
    bare: true,
    mlxFlag: "--trust-remote-code",
    emit: (value) => (value === true ? ["--trust-remote-code"] : []),
    default: false,
  },
  integerFlagRow("decodeConcurrency", "--decode-concurrency"),
  integerFlagRow("promptConcurrency", "--prompt-concurrency"),
  integerFlagRow("prefillStepSize", "--prefill-step-size"),
  integerFlagRow("promptCacheSize", "--prompt-cache-size"),
  // A plain integer of bytes, as the flag takes it; size strings such as "8GB" stay deferred (D-16).
  integerFlagRow("promptCacheBytes", "--prompt-cache-bytes", {
    expected: "an integer number of bytes, at least 1 (for example 8589934592 for 8 GiB)",
    problem: (shown) => `${shown} is not an integer number of bytes of at least 1, for example 8589934592 for 8 GiB`,
  }),
  {
    // KV cache quantization. The range is the one locked in D-11; MLX itself rejects 7, and mlx-lm's own error
    // comes through if a value it cannot do is passed. Server-wide, not per model (D-13).
    path: "server.kvBits",
    kind: "integer",
    expected: "an integer from 2 to 8 (MLX itself does not support 7)",
    check: checkKvBits,
    problem: PHRASES.integerRange(2, 8),
    parseText: parseDigits(checkKvBits),
    cli: "--kv-bits",
    mlxFlag: "--kv-bits",
    emit: valued("--kv-bits"),
  },
  // The bounds below are sanity bounds only (D-17); the limits MLX enforces are in the wording.
  integerFlagRow("kvGroupSize", "--kv-group-size", { expected: "an integer of at least 1 (MLX supports 32, 64 and 128)" }),
  integerFlagRow("quantizedKvStart", "--quantized-kv-start", {
    min: 0,
    expected: "an integer of at least 0 (quantization starts after this many tokens)",
  }),
  {
    path: "model.adapterPath",
    kind: "path",
    perModel: true,
    expected: "a non-empty path",
    check: checkOneLineText,
    problem: PHRASES.path,
    parseText: (raw) => checkOneLineText(raw),
    cli: "--adapter-path",
    mlxFlag: "--adapter-path",
    emit: valued("--adapter-path"),
  },
  {
    path: "model.draftModel",
    kind: "string",
    perModel: true,
    expected: "a non-empty model id",
    check: checkOneLineText,
    problem: PHRASES.string,
    parseText: (raw) => checkOneLineText(raw),
    cli: "--draft-model",
    mlxFlag: "--draft-model",
    emit: valued("--draft-model"),
  },
  {
    path: "model.numDraftTokens",
    kind: "integer",
    perModel: true,
    expected: "an integer of at least 1",
    check: checkDraftTokens,
    problem: PHRASES.integerAtLeast(1),
    parseText: parseDigits(checkDraftTokens),
    cli: "--num-draft-tokens",
    mlxFlag: "--num-draft-tokens",
    emit: valued("--num-draft-tokens"),
  },
  {
    // The value is a path to a Jinja file; the launch reads the file and passes its text (D-23).
    path: "model.chatTemplate",
    kind: "path",
    perModel: true,
    template: true,
    expected: "a non-empty path to a template file",
    check: checkOneLineText,
    problem: PHRASES.path,
    parseText: (raw) => checkOneLineText(raw),
    cli: "--chat-template",
    mlxFlag: "--chat-template",
    emit: valued("--chat-template"),
  },
  {
    path: "model.useDefaultChatTemplate",
    kind: "bool",
    perModel: true,
    expected: "true or false",
    check: checkBoolean,
    problem: PHRASES.boolean,
    parseText: (raw) => (raw.trim() === "true" ? ok(true) : bad),
    cli: "--use-default-chat-template",
    bare: true,
    mlxFlag: "--use-default-chat-template",
    emit: (value) => (value === true ? ["--use-default-chat-template"] : []),
    default: false,
  },
  {
    // An object in a file; on the command line mlx-lm's own form, a JSON string (D-22).
    path: "model.chatTemplateArgs",
    kind: "jsonObject",
    perModel: true,
    expected: "a JSON object",
    check: checkTemplateArgs,
    problem: PHRASES.object,
    parseText: parseTemplateArgs,
    cli: "--chat-template-args",
    mlxFlag: "--chat-template-args",
    emit: emitJson("--chat-template-args"),
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
  {
    // Which mlx-lm /mlx-init installs. A project file may set it: a pin only chooses among the versions of the index
    // the user configured (D-03). It is not a server flag, so it never reaches argv or the flags line.
    path: "mlxLm.version",
    kind: "string",
    expected: 'the word "latest" or an exact version such as 0.32.2',
    check: checkPin,
    problem: PHRASES.pin,
    parseText: (raw) => checkPin(raw.trim()),
    env: "PI_MLX_MODELS_MLX_LM_VERSION",
    initCli: "--mlx-lm-version",
    emit: () => [],
  },
  {
    // Where /mlx-init installs from. Whoever chooses the index chooses which code gets installed, so a project file may
    // never set it (D-01): the project layer is skipped for this row and a project value is a project violation.
    path: "mlxLm.pipIndex",
    kind: "string",
    userLevelOnly: true,
    failClosedEnv: true,
    expected: "an https URL without credentials (http only for a loopback host)",
    check: checkPipIndex,
    problem: PHRASES.pipIndex,
    parseText: (raw) => checkPipIndex(raw.trim()),
    env: "PI_MLX_MODELS_PIP_INDEX",
    initCli: "--pip-index",
    emit: () => [],
  },
];

/** A pi flag: its name without dashes, what it does, and the setting it sets (none for `mlx-model`). */
export interface PiFlagDef {
  name: string;
  description: string;
  path?: string;
}

/**
 * The pi flags the extension registers. Each is a string flag with no default: pi would write a default
 * into its flag values at registration, which would then outrank the environment and the files.
 */
export const PI_FLAGS: readonly PiFlagDef[] = [
  { name: "mlx-model", description: "Model that a bare /mlx-start launches (preset number, preset key or model id); it never starts anything by itself" },
  { name: "mlx-port", description: "Port the MLX server listens on (1 to 65535)", path: "server.port" },
  { name: "mlx-host", description: "Host or address the MLX server listens on", path: "server.host" },
  { name: "mlx-log-level", description: "MLX server log level: DEBUG, INFO, WARNING, ERROR or CRITICAL", path: "server.logLevel" },
];

/** The flags `/mlx-start` accepts, derived from the rows that declare one; all take a value except the bare ones. */
export function cliFlagSpecs(): CliFlagSpec[] {
  return SETTINGS.flatMap((row) => (row.cli === undefined ? [] : [{ flag: row.cli, path: row.path, takesValue: row.bare !== true }]));
}

/** The flags `/mlx-init` accepts, derived from the rows that declare an `initCli`; all of them take a value. */
export function initFlagSpecs(): CliFlagSpec[] {
  return SETTINGS.flatMap((row) => (row.initCli === undefined ? [] : [{ flag: row.initCli, path: row.path, takesValue: true }]));
}

const ROWS_BY_PATH = new Map(SETTINGS.map((row) => [row.path, row]));
/** The top-level key whose entries override the model block for one preset key or model id (D-21). */
const MODELS_KEY = "models";
/** The block the entries of `models` are written in: an entry holds the keys of the `model` block. */
const MODEL_BLOCK = "model";
/** The block of the install rows: which mlx-lm /mlx-init installs and where from (D-04). */
const INSTALL_BLOCK = "mlxLm";
/** True for the install rows, so the extension-load resolution can leave them out (`PrepareInput.ignoreInstall`). */
const isInstallRow = (row: SettingDef): boolean => row.path.startsWith(`${INSTALL_BLOCK}.`);
/** The block names of nested keys, e.g. "server". */
const BLOCKS = new Set(SETTINGS.filter((row) => row.path.includes(".")).map((row) => row.path.split(".")[0]));

/** A key a user could have meant: its full dotted path, and the name it is written as at its own level. */
interface Candidate {
  path: string;
  name: string;
}

/** The keys valid at the top level of a file, in schema order: block names and top-level rows. */
const TOP_LEVEL: readonly Candidate[] = [...new Set([...SETTINGS.map((row) => row.path.split(".")[0]), MODELS_KEY])].map((name) => ({
  path: name,
  name,
}));

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

/**
 * The text that follows `unknown key` in a problem line: empty when nothing is close, else a space and a
 * parenthesised hint. `key` is what the user wrote and `block` the block it was written in (undefined at the
 * top level; `model` for a `models` entry). `container` names that place for the user: `"server"` for a block,
 * `a "models" entry` for an entry (GAP-01).
 *
 * A key written at the top level, or whose nearest key lives in the same block, gets the plain "did you mean".
 * Otherwise the nearest key lives elsewhere, and the hint says where, so that a suggestion never repeats the
 * name the user typed without saying the key leaves the place it was written in. A spelling that differs from
 * the real name only by case, `-` or `_` is the same key, and gets the plain statement with the real spelling.
 *
 * The output holds only schema-derived names and the fixed phrases below, plus the caller's `container`, which
 * is a fixed label; nothing from the file is added (T-02-27).
 */
function unknownKeyHint(key: string, block: string | undefined, container: string): string {
  const meant = suggestKey(key, block);
  if (meant === undefined) return "";
  const dot = meant.indexOf(".");
  if (block === undefined || (dot !== -1 && meant.slice(0, dot) === block)) return ` (did you mean ${meant}?)`;
  const name = meant.slice(dot + 1);
  const home = dot === -1 ? "a top-level key" : `a "${meant.slice(0, dot)}" key`;
  const where = `${home}, not part of ${container}`;
  return normalizeKey(key) === normalizeKey(name) ? ` (${name} is ${where})` : ` (did you mean ${meant}? It is ${where})`;
}

const FILE_LABEL = { global:"global config.json", project: "project .pi/pi-mlx-models.json" } as const;

/**
 * Text that came from a file, the environment or a flag, made safe and bounded before it is shown (D-24). The order
 * matters: the redaction sees the whole text, so the 60 character clip is last and cannot bring a secret back (WR-01).
 */
const show = (text: string): string => clipDiagnostic(redactCredentials(cleanLabel(text)), 60, "start");
const showValue = (value: unknown): string => {
  try {
    return show(JSON.stringify(value) ?? String(value));
  } catch {
    // A value nested too deeply to serialize, or one that cannot be: still reported, never thrown.
    return "(a value that cannot be shown)";
  }
};

/** The command a typed flag of this row belongs to: `/mlx-init` for an install setting, else `/mlx-start`. */
const commandOf = (row: SettingDef): string => (row.initCli === undefined ? "/mlx-start" : "/mlx-init");

/** The layer name as it appears in the flags line. */
function displayLabel(layer: LayerName, row: SettingDef): string {
  switch (layer) {
    case "global":
      return "global file";
    case "project":
      return "project file";
    case "args":
      return commandOf(row);
    case "piFlags":
      return `pi flag --${row.piFlag}`;
    case "env":
      return `env ${row.env}`;
  }
}

/** The layer as a problem line labels it. A command-line or pi flag label already names the flag. */
function problemLabel(layer: "args" | "piFlags", row: SettingDef): string {
  return layer === "args" ? `${commandOf(row)} ${row.initCli ?? row.cli}` : displayLabel(layer, row);
}

/** What names the value in a base URL warning. */
function sourceName(layer: LayerName, row: SettingDef): string {
  switch (layer) {
    case "global":
    case "project":
      return `${row.path} in ${FILE_LABEL[layer]}`;
    case "args":
      return String(row.cli ?? row.initCli);
    case "piFlags":
      return `--${row.piFlag}`;
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
  /**
   * Only the extension-load path may set this. The install rows (the `mlxLm` block) are not read from any layer, not
   * resolved and not checked, so a bad pip index or pin produces no problem and no warning and cannot hide the
   * provider URL and the default model. The result's `install` then holds the defaults and `sources` has no install
   * entry, so a caller that sets it must never install from the result.
   */
  ignoreInstall?: boolean;
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
  /** Where each setting that some layer set came from, by dotted path. Settings left at their default are absent. */
  sources: ReadonlyMap<string, { layer: LayerName; label: string }>;
  /** What the project file asked for that it may never ask for; decided on its own content before any merge (D-16). */
  projectViolations: ProjectViolation[];
  /** The validated model options of every layer, held until a model is chosen: `buildLaunch` is their second stage. */
  modelSettings: ModelSettings;
  /** What /mlx-init installs: the version policy and the package index, with the layer each came from (D-04, D-07). */
  install: InstallSettings;
}

/** The install policy of one resolved configuration. A source is a layer label, and absent when the value is the default. */
export interface InstallSettings {
  /** "latest" or an exact version. */
  version: string;
  pipIndex: string;
  versionSource?: string;
  pipIndexSource?: string;
}

/** One file's model options: the `model` block, and each `models` entry by its key or model id. */
interface ModelLayer {
  layer: "global" | "project";
  model: ReadonlyMap<string, SettingValue>;
  models: ReadonlyMap<string, ReadonlyMap<string, SettingValue>>;
}

/** The model options before a model is known: the file layers from lowest to highest precedence, and the typed flags. */
export interface ModelSettings {
  layers: readonly ModelLayer[];
  args: ReadonlyMap<string, SettingValue>;
}

/** One setting in the project file that enables running code or opening the network. */
export interface ProjectViolation {
  path: string;
  /** The offending value, cleaned and clipped; empty for a boolean. */
  shown: string;
  reason: string;
  /** Chooses where mlx-lm is installed from rather than what runs or listens; the refusal then words its header for it. */
  installOnly?: true;
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
function readFileLayer(file: LayerFile | undefined, layer: "global" | "project", problems: string[], ignoreInstall: boolean): FileLayerData {
  const data: FileLayerData = { values: new Map(), models: new Map() };
  const label = FILE_LABEL[layer];
  if (file === undefined || file.state === "absent") return data;
  if (file.state === "unusable") {
    problems.push(`${label}: ${clipDiagnostic(cleanLabel(file.reason), 200, "start")}`);
    return data;
  }
  const consider = (block: string | undefined, key: string, value: unknown) => {
    const path = block === undefined ? key : `${block}.${key}`;
    // A top-level key that happens to contain a dot is not the nested key it resembles.
    const row = block === undefined && key.includes(".") ? undefined : ROWS_BY_PATH.get(path);
    if (row === undefined) {
      problems.push(`${showKey(path)} (${label}): unknown key${unknownKeyHint(key, block, `"${block}"`)}`);
      return;
    }
    // An install row is not read at all when the caller leaves the install settings out; an unknown key was reported above.
    if (ignoreInstall && isInstallRow(row)) return;
    const result = row.check(value);
    if (result.ok) data.values.set(path, result.value);
    else problems.push(`${path} (${label}): ${(result.problem ?? row.problem)(showValue(value))}${flagSuffix(row)}`);
  };
  /** One `models` entry: the same keys and checks as the `model` block, with the entry's own path in every line. */
  const considerEntry = (id: string, entry: Map<string, SettingValue>, key: string, value: unknown) => {
    const where = `${entryPath(id)}.${showKey(key)}`;
    const row = key.includes(".") ? undefined : ROWS_BY_PATH.get(`${MODEL_BLOCK}.${key}`);
    if (row === undefined) {
      problems.push(`${where} (${label}): unknown key${unknownKeyHint(key, MODEL_BLOCK, `a "${MODELS_KEY}" entry`)}`);
      return;
    }
    const result = row.check(value);
    if (result.ok) entry.set(row.path, result.value);
    else problems.push(`${where} (${label}): ${(result.problem ?? row.problem)(showValue(value))}${flagSuffix(row)}`);
  };
  for (const [key, value] of Object.entries(file.data)) {
    if (key === MODELS_KEY) {
      if (!isPlainObject(value)) {
        problems.push(`${key} (${label}): ${PHRASES.object(showValue(value))}`);
        continue;
      }
      for (const [id, entryValue] of Object.entries(value)) {
        if (!isPlainObject(entryValue)) {
          problems.push(`${entryPath(id)} (${label}): ${PHRASES.object(showValue(entryValue))}`);
          continue;
        }
        const entry = new Map<string, SettingValue>();
        data.models.set(id, entry);
        for (const [child, childValue] of Object.entries(entryValue)) considerEntry(id, entry, child, childValue);
      }
    } else if (!BLOCKS.has(key)) {
      consider(undefined, key, value);
    } else if (!isPlainObject(value)) {
      problems.push(`${key} (${label}): ${PHRASES.object(showValue(value))}`);
    } else {
      for (const [child, childValue] of Object.entries(value)) consider(key, child, childValue);
    }
  }
  return data;
}

/** What one config file holds: the validated top-level and block values, and the validated `models` entries. */
interface FileLayerData {
  values: Map<string, SettingValue>;
  models: Map<string, Map<string, SettingValue>>;
}

/** The path of a `models` entry as an error line shows it: `models["id"]`, the id cleaned and at most 80 characters. */
const entryPath = (id: string): string => `${MODELS_KEY}[${JSON.stringify(showKey(id))}]`;

const isLoopbackUrl = (baseUrl: string): boolean => {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
};

/**
 * What the project file asks for that a cloned repository must never be able to ask for: running the model
 * repository's code, listening beyond this machine, or sending prompts elsewhere (D-16). It looks at the file's own
 * valid values, before any merge, so a higher layer that happens to override the value does not hide it.
 */
function projectViolationsOf(project: ReadonlyMap<string, SettingValue>): ProjectViolation[] {
  const violations: ProjectViolation[] = [];
  if (project.get("server.trustRemoteCode") === true) {
    violations.push({ path: "server.trustRemoteCode", shown: "", reason: "lets the model repository run Python code" });
  }
  const host = project.get("server.host");
  if (typeof host === "string" && !isLoopbackHost(host)) {
    violations.push({ path: "server.host", shown: show(host), reason: "listens on a non-loopback address" });
  }
  const baseUrl = project.get("baseUrl");
  if (typeof baseUrl === "string" && !isLoopbackUrl(baseUrl)) {
    violations.push({ path: "baseUrl", shown: show(baseUrl), reason: "sends prompts to a non-loopback address" });
  }
  const origins = project.get("server.allowedOrigins");
  // Held as the comma list the server flag takes; an empty list never gets this far.
  if (typeof origins === "string") {
    violations.push({ path: "server.allowedOrigins", shown: showValue(origins), reason: "lets web pages call the local server" });
  }
  // Whoever chooses the package index chooses which code /mlx-init installs (D-01). mlxLm.version is not listed (D-03).
  const pipIndex = project.get("mlxLm.pipIndex");
  if (typeof pipIndex === "string") {
    violations.push({ path: "mlxLm.pipIndex", shown: show(pipIndex), reason: "chooses where mlx-lm is installed from", installOnly: true });
  }
  return violations;
}

/**
 * Merge the layers into one launch preparation. Precedence is fixed (D-12): `/mlx-start` flags, pi flags,
 * environment, project file, global file, built-in default. A file that is unusable, has an unknown key or
 * a value failing its check refuses the start (errors). A bad environment value is dropped with a warning and
 * resolution continues with the next lower layer, except for a row marked `failClosedEnv` (the pip index): the
 * next layer down is not what the user asked for, so a bad value there refuses the command. The extension-load
 * caller may leave the install rows out altogether with `ignoreInstall`.
 */
export function prepareSettings(input: PrepareInput): PrepareResult {
  const warnings: string[] = [];
  const ignoreInstall = input.ignoreInstall === true;
  // Problems are collected per layer and reported highest precedence first. The environment only warns, except for a
  // fail-closed row (the pip index), whose bad environment value is a problem of the `env` layer and refuses.
  const problems: Record<LayerName, string[]> = { args: [], piFlags: [], env: [], project: [], global: [] };
  const files = {
    global: readFileLayer(input.global, "global", problems.global, ignoreInstall),
    project: readFileLayer(input.project, "project", problems.project, ignoreInstall),
  };
  const fileValues = { global: files.global.values, project: files.project.values };

  const resolved = new Map<string, { value: SettingValue; layer: LayerName }>();
  const candidate = (row: SettingDef, layer: LayerName): SettingValue | undefined => {
    switch (layer) {
      case "global":
      case "project":
        if (layer === "project" && row.userLevelOnly === true) return undefined;
        return fileValues[layer].get(row.path);
      case "env": {
        if (row.env === undefined) return undefined;
        const raw = input.env[row.env];
        if (raw === undefined) return undefined;
        if (!row.blankEnvInvalid && envText(raw) === undefined) return undefined;
        const result = row.parseText(raw);
        if (result.ok) return result.value;
        if (row.failClosedEnv === true) problems.env.push(`${row.env}=${showValue(raw)} is not ${row.expected}`);
        else warnings.push(`${row.env}=${showValue(raw)} is not ${row.expected}; ignoring it.`);
        return undefined;
      }
      case "args":
      case "piFlags": {
        // Only a row that declares a flag for this layer can be set by it; anything else is never looked at.
        let raw: string | true | undefined;
        if (layer === "args") raw = row.cli === undefined && row.initCli === undefined ? undefined : input.args?.[row.path];
        else raw = row.piFlag === undefined ? undefined : input.piFlags?.[row.piFlag];
        // A pi flag that was given no text is the same as one that was not given.
        if (raw === undefined || (raw !== true && layer === "piFlags" && raw.trim() === "")) return undefined;
        // The label already shows the flag, so the " (flag --x)" suffix of a file line is left off.
        const where = `${row.path} (${problemLabel(layer, row)})`;
        if (raw === true) {
          // A bare flag is its own value; any other flag written without one is an error.
          if (row.bare === true) return true;
          problems[layer].push(`${where}: needs a value (${row.expected})`);
          return undefined;
        }
        const result = row.parseText(raw);
        if (result.ok) return result.value;
        problems[layer].push(`${where}: ${(result.problem ?? row.problem)(showValue(raw))}`);
        return undefined;
      }
    }
  };
  for (const row of SETTINGS) {
    if (row.perModel === true) continue;
    // One skip before any layer is consulted: no environment line, no environment warning, no flag, no file value.
    if (ignoreInstall && isInstallRow(row)) continue;
    for (const layer of PRECEDENCE) {
      const value = candidate(row, layer);
      if (value !== undefined) {
        resolved.set(row.path, { value, layer });
        break;
      }
    }
  }
  // A model option is decided per model, in `buildLaunch`; only what was typed is read here, so that a bad flag is
  // reported in this one report with the others.
  const typedModel = new Map<string, SettingValue>();
  for (const row of SETTINGS) {
    if (row.perModel !== true) continue;
    const typed = candidate(row, "args");
    if (typed !== undefined) typedModel.set(row.path, typed);
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

  const sources = new Map<string, { layer: LayerName; label: string }>();
  for (const row of SETTINGS) {
    const hit = resolved.get(row.path);
    if (hit !== undefined) sources.set(row.path, { layer: hit.layer, label: displayLabel(hit.layer, row) });
  }

  return {
    ok: true,
    prepared: {
      address,
      baseUrl,
      defaultModel: String(value("defaultModel") ?? DEFAULT_MODEL_ID),
      flags,
      sources,
      projectViolations: projectViolationsOf(fileValues.project),
      install: {
        version: String(value("mlxLm.version") ?? "latest"),
        pipIndex: String(value("mlxLm.pipIndex") ?? DEFAULT_PIP_INDEX),
        ...(sources.has("mlxLm.version") ? { versionSource: sources.get("mlxLm.version")!.label } : {}),
        ...(sources.has("mlxLm.pipIndex") ? { pipIndexSource: sources.get("mlxLm.pipIndex")!.label } : {}),
      },
      modelSettings: {
        layers: (["global", "project"] as const).map((layer) => ({
          layer,
          model: new Map([...files[layer].values].filter(([path]) => ROWS_BY_PATH.get(path)?.perModel === true)),
          models: files[layer].models,
        })),
        args: typedModel,
      },
    },
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

/** Where `~` and relative paths of the model options resolve: the home directory and the project directory (ctx.cwd). */
export interface LaunchContext {
  home: string;
  cwd: string;
}

const isSettingObject = (value: unknown): value is SettingObject => isPlainObject(value);

/**
 * Two objects merged key by key, recursing into objects and replacing arrays and scalars (D-12). The result is
 * a new prototype-less object and neither input is changed (T-02-20).
 */
function mergeObjects(base: SettingObject, over: SettingObject): SettingObject {
  const merged = Object.create(null) as SettingObject;
  for (const [key, value] of Object.entries(base)) merged[key] = value;
  for (const [key, value] of Object.entries(over)) {
    const previous = merged[key];
    merged[key] = isSettingObject(previous) && isSettingObject(value) ? mergeObjects(previous, value) : value;
  }
  return merged;
}

/** A path as the user wrote it, made absolute: `~` is the home directory, anything relative is under the project directory. */
function resolveUserPath(text: string, context: LaunchContext): string {
  if (text === "~") return context.home;
  if (text.startsWith("~/")) return join(context.home, text.slice(2));
  return isAbsolute(text) ? text : resolvePath(context.cwd, text);
}

/** True when `target` is `directory` itself or lies under it, after following symlinks in the part of the path that exists. */
function isInsideDirectory(directory: string, target: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      const parent = dirname(path);
      return parent === path ? path : join(real(parent), basename(path));
    }
  };
  const from = relative(real(directory), real(target));
  return from === "" || (!from.startsWith("..") && !isAbsolute(from));
}

type TemplateText = { ok: true; text: string } | { ok: false; reason: string };

/** Read a chat template: a regular file of at most 64 KiB holding non-empty UTF-8 text. Never throws (T-02-19, T-02-21). */
function readTemplateFile(path: string): TemplateText {
  let bytes: Buffer;
  try {
    const info = statSync(path);
    if (!info.isFile()) return { ok: false, reason: "is not a regular file" };
    if (info.size > MAX_TEMPLATE_BYTES) return { ok: false, reason: "is larger than 64 KiB" };
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: `cannot be read (${typeof code === "string" ? reasonText(code, 40) : "unknown error"})` };
  }
  // The file may have grown between the stat and the read.
  if (bytes.length > MAX_TEMPLATE_BYTES) return { ok: false, reason: "is larger than 64 KiB" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "is not valid UTF-8 text" };
  }
  if (text.trim() === "") return { ok: false, reason: "is empty" };
  // A NUL cannot be part of a process argument.
  if (text.includes("\u0000")) return { ok: false, reason: "is not text (contains a NUL character)" };
  return { ok: true, text };
}

/** The layer as a problem line about a model option labels it: a file, or the flag typed on `/mlx-start`. */
const layerLabel = (layer: LayerName, row: SettingDef): string =>
  layer === "global" || layer === "project" ? FILE_LABEL[layer] : problemLabel("args", row);

/**
 * The second stage: pair the prepared settings with the model being started. The model options of each file layer
 * are overlaid by `models[preset key]` and then `models[model id]`, the layers are applied from the lowest
 * precedence up (so a project `model` block beats a global `models` entry), and what was typed on `/mlx-start`
 * comes last. Paths are resolved, the chat template file is read, and the flags come out in schema order.
 */
export function buildLaunch(prepared: Prepared, model: { modelId: string; presetKey?: string }, where: LaunchContext): BuildResult {
  const folded = new Map<string, { value: SettingValue; layer: LayerName }>();
  const apply = (values: ReadonlyMap<string, SettingValue> | undefined, layer: LayerName) => {
    if (values === undefined) return;
    for (const [path, value] of values) {
      const previous = folded.get(path)?.value;
      folded.set(path, { value: isSettingObject(previous) && isSettingObject(value) ? mergeObjects(previous, value) : value, layer });
    }
  };
  for (const data of prepared.modelSettings.layers) {
    apply(data.model, data.layer);
    if (model.presetKey !== undefined) apply(data.models.get(model.presetKey), data.layer);
    apply(data.models.get(model.modelId), data.layer);
  }
  apply(prepared.modelSettings.args, "args");

  const errors: string[] = [];
  const modelFlags: LaunchFlag[] = [];
  for (const row of SETTINGS) {
    const hit = folded.get(row.path);
    if (row.perModel !== true || row.mlxFlag === undefined || hit === undefined || hit.value === row.default) continue;
    let value = hit.value;
    let display: string;
    if (row.kind === "path") {
      const resolved = resolveUserPath(String(value), where);
      display = clipDiagnostic(cleanLabel(resolved), 200, "start");
      // A cloned repository must not make the extension read a file elsewhere on the machine into the server's argv.
      if (row.template === true && hit.layer === "project" && !isInsideDirectory(where.cwd, resolved)) {
        errors.push(`${row.path} (${layerLabel(hit.layer, row)}): ${display} is outside the project directory`);
        continue;
      }
      if (row.template === true) {
        const read = readTemplateFile(resolved);
        if (!read.ok) {
          errors.push(`${row.path} (${layerLabel(hit.layer, row)}): cannot read ${display}: ${read.reason}`);
          continue;
        }
        value = read.text;
      } else {
        value = resolved;
      }
    } else if (isSettingObject(value)) {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > MAX_TEMPLATE_ARGS_BYTES) {
        errors.push(`${row.path} (${layerLabel(hit.layer, row)}): the merged value is larger than 16 KiB`);
        continue;
      }
      display = show(text);
    } else {
      display = typeof value === "boolean" ? "" : show(String(value));
    }
    modelFlags.push({ path: row.path, flag: row.mlxFlag, args: row.emit(value), display, label: displayLabel(hit.layer, row), core: false });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    launch: { model, address: prepared.address, baseUrl: prepared.baseUrl, flags: [...prepared.flags, ...modelFlags] },
  };
}

/**
 * What the server host needs: the address, the URL, and the optional flags in schema order. Flags the installed
 * mlx-lm cannot do (`skipped`, by flag name) are left out (D-19); host and port are never skipped.
 */
export function toLaunchSpec(launch: ResolvedLaunch, skipped?: ReadonlySet<string>): LaunchSpec {
  return {
    address: launch.address,
    baseUrl: launch.baseUrl,
    extraArgs: launch.flags.filter((flag) => !flag.core && !skipped?.has(flag.flag)).flatMap((flag) => flag.args),
  };
}

/**
 * The "flags: ..." line of the start message, or "" when no flag differs from its default (D-11). A flag in `skipped`
 * is still listed, marked ", skipped" inside its parentheses, so the line shows what was configured and what ran.
 */
export function describeFlags(launch: ResolvedLaunch, skipped?: ReadonlySet<string>): string {
  if (launch.flags.length === 0) return "";
  const parts = launch.flags.map(
    (flag) => `${flag.flag}${flag.display ? ` ${flag.display}` : ""} (${flag.label}${!flag.core && skipped?.has(flag.flag) ? ", skipped" : ""})`,
  );
  return `flags: ${parts.join(", ")}`;
}

/** What a launch with KV cache quantization has to tell the user (D-09, D-10, D-12). */
export interface KvNotices {
  /** Shown at level warning on every launch that quantizes. */
  warning?: string;
  /** Shown at level info when a KV key is set without kvBits. */
  info?: string;
}

/** `--flag value`, `--flag value and --flag value`: the flags of a notice with their cleaned values. */
const flagList = (flags: readonly LaunchFlag[]): string => flags.map((flag) => `${flag.flag} ${flag.display}`).join(" and ");

/**
 * "{list} has no effect {tail}", or "have" for two. The values are the `display` of validated safe integers; no
 * argv element is parsed again.
 */
const noEffect = (flags: readonly LaunchFlag[], tail: string): string =>
  `${flagList(flags)} ${flags.length === 1 ? "has" : "have"} no effect ${tail}`;

/** The flags of `paths` that the launch sets and the install can do, in launch (schema) order. */
const setFlags = (launch: ResolvedLaunch, skipped: ReadonlySet<string> | undefined, paths: readonly string[]): LaunchFlag[] =>
  launch.flags.filter((flag) => paths.includes(flag.path) && !skipped?.has(flag.flag));

/**
 * The words after the batching sentence when a concurrency setting above 1 is also set. Nothing is dropped from the
 * launch (D-10); the user is only told those settings do nothing while kvBits is set.
 */
function concurrencyClause(launch: ResolvedLaunch, skipped: ReadonlySet<string> | undefined): string {
  const above = setFlags(launch, skipped, ["server.decodeConcurrency", "server.promptConcurrency"]).filter(
    (flag) => /^\d+$/.test(flag.display) && Number(flag.display) > 1,
  );
  return above.length === 0 ? "" : noEffect(above, "while --kv-bits is set.");
}

/**
 * The notices for the KV cache settings of a resolved launch. A flag the install does not list (`skipped`) does not
 * count as set: the skip notice already covers it (D-09). The text is schema-derived plus the cleaned `display` and
 * `label` of validated flags (T-03-04), and no state is kept, so every launch gets its own notices.
 */
export function kvNotices(launch: ResolvedLaunch, skipped?: ReadonlySet<string>): KvNotices {
  const bits = launch.flags.find((flag) => flag.path === "server.kvBits");
  if (bits !== undefined) {
    if (skipped?.has(bits.flag)) return {};
    const clause = concurrencyClause(launch, skipped);
    return {
      warning: `KV quantization (${bits.flag} ${bits.display}, ${bits.label}): Disables batching, so requests are served one at a time.${clause ? ` ${clause}` : ""}`,
    };
  }
  const idle = setFlags(launch, skipped, ["server.kvGroupSize", "server.quantizedKvStart"]);
  return idle.length === 0 ? {} : { info: noEffect(idle, "without --kv-bits.") };
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

/** A setting that needs the user's confirmation on every start because it runs code or opens the network (D-13). */
export interface TrustRisk {
  kind: "trustRemoteCode" | "host" | "baseUrl";
  /** The short phrase used in the refusal and cancel notices. */
  phrase: string;
  title: string;
  message: string;
}

/** Text for a confirmation dialog: cleaned, and long enough that clipping cannot hide where a URL really points. */
const showInDialog = (text: string): string => clipDiagnostic(cleanLabel(text), 300, "start");

/**
 * The line /mlx-init shows before it installs: the version policy and the index, each with the layer it came from or
 * "default". The index is cleaned and clipped long enough that clipping cannot hide where a look-alike URL points.
 */
export function describeInstall(install: InstallSettings): string {
  return `mlx-lm ${install.version} (${install.versionSource ?? "default"}) from ${showInDialog(install.pipIndex)} (${install.pipIndexSource ?? "default"})`;
}

/** The leading release number of a version text (digits and dots) and what follows it, lower-cased. */
function splitVersion(text: string): { release: string[]; suffix: string } | undefined {
  const lower = text.trim().toLowerCase();
  const match = /^[0-9]+(?:\.[0-9]+)*/.exec(lower);
  if (match === null) return undefined;
  const release = match[0].split(".");
  // PEP 440 pads the release with zeros: 0.32 and 0.32.0 are the same version. At least the first part stays.
  while (release.length > 1 && /^0+$/.test(release[release.length - 1])) release.pop();
  return { release: release.map((part) => String(Number(part))), suffix: lower.slice(match[0].length) };
}

/**
 * Whether two version texts name the same release: equal after the trailing `.0` parts of the release number are
 * dropped, with whatever follows it (`rc1`, `.post1`, `.dev1`) compared exactly. Not a full PEP 440 parser (D-08).
 */
export function sameVersion(a: string, b: string): boolean {
  const left = splitVersion(a);
  const right = splitVersion(b);
  if (left === undefined || right === undefined) return a.trim().toLowerCase() === b.trim().toLowerCase();
  return left.release.join(".") === right.release.join(".") && left.suffix === right.suffix;
}

/**
 * The one warning /mlx-start shows when an exact pin is configured and the installed mlx-lm is another version (D-07).
 * Undefined when the policy floats or the two are the same release. Every part is cleaned and clipped.
 */
export function pinNotice(install: InstallSettings, installed: string): string | undefined {
  if (install.version === "latest" || sameVersion(install.version, installed)) return undefined;
  const source = install.versionSource === undefined ? "" : ` (${show(install.versionSource)})`;
  return `mlx-lm pinned ${show(install.version)}${source}, installed ${show(installed)}; run /mlx-init to apply`;
}

/**
 * The one warning /mlx-start shows when an exact pin is configured and the installed version could not be read, so
 * the pin was not compared (D-07). Undefined when the policy floats. Every part is cleaned and clipped again, so a
 * test double or a future caller cannot put a raw reason on screen.
 */
export function pinUnreadableNotice(install: InstallSettings, reason: string): string | undefined {
  if (install.version === "latest") return undefined;
  const source = install.versionSource === undefined ? "" : ` (${show(install.versionSource)})`;
  return `mlx-lm pinned ${show(install.version)}${source} was not compared with the installed version: ${show(reason)}`;
}

/**
 * The risks in the effective merged values whose layer is not the project file (that one is refused by
 * `projectViolations` before this is asked), in the order trustRemoteCode, host, baseUrl. An empty list means
 * the launch needs no confirmation (D-13, D-14, D-17).
 */
export function trustRisks(prepared: Prepared): TrustRisk[] {
  const risks: TrustRisk[] = [];
  const outsideProject = (path: string) => {
    const source = prepared.sources.get(path);
    return source !== undefined && source.layer !== "project" ? source : undefined;
  };

  const trust = outsideProject("server.trustRemoteCode");
  if (trust !== undefined && prepared.flags.some((flag) => flag.path === "server.trustRemoteCode")) {
    risks.push({
      kind: "trustRemoteCode",
      phrase: "--trust-remote-code",
      title: "Allow remote code from the model repository?",
      message: `--trust-remote-code (from ${trust.label}) lets the model repository run Python code on this machine. Only continue for repositories you trust.`,
    });
  }

  const host = outsideProject("server.host");
  if (host !== undefined && !isLoopbackHost(prepared.address.host)) {
    const shown = showInDialog(prepared.address.host);
    const listen = shown.includes(":") && !shown.startsWith("[") ? `[${shown}]` : shown;
    risks.push({
      kind: "host",
      phrase: `listening on ${shown}`,
      title: "Listen on a non-loopback address?",
      message: `The MLX server will listen on ${listen}:${prepared.address.port} (from ${host.label}), reachable from your network. mlx_lm.server has no authentication.`,
    });
  }

  const baseUrl = outsideProject("baseUrl");
  if (baseUrl !== undefined && !isLoopbackUrl(prepared.baseUrl)) {
    const shown = showInDialog(prepared.baseUrl);
    risks.push({
      kind: "baseUrl",
      phrase: `sending prompts to ${shown}`,
      title: "Send prompts to a non-loopback address?",
      message: `pi will send your conversation to ${shown} (from ${baseUrl.label}), which is not on this machine.`,
    });
  }
  return risks;
}

/** The text that refuses a project file asking for a risky setting, without the "mlx-start failed: " prefix. */
export function formatProjectRefusal(violations: readonly ProjectViolation[], globalConfigPath: string): string {
  const withInstall = violations.some((violation) => violation.installOnly === true);
  const header = withInstall
    ? ".pi/pi-mlx-models.json cannot set options that run code, open the network or choose where mlx-lm is installed from:"
    : ".pi/pi-mlx-models.json cannot enable settings that run code or open the network:";
  const footer = withInstall
    ? `Move them to ${cleanLabel(globalConfigPath)}. Settings that run code or open the network then ask for confirmation at every start; the pip index applies without asking.`
    : `Move them to ${cleanLabel(globalConfigPath)}; starting then asks for confirmation.`;
  return [
    header,
    ...violations.map(
      (violation) => `  ${show(violation.path)}${violation.shown === "" ? "" : ` (${show(violation.shown)})`}: ${show(violation.reason)}`,
    ),
    footer,
  ].join("\n");
}

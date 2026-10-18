/**
 * What pi is told about a model: its context window, output limit, reasoning flag and input kinds, and where each value
 * came from (MOD-01). The context window is read from the model's own `config.json`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { HF_HOME } from "./config.js";
import { cleanLabel, clipDiagnostic, redactCredentials } from "./diagnostic.js";

/** The context window registered for a model whose `config.json` cannot be read or holds no usable value (D-03). */
export const FALLBACK_CONTEXT_WINDOW = 32768;

/** The largest `config.json` that is read; a real one is a few KiB, a quantized one a few hundred (T-05-06). */
export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export type InputKind = "text" | "image";

/** The outcome of looking for a model's `config.json`: the parsed object and where it came from, or why there is none. */
export type ModelConfigRead = { ok: true; config: unknown; source: "cache" | "hub" | "path" } | { ok: false; reason: string };

export interface ReadModelConfigOptions {
  /** Whether the Hugging Face Hub may be asked when the cache has no copy. */
  hub: boolean;
}

/** Looks up a model's `config.json`. Never throws and never rejects. */
export type ReadModelConfig = (modelId: string, options: ReadModelConfigOptions) => Promise<ModelConfigRead>;

export interface ModelConfigReaderOptions {
  /** The Hugging Face hub cache directory; default is derived from the environment. */
  cacheRoot?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  hubTimeoutMs?: number;
  hubBaseUrl?: string;
  /** What a `./` or `../` model path is resolved against; default is the process's working directory. */
  cwd?: string;
}

export interface ModelInfo {
  contextWindow: number;
  contextSource: string;
  maxTokens: number;
  maxTokensSource: string;
  reasoning: boolean;
  reasoningSource: string;
  input: InputKind[];
  inputSource: string;
  /** Why the context window is the fallback, when it is. */
  fallbackReason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `holder.max_position_embeddings` when it is an own property holding a positive safe integer. */
const windowOf = (holder: unknown): number | undefined => {
  if (!isRecord(holder) || !Object.hasOwn(holder, "max_position_embeddings")) return undefined;
  const value = holder.max_position_embeddings;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/**
 * The context window a `config.json` declares (D-01): `text_config.max_position_embeddings` when that is a positive safe
 * integer (multimodal models such as gemma-4 and KAT-Coder keep it there and have no top-level value), else the top-level
 * `max_position_embeddings`, else nothing. Only two named own properties are read, so a `__proto__` key or an inherited
 * value changes nothing (T-05-06).
 */
export function contextWindowOf(config: unknown): number | undefined {
  if (!isRecord(config)) return undefined;
  const nested = Object.hasOwn(config, "text_config") ? windowOf(config.text_config) : undefined;
  return nested ?? windowOf(config);
}

/**
 * A Hugging Face repository id: one name, or `org/name`, of letters, digits, `.`, `_` and `-`, the first character
 * alphanumeric. It is checked before an id is joined into any path (T-05-04): no `..` segment, no extra slash, no NUL.
 */
export const isHfRepoId = (id: string): boolean =>
  id.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(id);

/**
 * The Hugging Face hub cache directory the server writes to: `HF_HUB_CACHE` when it is set and not blank, else the hub
 * folder under the `HF_HOME` the extension launches the server with, never the user's default `~/.cache/huggingface` (D-02).
 */
export function resolveCacheRoot(env: Record<string, string | undefined>, hfHome: string = HF_HOME): string {
  const hubCache = env.HF_HUB_CACHE?.trim();
  return hubCache ? hubCache : join(hfHome, "hub");
}

const NOT_AN_ID = "not a Hugging Face repository id or an absolute path";
const NOT_IN_CACHE = "not in the Hugging Face cache";
const NO_CONFIG_IN_DIRECTORY = "no config.json in that directory";
const NOT_A_FILE = "config.json is not a regular file";
const TOO_LARGE = "config.json is larger than 2 MiB";
const NOT_JSON = "config.json is not valid JSON";
const NOT_AN_OBJECT = "config.json is not a JSON object";
const UNREADABLE = "config.json could not be read";

/** What looking at one `config.json` path found: nothing there, a file that is refused, or its text. */
type FileOutcome = { kind: "missing" } | { kind: "refused"; reason: string } | { kind: "text"; text: string };

/**
 * Read `file` only when it is a regular file of at most `MAX_CONFIG_BYTES` (T-05-06). `statSync` follows a symlink, so the
 * snapshot files of the Hugging Face cache, which are links into `blobs/`, are checked as the files they point to. The size
 * is checked again on the bytes read, in case the file grew after the first check.
 */
function readConfigFile(file: string): FileOutcome {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { kind: "missing" };
  }
  if (!stat.isFile()) return { kind: "refused", reason: NOT_A_FILE };
  if (stat.size > MAX_CONFIG_BYTES) return { kind: "refused", reason: TOO_LARGE };
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return { kind: "refused", reason: UNREADABLE };
  }
  if (bytes.length > MAX_CONFIG_BYTES) return { kind: "refused", reason: TOO_LARGE };
  return { kind: "text", text: bytes.toString("utf8") };
}

/** The outcome of one file as a `ModelConfigRead`; `missingReason` says what a missing file means for this lookup. */
function toRead(outcome: FileOutcome, source: "cache" | "path", missingReason: string): ModelConfigRead {
  if (outcome.kind === "missing") return { ok: false, reason: missingReason };
  if (outcome.kind === "refused") return { ok: false, reason: outcome.reason };
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.text);
  } catch {
    return { ok: false, reason: NOT_JSON };
  }
  return isRecord(parsed) ? { ok: true, config: parsed, source } : { ok: false, reason: NOT_AN_OBJECT };
}

/** The revision `refs/main` names: 40 hexadecimal characters in a small regular file, else nothing. */
function mainRevision(entry: string): string | undefined {
  const file = join(entry, "refs", "main");
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 256) return undefined;
    const text = readFileSync(file, "utf8").trim();
    return /^[0-9a-f]{40}$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The snapshot with the newest modification time among those that hold a `config.json`, or nothing. */
function newestSnapshot(entry: string): string | undefined {
  const snapshots = join(entry, "snapshots");
  let names: string[];
  try {
    names = readdirSync(snapshots);
  } catch {
    return undefined;
  }
  const held: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    try {
      statSync(join(snapshots, name, "config.json"));
      held.push({ name, mtimeMs: statSync(join(snapshots, name)).mtimeMs });
    } catch {
      // A snapshot without a config.json, or one that cannot be read, is skipped.
    }
  }
  held.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  return held[0]?.name;
}

/**
 * The cached `config.json` of a repository id that already passed `isHfRepoId`: the snapshot `refs/main` names, else the
 * newest snapshot that holds one (D-02). A snapshot is chosen by name from a directory listing only, never from file text.
 */
function readFromCache(cacheRoot: string, modelId: string): ModelConfigRead {
  const entry = join(cacheRoot, `models--${modelId.replace("/", "--")}`);
  const revision = mainRevision(entry);
  if (revision !== undefined) {
    const named = readConfigFile(join(entry, "snapshots", revision, "config.json"));
    if (named.kind !== "missing") return toRead(named, "cache", NOT_IN_CACHE);
  }
  const newest = newestSnapshot(entry);
  if (newest === undefined) return { ok: false, reason: NOT_IN_CACHE };
  return toRead(readConfigFile(join(entry, "snapshots", newest, "config.json")), "cache", NOT_IN_CACHE);
}

/** An id that is an absolute path, or starts with `./` or `../`, names a local model directory. */
const isLocalPath = (id: string): boolean => isAbsolute(id) || id.startsWith("./") || id.startsWith("../");

/**
 * Create the reader of a model's `config.json`: a local model directory (an absolute path, or `./` and `../` against the
 * reader's working directory), or the Hugging Face cache snapshot of a repository id. Any other id is refused before a
 * path is built (T-05-04). It never throws: every outcome is a `ModelConfigRead`, and a reason never holds a path, a token
 * or file text (T-05-05).
 */
export function createModelConfigReader(options: ModelConfigReaderOptions = {}): ReadModelConfig {
  const cacheRoot = options.cacheRoot ?? resolveCacheRoot(options.env ?? process.env);
  return async (modelId) => {
    try {
      if (isLocalPath(modelId)) {
        const directory = resolve(options.cwd ?? process.cwd(), modelId);
        return toRead(readConfigFile(join(directory, "config.json")), "path", NO_CONFIG_IN_DIRECTORY);
      }
      if (!isHfRepoId(modelId)) return { ok: false, reason: NOT_AN_ID };
      return readFromCache(cacheRoot, modelId);
    } catch {
      return { ok: false, reason: UNREADABLE };
    }
  };
}

/**
 * The output limit pi is told when nothing else sets it (D-07): a quarter of the window, at most 8192 for a model that
 * does not reason and 32768 for one that does, and at least 1.
 */
export function defaultMaxTokens(contextWindow: number, reasoning: boolean): number {
  return Math.max(1, Math.min(reasoning ? 32768 : 8192, Math.floor(contextWindow / 4)));
}

/**
 * Everything pi is told about one model, and where each value came from. Pure: the same read always gives the same
 * record. Reasoning and input are the defaults here; later plans detect them and let the profile override them.
 */
export function deriveModelInfo(input: { id: string; config?: ModelConfigRead }): ModelInfo {
  const { config } = input;
  const declared = config?.ok ? contextWindowOf(config.config) : undefined;
  const contextWindow = declared ?? FALLBACK_CONTEXT_WINDOW;
  const reasoning = false;
  const info: ModelInfo = {
    contextWindow,
    contextSource: declared === undefined ? "fallback" : "config.json",
    maxTokens: defaultMaxTokens(contextWindow, reasoning),
    maxTokensSource: "default",
    reasoning,
    reasoningSource: "default",
    input: ["text"],
    inputSource: "default",
  };
  if (declared === undefined) {
    info.fallbackReason =
      config === undefined
        ? "config.json was not read"
        : config.ok
          ? "config.json has no usable max_position_embeddings"
          : config.reason;
  }
  return info;
}

/** A source text as shown: single-line and free of control characters, with credentials hidden, clipped to 80 characters. */
const shownSource = (text: string): string => clipDiagnostic(redactCredentials(cleanLabel(text)), 80, "start");

/**
 * The one line that tells the user what pi was told about the model and where each value came from (D-03, D-07). The
 * numbers and flags are ours; the source texts are cleaned, then redacted, then clipped, in that order.
 */
export function describeModel(info: ModelInfo): string {
  return (
    `model: context ${info.contextWindow} (${shownSource(info.contextSource)}), ` +
    `max output ${info.maxTokens} (${shownSource(info.maxTokensSource)}), ` +
    `reasoning ${info.reasoning ? "yes" : "no"} (${shownSource(info.reasoningSource)}), ` +
    `input ${info.input.join(" and ")} (${shownSource(info.inputSource)})`
  );
}

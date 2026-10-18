/**
 * What pi is told about a model: its context window, output limit, reasoning flag and input kinds, and where each value
 * came from (MOD-01). The context window is read from the model's own `config.json`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { HF_HOME } from "./config.js";
import { cleanLabel, clipDiagnostic, redactCredentials } from "./diagnostic.js";
import { MODEL_PRESETS } from "./presets.js";

/** The context window registered for a model whose `config.json` cannot be read or holds no usable value (D-03). */
export const FALLBACK_CONTEXT_WINDOW = 32768;

/** The largest `config.json` that is read; a real one is a few KiB, a quantized one a few hundred (T-05-06). */
export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

/** The longest the Hugging Face Hub is given to answer, request and body together (A1, T-05-09). */
export const HUB_TIMEOUT_MS = 3000;

const DEFAULT_HUB_URL = "https://huggingface.co";

/**
 * The base URL the Hub is asked at: `HF_ENDPOINT` when it is a plain https URL (no credentials, query or fragment) with its
 * trailing slashes removed, else the Hub itself (A3, T-05-11).
 */
export function hubBaseUrlOf(env: Record<string, string | undefined>): string {
  const raw = env.HF_ENDPOINT?.trim();
  if (!raw || raw.includes("?") || raw.includes("#")) return DEFAULT_HUB_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DEFAULT_HUB_URL;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return DEFAULT_HUB_URL;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

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

/** A value a profile sets for a model, and the label of where it came from (`profile NAME`). */
export interface LimitValue<T> {
  value: T;
  label: string;
}

/** What a profile's `limits` object tells pi about a model (D-10); each entry is present only when the profile sets it. */
export interface LaunchLimits {
  contextWindow?: LimitValue<number>;
  maxTokens?: LimitValue<number>;
  reasoning?: LimitValue<boolean>;
  input?: LimitValue<InputKind[]>;
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

/** The text of a `config.json` from `source` as a `ModelConfigRead`: a JSON object, or the reason it is not one. */
function parseConfig(text: string, source: "cache" | "hub" | "path"): ModelConfigRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: NOT_JSON };
  }
  return isRecord(parsed) ? { ok: true, config: parsed, source } : { ok: false, reason: NOT_AN_OBJECT };
}

/** The outcome of one file as a `ModelConfigRead`; `missingReason` says what a missing file means for this lookup. */
function toRead(outcome: FileOutcome, source: "cache" | "path", missingReason: string): ModelConfigRead {
  if (outcome.kind === "missing") return { ok: false, reason: missingReason };
  if (outcome.kind === "refused") return { ok: false, reason: outcome.reason };
  return parseConfig(outcome.text, source);
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

/** Every Hub failure is this prefix and a constant phrase, so a reason never holds a token, a URL or a thrown message. */
const HUB_MISS_PREFIX = "not in the local cache; ";
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const OFFLINE_VALUES = new Set(["1", "on", "yes", "true"]);

const hubMiss = (phrase: string): ModelConfigRead => ({ ok: false, reason: `${HUB_MISS_PREFIX}${phrase}` });

/** The failure phrase of a response status that is neither a success nor a redirect. */
function statusPhrase(status: number): string {
  if (status === 401 || status === 403) {
    return `the Hugging Face Hub answered HTTP ${status}: the repository is gated, private or missing (set HF_TOKEN for a gated model)`;
  }
  if (status === 404) return `the model was not found on the Hugging Face Hub (HTTP 404)`;
  return `the Hugging Face Hub answered HTTP ${status}`;
}

/** The URL a redirect leads to, or nothing when it is refused: it must be http or https, and https may not drop to http. */
function redirectTarget(from: URL, location: string | null): URL | undefined {
  if (location === null || location === "") return undefined;
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return undefined;
  }
  if (next.protocol !== "https:" && next.protocol !== "http:") return undefined;
  if (from.protocol === "https:" && next.protocol === "http:") return undefined;
  return next;
}

/** The response body as text, read in chunks and refused as soon as it passes `MAX_CONFIG_BYTES` (T-05-09). */
async function readBodyText(res: Response): Promise<{ text: string } | { tooLarge: true }> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CONFIG_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return { tooLarge: true };
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return { text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_CONFIG_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

interface HubRequest {
  fetch: typeof fetch;
  base: string;
  modelId: string;
  token: string | undefined;
  timeoutMs: number;
}

/**
 * Ask the Hub for the `config.json` of a repository id that already passed `isHfRepoId` (D-02). One time limit covers every
 * hop and the body. Redirects are followed by hand, at most `MAX_REDIRECTS`, and the token goes only to URLs with the
 * origin of the base (T-05-08). It never throws and no reason holds anything but a constant phrase, a status or a time.
 */
async function readFromHub(request: HubRequest): Promise<ModelConfigRead> {
  const signal = AbortSignal.timeout(request.timeoutMs);
  const baseOrigin = new URL(request.base).origin;
  let url = new URL(`${request.base}/${request.modelId}/resolve/main/config.json`);
  try {
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {};
      if (request.token !== undefined && url.origin === baseOrigin) headers.Authorization = `Bearer ${request.token}`;
      const res = await request.fetch(url.href, { method: "GET", headers, redirect: "manual", signal });
      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) return hubMiss("the Hugging Face Hub redirected too many times");
        const next = redirectTarget(url, res.headers.get("location"));
        if (next === undefined) return hubMiss("the Hugging Face Hub sent a redirect that was refused");
        url = next;
        continue;
      }
      if (res.status < 200 || res.status > 299) {
        await res.body?.cancel().catch(() => undefined);
        return hubMiss(statusPhrase(res.status));
      }
      const body = await readBodyText(res);
      return "text" in body ? parseConfig(body.text, "hub") : { ok: false, reason: TOO_LARGE };
    }
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
    return hubMiss(
      timedOut ? `the Hugging Face Hub did not answer within ${request.timeoutMs} ms` : "the Hugging Face Hub could not be reached",
    );
  }
}

/**
 * Create the reader of a model's `config.json`: a local model directory (an absolute path, or `./` and `../` against the
 * reader's working directory), or the Hugging Face cache snapshot of a repository id and, when the cache has none and the
 * caller allows it, the Hub. Any other id is refused before a path or a URL is built (T-05-04). It never throws: every
 * outcome is a `ModelConfigRead`, and a reason never holds a path, a token or file text (T-05-05, T-05-08).
 */
export function createModelConfigReader(options: ModelConfigReaderOptions = {}): ReadModelConfig {
  const env = options.env ?? process.env;
  const cacheRoot = options.cacheRoot ?? resolveCacheRoot(env);
  return async (modelId, readOptions) => {
    try {
      if (isLocalPath(modelId)) {
        const directory = resolve(options.cwd ?? process.cwd(), modelId);
        return toRead(readConfigFile(join(directory, "config.json")), "path", NO_CONFIG_IN_DIRECTORY);
      }
      if (!isHfRepoId(modelId)) return { ok: false, reason: NOT_AN_ID };
      const cached = readFromCache(cacheRoot, modelId);
      if (cached.ok || cached.reason !== NOT_IN_CACHE || !readOptions.hub) return cached;
      if (OFFLINE_VALUES.has((env.HF_HUB_OFFLINE ?? "").trim().toLowerCase())) {
        return hubMiss("the Hugging Face Hub was not asked because HF_HUB_OFFLINE is set");
      }
      const token = env.HF_TOKEN?.trim();
      return await readFromHub({
        fetch: options.fetch ?? globalThis.fetch,
        base: options.hubBaseUrl !== undefined ? options.hubBaseUrl.replace(/\/+$/, "") : hubBaseUrlOf(env),
        modelId,
        token: token === undefined || token === "" ? undefined : token,
        timeoutMs: options.hubTimeoutMs ?? HUB_TIMEOUT_MS,
      });
    } catch {
      return { ok: false, reason: UNREADABLE };
    }
  };
}

/** The whole name tokens that mark a model as a reasoning model (D-04). `kat-coder` is deliberately not one. */
export const REASONING_NAME_TOKENS: readonly string[] = ["r1", "qwq", "thinking", "reasoning", "reasoner", "magistral"];

/**
 * Whether the last segment of `id` (after the final `/` or `\`), lower-cased and split on every run of characters that is
 * not a letter or digit, holds one of `REASONING_NAME_TOKENS` as a whole token (D-04). An organisation or directory name
 * never counts, and neither does a token inside a longer word.
 */
export function isReasoningModelId(id: string): boolean {
  const last = id.slice(Math.max(id.lastIndexOf("/"), id.lastIndexOf("\\")) + 1).toLowerCase();
  return last.split(/[^a-z0-9]+/).some((token) => REASONING_NAME_TOKENS.includes(token));
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
 * record. The reasoning flag is the preset's when the id is a preset's model id, else the curated name rule's (D-04);
 * input is text for every model (D-05). A later plan lets the profile override both.
 */
export function deriveModelInfo(input: { id: string; config?: ModelConfigRead; limits?: LaunchLimits }): ModelInfo {
  const { config } = input;
  const declared = config?.ok ? contextWindowOf(config.config) : undefined;
  const contextWindow = declared ?? FALLBACK_CONTEXT_WINDOW;
  const preset = MODEL_PRESETS.find((p) => p.modelId === input.id);
  // Only the preset and the id decide. The chat template is deliberately not consulted: a template can mention thinking
  // for a model that does not think (Qwen3 Instruct 2507), so as a hint it could never change a correct outcome (D-04).
  const reasoning: boolean = preset ? preset.reasoning : isReasoningModelId(input.id);
  const info: ModelInfo = {
    contextWindow,
    contextSource: declared === undefined ? "fallback" : "config.json",
    maxTokens: defaultMaxTokens(contextWindow, reasoning),
    maxTokensSource: "default",
    reasoning,
    reasoningSource: preset ? "preset" : reasoning ? "model name" : "default",
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

/**
 * A text as shown: single-line and free of control characters, with credentials hidden, clipped to `max` characters. The
 * order is the one the project uses for every shown identifier: cleaned, then redacted, then clipped (D-03, T-05-10).
 */
const safe = (text: string, max: number): string => clipDiagnostic(redactCredentials(cleanLabel(text)), max, "start");

/** A source text as shown, clipped to 80 characters. */
const shownSource = (text: string): string => safe(text, 80);

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

/**
 * The warning shown when a model's context window could not be read and the documented fallback is used (D-03). The id
 * is clipped to 80 characters and the reason to 160, both cleaned and redacted first.
 */
export function fallbackNotice(id: string, reason: string): string {
  return `context window unavailable for ${safe(id, 80)} (${safe(reason, 160)}); using ${FALLBACK_CONTEXT_WINDOW}`;
}

/**
 * The one warning for the other listed models whose context window could not be read: how many, and the first reason, never
 * an id (D-12, D-03, T-05-10).
 */
export function extrasFallbackNotice(count: number, reason: string): string {
  return (
    `context window unavailable for ${count} other listed model${count === 1 ? "" : "s"} (${safe(reason, 160)}); ` +
    `using ${FALLBACK_CONTEXT_WINDOW} for ${count === 1 ? "it" : "them"}`
  );
}

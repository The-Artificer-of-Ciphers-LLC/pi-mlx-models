import { writeFileAtomic } from "./atomicfile.js";
import { isLoopbackHost } from "./config.js";
import { cleanLabel, clipDiagnostic, redactCredentials } from "./diagnostic.js";
import { MODEL_PRESETS } from "./presets.js";
import { CONTROL_CHARACTER, DEFAULT_PROFILE_KEY, type LayerFile, MAX_FILE_BYTES, MAX_TEXT_LENGTH, MODELS_KEY, PROFILES_KEY, PROFILE_NAME, PROFILE_NAME_SHORT_RULE, SETTINGS, type SettingDef, formatConfigErrors, prepareSettings, readLayerFile } from "./settings.js";

/**
 * The pure editing core of /mlx-config (CMD-02, D-17, D-20). An edit reads the global config fresh, changes one key in a
 * copy, validates the whole copy with the same validation a hand-edited file gets, and only then writes it with one
 * atomic rename. A file that cannot be read or parsed is never overwritten. There is no UI here.
 */

/** Where a value sits in the config file: the keys from the top of the file down. */
export type Segments = readonly string[];

/** A config file as plain data. */
export type ConfigTree = Record<string, unknown>;

const isObject = (value: unknown): value is ConfigTree => typeof value === "object" && value !== null && !Array.isArray(value);

/** An object with no prototype, so no key a user types can reach `Object.prototype` (T-06-13). */
const newObject = (): ConfigTree => Object.create(null) as ConfigTree;

/** Set a key by defining it: plain assignment of `__proto__` would change the prototype instead of adding a key. */
function put(target: ConfigTree, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A deep copy whose objects have no prototype; arrays and scalars are copied by value. */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyValue);
  if (!isObject(value)) return value;
  const copy = newObject();
  for (const key of Object.keys(value)) put(copy, key, copyValue(value[key]));
  return copy;
}

/** The value at `segments`, or undefined when any step is missing. Only own keys are followed, never a prototype's. */
export function getAt(tree: ConfigTree, segments: Segments): unknown {
  let node: unknown = tree;
  for (const key of segments) {
    if (!isObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * A copy of `tree` with `value` at `segments`; the input is not changed. Missing containers are created, and a step that
 * holds something other than an object is replaced by one.
 */
export function setAt(tree: ConfigTree, segments: Segments, value: unknown): ConfigTree {
  const copy = copyValue(tree) as ConfigTree;
  if (segments.length === 0) return copy;
  let node = copy;
  for (const key of segments.slice(0, -1)) {
    const next = Object.hasOwn(node, key) ? node[key] : undefined;
    if (isObject(next)) {
      node = next;
    } else {
      const fresh = newObject();
      put(node, key, fresh);
      node = fresh;
    }
  }
  put(node, segments[segments.length - 1], copyValue(value));
  return copy;
}

/**
 * A copy of `tree` without the key at `segments`; the input is not changed. A path that does not exist gives an equal copy.
 * A container left empty stays: removing the last key of a profile must not delete the profile.
 */
export function unsetAt(tree: ConfigTree, segments: Segments): ConfigTree {
  const copy = copyValue(tree) as ConfigTree;
  if (segments.length === 0) return copy;
  let node: unknown = copy;
  for (const key of segments.slice(0, -1)) {
    if (!isObject(node) || !Object.hasOwn(node, key)) return copy;
    node = node[key];
  }
  const last = segments[segments.length - 1];
  if (isObject(node) && Object.hasOwn(node, last)) delete node[last];
  return copy;
}

export type EditOutcome =
  | { ok: true; created: boolean; changed: boolean }
  | { ok: false; kind: "unreadable" | "invalid" | "too-large" | "write-failed"; message: string };

/** A file path as a message shows it: one line, no control characters, the end kept. */
const shownPath = (path: string): string => clipDiagnostic(cleanLabel(path), 200, "end");

/**
 * Read the file, change one key, validate the whole result, write it atomically.
 *
 * `change` gets a copy of the file's data (an empty tree when there is no file) and returns the changed tree. A file that
 * exists but cannot be used is refused untouched (D-20). The result is validated with `prepareSettings` over the global
 * layer alone, so only problems of this file can appear; a problem that was already in the file refuses the edit too, and
 * the message says so. A result equal to the original writes nothing.
 */
export function editConfig(path: string, change: (draft: ConfigTree) => ConfigTree): EditOutcome {
  const file = readLayerFile(path);
  if (file.state === "unusable") {
    return {
      ok: false,
      kind: "unreadable",
      message: `the config file ${shownPath(path)} ${file.reason}; it was not changed. Fix or remove it, then run /mlx-config again.`,
    };
  }
  const original: ConfigTree = file.state === "ok" ? file.data : {};
  let result: ConfigTree;
  try {
    result = change(copyValue(original) as ConfigTree);
    // The comparison below serialises both trees; a tree too deep for the stack fails here, before anything is written.
    JSON.stringify(original);
    JSON.stringify(result);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return {
      ok: false,
      kind: "unreadable",
      message: `the config file ${shownPath(path)} is nested too deeply to edit; it was not changed. Fix or remove it, then run /mlx-config again.`,
    };
  }

  const checked = prepareSettings({ global: { state: "ok", data: result }, env: {} });
  if (!checked.ok) {
    return {
      ok: false,
      kind: "invalid",
      message: `the change was not saved because the file would be invalid; some of the problems below may already have been in the file:\n${formatConfigErrors(checked.errors)}`,
    };
  }

  // Compared as data, not as text, so a hand-formatted file is not rewritten by an edit that changes nothing.
  // A file that does not exist is created only when there is something to put in it.
  if (JSON.stringify(result) === JSON.stringify(original) && (file.state === "ok" || Object.keys(result).length === 0)) {
    return { ok: true, created: false, changed: false };
  }

  const text = `${JSON.stringify(result, null, 2)}\n`;
  // Counted in bytes, as the reader counts them: a result over the cap would be refused by the reader on the next read.
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
    return {
      ok: false,
      kind: "too-large",
      message: `the change was not saved because the config file ${shownPath(path)} would be larger than 256 KiB and could no longer be read; it was not changed.`,
    };
  }
  const written = writeFileAtomic(path, text, { keepMode: true, followSymlink: true });
  if (!written.ok) {
    return {
      ok: false,
      kind: "write-failed",
      message: `the config file ${shownPath(path)} could not be written (${written.reason}); it was not changed.`,
    };
  }
  return { ok: true, created: file.state === "absent", changed: true };
}

/** The places a key can be edited: the global keys, the `model` block, one `models` entry or one profile of an entry. */
export type ConfigScope = "global" | "modelBlock" | "modelEntry" | "profile";

/** One key a scope offers: its table row, the row path and the dotted name shown to the user. */
export interface EditableKey {
  row: SettingDef;
  path: string;
  label: string;
}

/** The rows written inside a profile only (D-11). The settings module keeps this prefix private. */
const LIMITS_PREFIX = "model.limits.";

/** The segments of a row path below the `model` block: `sampling.temperature` for `model.sampling.temperature`. */
const belowModel = (row: SettingDef): string[] => row.path.split(".").slice(1);

/**
 * The keys a scope offers, taken from the SETTINGS table so a row added there appears without a change here (D-19).
 * Global is every row that is not a per-model option; a `model` block and a `models` entry take the per-model rows except the
 * limits rows, which the file reader accepts inside a profile only; a profile takes every per-model row (Pitfall 5).
 */
export function editableKeys(scope: ConfigScope): EditableKey[] {
  const rows = SETTINGS.filter((row) => {
    if (scope === "global") return row.perModel !== true;
    if (row.perModel !== true) return false;
    return scope === "profile" || !row.path.startsWith(LIMITS_PREFIX);
  });
  return rows.map((row) => ({ row, path: row.path, label: scope === "modelEntry" || scope === "profile" ? belowModel(row).join(".") : row.path }));
}

/**
 * Where a scope writes a row in the file. A `models` entry holds the keys of the `model` block directly, and a profile holds
 * them inside `profiles`; `target` names the model key and the profile name.
 */
export function segmentsFor(scope: ConfigScope, row: SettingDef, target: { model?: string; profile?: string } = {}): string[] {
  if (scope === "global" || scope === "modelBlock") return row.path.split(".");
  if (target.model === undefined) throw new Error("segmentsFor needs a model key for this scope");
  if (scope === "modelEntry") return [MODELS_KEY, target.model, ...belowModel(row)];
  if (target.profile === undefined) throw new Error("segmentsFor needs a profile name for this scope");
  return [MODELS_KEY, target.model, PROFILES_KEY, target.profile, ...belowModel(row)];
}

/** Plain decimal or exponent syntax: no hex, no `Infinity`, and no empty text, which `Number()` would read as 0. */
const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER_TEXT = /^[+-]?\d+$/;

type Converted = { ok: true; value: unknown } | { ok: false; message: string };

/** The text parsed as JSON, or undefined when it is not JSON. */
function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * Typed text as the file form of a row's value, by the row's kind and not by its `parseText` (the environment path is lossy
 * for file kinds). The result is checked with the row's own check. A failure carries a message built from the row path and
 * its expected text; nothing the user typed is echoed (Pitfall 7).
 */
export function convertInput(row: SettingDef, text: string): Converted {
  const fail: Converted = { ok: false, message: `${cleanLabel(row.path)} must be ${cleanLabel(row.expected)}` };
  const trimmed = text.trim();
  let value: unknown;
  switch (row.kind) {
    case "integer": {
      if (!INTEGER_TEXT.test(trimmed)) return fail;
      const number = Number(trimmed);
      if (!Number.isSafeInteger(number)) return fail;
      value = number === 0 ? 0 : number;
      break;
    }
    case "number": {
      if (!NUMBER_TEXT.test(trimmed)) return fail;
      const number = Number(trimmed);
      if (!Number.isFinite(number)) return fail;
      value = number === 0 ? 0 : number;
      break;
    }
    case "bool":
      if (trimmed !== "true" && trimmed !== "false") return fail;
      value = trimmed === "true";
      break;
    case "string":
    case "path":
    case "enum":
      if (trimmed === "") return fail;
      value = trimmed;
      break;
    case "list": {
      if (trimmed.startsWith("[")) {
        const parsed = parseJson(trimmed);
        if (parsed === undefined || !Array.isArray(parsed.value)) return fail;
        value = parsed.value;
      } else if (row.path === "model.sampling.stop") {
        // The file accepts one string here, so text that is not a JSON array is a single stop sequence.
        if (trimmed === "") return fail;
        value = trimmed;
      } else {
        const entries = trimmed.split(",").map((entry) => entry.trim());
        if (entries.some((entry) => entry === "")) return fail;
        value = entries;
      }
      break;
    }
    case "jsonObject": {
      const parsed = parseJson(trimmed);
      if (parsed === undefined || !isObject(parsed.value)) return fail;
      value = parsed.value;
      break;
    }
  }
  return row.check(value).ok ? { ok: true, value } : fail;
}

/**
 * The last line of every trust dialog and every /mlx-config confirmation (CFG-06, GAP-02); index.ts imports it from here,
 * so there is one copy. pi's `ctx.ui.confirm(title, message, opts?)` takes options of type `ExtensionUIDialogOptions`, which carries only `signal` and `timeout` (checked in @earendil-works/pi-coding-agent
 * 0.73.0 and @earendil-works/pi-coding-agent 1.3.0). An extension therefore cannot choose which choice is highlighted,
 * and interactive pi opens the dialog with Yes highlighted. This sentence is the only protection available while the
 * call stays `ctx.ui.confirm` (D-13); pressing Enter without reading still selects Yes. The real fix is a default option
 * in pi, or a decision to amend D-13 and ask with `ctx.ui.select` with No first. A constant on purpose: no text from a
 * file, the environment or a flag is ever added to it (T-02-31).
 */
export const SAFE_CHOICE_NOTE = "Yes allows this. No or Esc cancels. Check which option is highlighted before pressing Enter.";

/** A value as a dialog shows it: one line, credentials hidden, at most 300 characters, in that order. */
function shownValue(value: unknown): string {
  const text = Array.isArray(value) ? value.map(String).join(", ") : String(value);
  return clipDiagnostic(redactCredentials(cleanLabel(text)), 300, "start");
}

/** True when a base URL does not point at this machine; text that is not a URL counts as not loopback. */
function isNonLoopbackUrl(value: string): boolean {
  try {
    return !isLoopbackHost(new URL(value).hostname);
  } catch {
    return true;
  }
}

/**
 * The confirmation an edit needs before it is written, or undefined when it needs none. The settings that run code, open the
 * network, choose where mlx-lm is installed from or start a model when pi opens are marked (D-19, T-06-17): trustRemoteCode
 * true, a non-loopback host, any allowedOrigins, a non-loopback baseUrl, any pipIndex and autoStart true. Turning one off or
 * removing it needs none, so a caller asks only when it is about to write a value.
 */
export function confirmationFor(row: SettingDef, value: unknown): { title: string; message: string } | undefined {
  if (value === undefined) return undefined;
  const shown = shownValue(value);
  const note = ` ${SAFE_CHOICE_NOTE}`;
  switch (row.path) {
    case "server.trustRemoteCode":
      if (value !== true) return undefined;
      return {
        title: "Allow remote code from model repositories?",
        message: `trustRemoteCode lets a model repository run Python code on this machine every time a model starts. Only continue for repositories you trust.${note}`,
      };
    case "server.host":
      if (typeof value !== "string" || isLoopbackHost(value)) return undefined;
      return {
        title: "Listen on a non-loopback address?",
        message: `The MLX server will listen on ${shown}, reachable from your network. mlx_lm.server has no authentication.${note}`,
      };
    case "server.allowedOrigins":
      return {
        title: "Allow browser origins to reach the server?",
        message: `Web pages from ${shown} will be allowed to call the MLX server from a browser on this machine.${note}`,
      };
    case "baseUrl":
      if (typeof value !== "string" || !isNonLoopbackUrl(value)) return undefined;
      return {
        title: "Send prompts to a non-loopback address?",
        message: `pi will send your conversation to ${shown}, which is not on this machine.${note}`,
      };
    case "mlxLm.pipIndex":
      return {
        title: "Install mlx-lm from a different package index?",
        message: `/mlx-init will download and run Python packages from ${shown}. Only continue for an index you trust.${note}`,
      };
    case "autoStart":
      if (value !== true) return undefined;
      return {
        title: "Start the last model when pi opens?",
        message: `pi will start the last model by itself every time it opens, which uses memory and can take several minutes.${note}`,
      };
    default:
      return undefined;
  }
}

/** Own keys of a plain object, sorted; empty for anything else. */
function sortedKeys(value: unknown): string[] {
  return isObject(value) ? Object.keys(value).sort() : [];
}

/** The model keys under `models`, sorted. */
export function modelKeys(tree: ConfigTree): string[] {
  return sortedKeys(getAt(tree, [MODELS_KEY]));
}

/** The profile names of one model entry, sorted. */
export function profileNames(tree: ConfigTree, model: string): string[] {
  return sortedKeys(getAt(tree, [MODELS_KEY, model, PROFILES_KEY]));
}

/** The default profile a model entry names, or undefined when it names none or something that is not a name. */
export function defaultProfileOf(tree: ConfigTree, model: string): string | undefined {
  const chosen = getAt(tree, [MODELS_KEY, model, DEFAULT_PROFILE_KEY]);
  return typeof chosen === "string" ? chosen : undefined;
}

/** A copy of `tree` with an empty profile, and the model entry that holds it when there is none. An existing profile is replaced. */
export function createProfile(tree: ConfigTree, model: string, profile: string): ConfigTree {
  return setAt(tree, [MODELS_KEY, model, PROFILES_KEY, profile], {});
}

/** A copy of `tree` without the profile; a default profile that named it is cleared in the same change. */
export function deleteProfile(tree: ConfigTree, model: string, profile: string): ConfigTree {
  const without = unsetAt(tree, [MODELS_KEY, model, PROFILES_KEY, profile]);
  return defaultProfileOf(without, model) === profile ? unsetAt(without, [MODELS_KEY, model, DEFAULT_PROFILE_KEY]) : without;
}

/** A copy of `tree` whose model entry names `profile` as its default, or none when `profile` is undefined. */
export function setDefaultProfile(tree: ConfigTree, model: string, profile: string | undefined): ConfigTree {
  const path = [MODELS_KEY, model, DEFAULT_PROFILE_KEY];
  return profile === undefined ? unsetAt(tree, path) : setAt(tree, path, profile);
}

/** A copy of `tree` without one model entry. */
export function deleteModelEntry(tree: ConfigTree, model: string): ConfigTree {
  return unsetAt(tree, [MODELS_KEY, model]);
}

/** What deleting one model entry takes with it: the profile names, the option keys and the default profile, for the confirm text. */
export interface ModelEntrySummary {
  profiles: string[];
  options: string[];
  defaultProfile: string | undefined;
  /** The value at models.KEY exists and is not an object (a number, text, an array, null, a boolean); only a hand edit makes one. */
  notAnObject: boolean;
}

export function modelEntrySummary(tree: ConfigTree, model: string): ModelEntrySummary {
  const entry = getAt(tree, [MODELS_KEY, model]);
  if (!isObject(entry)) return { profiles: [], options: [], defaultProfile: undefined, notAnObject: entry !== undefined };
  return {
    profiles: profileNames(tree, model),
    options: sortedKeys(entry).filter((key) => key !== PROFILES_KEY && key !== DEFAULT_PROFILE_KEY),
    defaultProfile: defaultProfileOf(tree, model),
    notAnObject: false,
  };
}

type Checked = { ok: true; value: string } | { ok: false; message: string };

const MAX_MODEL_KEY_LENGTH = MAX_TEXT_LENGTH;

/**
 * A model key the user types for `models`. This checks only the shape: one line, not empty after trimming, at most 4096
 * characters, no control character and no leading dash. Any other text, `__proto__` included, is a plain key. Whether a key is
 * likely to match a start is a separate, advisory question answered by `isPlausibleModelKey`, which never rejects a key.
 */
export function validateModelKey(text: string): Checked {
  const value = text.trim();
  if (value === "") return { ok: false, message: "a model id must not be empty" };
  if (value.length > MAX_MODEL_KEY_LENGTH) return { ok: false, message: `a model id must be at most ${MAX_MODEL_KEY_LENGTH} characters` };
  if (CONTROL_CHARACTER.test(value)) return { ok: false, message: "a model id must be one line without control characters" };
  if (value.startsWith("-")) return { ok: false, message: "a model id must not start with a dash" };
  return { ok: true, value };
}

/**
 * Whether a typed model key is likely to match a start: a preset key, or an id with a slash such as `org/name` (every
 * absolute or relative path has a slash). A bare name such as `gpt2` does match a start given exactly that name, but it is more
 * often a profile name typed where the model key belongs, so it counts as unlikely. Advisory only: it never rejects a key.
 */
export function isPlausibleModelKey(key: string): boolean {
  return MODEL_PRESETS.some((preset) => preset.key === key) || key.includes("/");
}

/** A profile name the user types: the profile rule of the settings module. */
export function validateProfileName(text: string): Checked {
  const value = text.trim();
  return PROFILE_NAME.test(value) ? { ok: true, value } : { ok: false, message: `the profile name must be ${PROFILE_NAME_SHORT_RULE}` };
}

/** The longest value the viewer prints, in characters. */
const VIEW_VALUE_MAX = 200;
/** The most model lines and problem lines the viewer prints. */
const MAX_VIEW_LINES = 20;

/** Text from the file as the viewer prints it: cleaned, then credentials hidden, then clipped, in that order. */
const viewText = (text: string): string => clipDiagnostic(redactCredentials(cleanLabel(text)), VIEW_VALUE_MAX, "start");

/** A value as JSON text, shown with `viewText`. */
function viewValue(value: unknown): string {
  try {
    return viewText(JSON.stringify(value) ?? String(value));
  } catch {
    return "(a value that cannot be shown)";
  }
}

/**
 * The current config file as text for viewing (D-17, D-23): the keys that are set, the models with their profile names and the
 * problems validation finds. Every value is cleaned, has credentials hidden and is clipped; a key the table does not know is
 * reported by the validation problems and never printed as a value (T-06-18). The same text is what the no-UI mode prints.
 */
export function renderConfig(file: LayerFile, path: string): string {
  const where = shownPath(path);
  if (file.state === "absent") return `The config file ${where} does not exist yet; the first edit creates it.`;
  if (file.state === "unusable") {
    return `The config file ${where} cannot be used: ${clipDiagnostic(cleanLabel(file.reason), VIEW_VALUE_MAX, "start")}. /mlx-config will not change it until it is fixed or removed.`;
  }

  const setLine = (row: SettingDef): string[] => {
    const value = getAt(file.data, row.path.split("."));
    return value === undefined ? [] : [`  ${row.path}: ${viewValue(value)}`];
  };
  const lines = [`Config file ${where}`];
  const general = SETTINGS.filter((row) => row.perModel !== true).flatMap(setLine);
  const block = SETTINGS.filter((row) => row.perModel === true && !row.path.startsWith(LIMITS_PREFIX)).flatMap(setLine);
  if (general.length > 0) lines.push("Settings", ...general);
  if (block.length > 0) lines.push("Model defaults (the model block)", ...block);

  const keys = modelKeys(file.data);
  if (keys.length > 0) {
    lines.push(`Models (${keys.length})`);
    for (const key of keys.slice(0, MAX_VIEW_LINES)) {
      const profiles = profileNames(file.data, key).map(viewText);
      const defaultProfile = getAt(file.data, [MODELS_KEY, key, DEFAULT_PROFILE_KEY]);
      const parts = [
        defaultProfile === undefined ? undefined : `defaultProfile ${viewValue(defaultProfile)}`,
        profiles.length === 0 ? undefined : `profiles: ${profiles.join(", ")}`,
      ].filter((part): part is string => part !== undefined);
      lines.push(`  ${viewValue(key)}${parts.length === 0 ? "" : `: ${parts.join("; ")}`}`);
    }
    if (keys.length > MAX_VIEW_LINES) lines.push(`  and ${keys.length - MAX_VIEW_LINES} more`);
  }
  if (lines.length === 1) lines.push("Nothing is set in this file.");

  const checked = prepareSettings({ global: file, env: {} });
  if (checked.ok) {
    lines.push("No problems found.");
  } else {
    lines.push("Problems");
    // These lines already have credentials hidden by the validation; hiding them again by position would damage them.
    for (const error of checked.errors.slice(0, MAX_VIEW_LINES)) lines.push(`  ${clipDiagnostic(cleanLabel(error), 300, "start")}`);
    const more = checked.errors.length - MAX_VIEW_LINES;
    if (more > 0) lines.push(`  and ${more} more problem${more === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

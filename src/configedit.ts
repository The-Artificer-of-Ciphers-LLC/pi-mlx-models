import { writeFileAtomic } from "./atomicfile.js";
import { cleanLabel, clipDiagnostic } from "./diagnostic.js";
import { formatConfigErrors, prepareSettings, readLayerFile } from "./settings.js";

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
  const result = change(copyValue(original) as ConfigTree);

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

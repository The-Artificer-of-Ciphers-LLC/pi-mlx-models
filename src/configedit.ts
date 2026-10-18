/** Where a value sits in the config file: the keys from the top of the file down. */
export type Segments = readonly string[];

/** A config file as plain data. */
export type ConfigTree = Record<string, unknown>;

/** The value at `segments`, or undefined when any step is missing. Only own keys are followed. */
export function getAt(_tree: ConfigTree, _segments: Segments): unknown {
  throw new Error("not implemented");
}

/** A copy of `tree` with `value` at `segments`; the input is not changed. */
export function setAt(_tree: ConfigTree, _segments: Segments, _value: unknown): ConfigTree {
  throw new Error("not implemented");
}

/** A copy of `tree` without the key at `segments`; the input is not changed. */
export function unsetAt(_tree: ConfigTree, _segments: Segments): ConfigTree {
  throw new Error("not implemented");
}

export type EditOutcome =
  | { ok: true; created: boolean; changed: boolean }
  | { ok: false; kind: "unreadable" | "invalid" | "too-large" | "write-failed"; message: string };

/** Read the file, change it, validate the whole result, write it atomically. */
export function editConfig(_path: string, _change: (draft: ConfigTree) => ConfigTree): EditOutcome {
  throw new Error("not implemented");
}

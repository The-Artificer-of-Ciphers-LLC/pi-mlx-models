/** One flag `/mlx-start` accepts: its spelling, the setting path it sets, and whether it takes a value. */
export interface CliFlagSpec {
  flag: string;
  path: string;
  takesValue: boolean;
}

/** A flag as typed: `raw` is the text after the flag, or `true` for a flag that takes no value. */
export interface CliFlagValue {
  flag: string;
  path: string;
  raw: string | true;
}

export type StartArgsResult = { ok: true; model?: string; flags: CliFlagValue[] } | { ok: false; error: string };

export function tokenizeStartArgs(_raw: string): { tokens: string[] } | { error: string } {
  return { tokens: [] };
}

export function parseStartArgs(_raw: string, _specs: readonly CliFlagSpec[]): StartArgsResult {
  return { ok: true, flags: [] };
}

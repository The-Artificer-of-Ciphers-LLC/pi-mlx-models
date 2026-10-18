import { cleanLabel, clipDiagnostic } from "./diagnostic.js";

/**
 * The text typed after `/mlx-start`: `[model] [--flag value | --flag=value ...]`.
 *
 * The grammar is deliberately small and strict. A flag that is not in the table is an error and is never
 * passed on, so typed text cannot become an arbitrary server option (T-02-10). Scanning is one linear pass
 * with no backtracking, and the input is capped, so hostile input cannot stall pi (T-02-12).
 */

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

/** How a command uses the parser. The defaults are `/mlx-start`'s own. */
export interface ParseOptions {
  /** The command's name as error messages show it; default "/mlx-start". */
  command?: string;
  /** Whether a word that is not a flag is the model (default true); when false it is an error. */
  takesModel?: boolean;
}

const DEFAULT_COMMAND = "/mlx-start";

export type StartArgsResult = { ok: true; model?: string; flags: CliFlagValue[] } | { ok: false; error: string };

/** The longest argument string that is looked at. */
const MAX_ARGS_LENGTH = 8192;

const isSpace = (char: string): boolean => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\v" || char === "\f";

/**
 * Split the argument text into tokens. Tokens are separated by whitespace; single quotes are literal;
 * double quotes honor only a backslash before a quote or a backslash; quoted segments join the text next to
 * them into one token (so `--k='{"a":1}'` is one token); an empty quoted string is an empty token; there
 * are no escapes outside quotes; an unterminated quote is an error.
 */
export function tokenizeStartArgs(raw: string, command: string = DEFAULT_COMMAND): { tokens: string[] } | { error: string } {
  if (raw.length > MAX_ARGS_LENGTH) return { error: `the ${command} arguments are longer than ${MAX_ARGS_LENGTH} characters` };
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
    } else if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && (raw[i + 1] === '"' || raw[i + 1] === "\\")) {
        current += raw[i + 1];
        i += 1;
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
    } else if (isSpace(char)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += char;
      inToken = true;
    }
  }
  if (quote !== null) return { error: `unterminated quote in the ${command} arguments` };
  if (inToken) tokens.push(current);
  return { tokens };
}

/** A token as echoed in an error: control characters removed and at most 60 characters. */
const echo = (token: string): string => clipDiagnostic(cleanLabel(token), 60, "start");

/**
 * Parse the argument text against the flags `specs` allow. The first token that is not a flag is the model;
 * a second one is an error. A valued flag takes the next token unless that token starts with two dashes (use
 * `--flag=value` for such a value); a flag may appear once. With `takesModel` false any such word is an error.
 */
export function parseStartArgs(raw: string, specs: readonly CliFlagSpec[], options: ParseOptions = {}): StartArgsResult {
  const command = options.command ?? DEFAULT_COMMAND;
  const takesModel = options.takesModel ?? true;
  const tokenized = tokenizeStartArgs(raw, command);
  if ("error" in tokenized) return { ok: false, error: tokenized.error };
  const { tokens } = tokenized;

  const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));
  const seen = new Set<string>();
  const flags: CliFlagValue[] = [];
  let model: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      if (!takesModel) return { ok: false, error: `unexpected argument ${echo(token)} (${command} takes no model)` };
      if (model !== undefined) return { ok: false, error: `unexpected extra argument ${echo(token)} (only one model is accepted)` };
      model = token;
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const attached = equals === -1 ? undefined : token.slice(equals + 1);
    const spec = byFlag.get(name);
    if (spec === undefined) {
      return { ok: false, error: `unknown flag ${echo(name)} (valid flags: ${specs.map((s) => s.flag).join(", ")})` };
    }
    if (seen.has(name)) return { ok: false, error: `${name} was given twice` };
    seen.add(name);

    if (!spec.takesValue) {
      if (attached !== undefined) return { ok: false, error: `${name} takes no value` };
      flags.push({ flag: name, path: spec.path, raw: true });
      continue;
    }
    let value = attached;
    if (value === undefined) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) return { ok: false, error: `${name} needs a value` };
      value = next;
      i += 1;
    }
    flags.push({ flag: name, path: spec.path, raw: value });
  }

  return model === undefined ? { ok: true, flags } : { ok: true, model, flags };
}

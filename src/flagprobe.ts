import { spawn } from "node:child_process";
import { cleanLabel, clipDiagnostic } from "./diagnostic.js";

/**
 * Which server flags the installed mlx-lm supports is decided by asking it (D-18): the venv's python prints
 * `python -m mlx_lm.server --help` and the `--flag` names it lists are collected. There is no version table. The
 * answer is cached in memory by the installed mlx-lm version, so the slow `--help` (about 2 s, it imports mlx) runs
 * once per version per extension instance, while the cheap version query (about 0.07 s, no mlx import) runs on every
 * probe and so notices an upgrade done through /mlx-init.
 *
 * When the probe cannot give an answer the caller passes every configured flag and warns (D-20): a server that
 * rejects a flag exits early and the start's own failure message is the honest report.
 */

export type ProbeResult =
  | { ok: true; version: string; flags: ReadonlySet<string> }
  | { ok: false; reason: string };

/** The answer of the cheap version query: the installed mlx-lm version, or why it could not be read. */
export type VersionResult = { ok: true; version: string } | { ok: false; reason: string };

export interface ProbeCommandOptions {
  /** Exactly the environment the child gets; nothing is merged in. */
  env: NodeJS.ProcessEnv;
  /** The child is killed (SIGKILL) after this long. */
  timeoutMs: number;
  /** At most this many bytes of stdout are kept; more kills the child and marks the result truncated. */
  maxBytes: number;
  cwd?: string;
}

export interface ProbeCommandResult {
  /** The exit code, or null when the child was killed. */
  code: number | null;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const REASON_MAX = 160;

/** What the version query prints: a conservative PEP 440 character set, at most 32 characters. */
const VERSION_TEXT = /^[0-9A-Za-z.+!-]{1,32}$/;

const VERSION_ARGS = ["-c", "import importlib.metadata as m; print(m.version('mlx-lm'))"] as const;
const HELP_ARGS = ["-m", "mlx_lm.server", "--help"] as const;

/**
 * The `--flag` names of an argparse help text. Only the options section counts: an option line is two spaces and a
 * dash, and only the part before the first run of two or more spaces is read, so prose, the usage block and wrapped
 * descriptions that mention other flags add nothing. ANSI colour (Python 3.14+ colours help when FORCE_COLOR is set)
 * is stripped first.
 */
export function parseHelpFlags(help: string): Set<string> {
  const text = help.replace(/\u001b\[[0-9;]*m/g, "");
  const flags = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^ {2}-/.test(line)) continue;
    const head = line.trim().split(/ {2,}/)[0];
    for (const match of head.matchAll(/(?<![\w-])--[a-z0-9][a-z0-9-]*/g)) flags.add(match[0]);
  }
  return flags;
}

/**
 * The environment for the probe's python: PYTHONSAFEPATH keeps the working directory (possibly a cloned repository)
 * off the module search path, so a project-supplied `mlx_lm` can never run (T-02-23); NO_COLOR and a removed
 * FORCE_COLOR keep the help free of colour codes.
 */
export function probeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PYTHONSAFEPATH: "1", NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
}

/**
 * Run a command with no shell and no stdin, keep up to `maxBytes` of stdout, drain and discard stderr, and stop the
 * child at the timeout or when the cap is hit. Resolves when the child has closed; rejects only when it cannot be
 * started (T-02-24).
 */
export function runProbeCommand(command: string, args: readonly string[], options: ProbeCommandOptions): Promise<ProbeCommandResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      });
    } catch (error) {
      reject(error);
      return;
    }
    const chunks: Buffer[] = [];
    let collected = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maxBytes - collected;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        collected = options.maxBytes;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      collected += chunk.length;
    });
    // A child that fills the stderr pipe would block; read it and throw it away.
    child.stderr.on("data", () => {});
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    // `close`, not `exit`: exit can fire before the last stdout chunk has been read.
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut, truncated });
    });
  });
}

export interface FlagProbeDeps {
  /** The venv's python. */
  python: string;
  run?: typeof runProbeCommand;
  /** The environment the probe starts from; default the process's own. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Text that reaches the UI: control characters become spaces and the length is bounded (T-02-25). */
const reasonText = (text: string): string => clipDiagnostic(cleanLabel(text), REASON_MAX, "start");
const failure = (reason: string): ProbeResult => ({ ok: false, reason: reasonText(reason) });
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A probe over one python. `probe()` never throws: any trouble is `{ ok: false, reason }`, and a failure is never
 * cached, so the next launch tries again.
 */
export function createFlagProbe(deps: FlagProbeDeps): { probe(): Promise<ProbeResult>; installedVersion(): Promise<VersionResult> } {
  const run = deps.run ?? runProbeCommand;
  const limits = { timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: deps.maxBytes ?? DEFAULT_MAX_BYTES };
  const cache = new Map<string, ReadonlySet<string>>();
  const inFlight = new Map<string, Promise<ProbeResult>>();

  const readVersion = async (env: NodeJS.ProcessEnv): Promise<{ version: string } | { reason: string }> => {
    let result: ProbeCommandResult;
    try {
      result = await run(deps.python, VERSION_ARGS, { env, ...limits });
    } catch (error) {
      return { reason: `could not run ${deps.python} (${errorText(error)})` };
    }
    if (result.timedOut) return { reason: "reading the mlx-lm version timed out" };
    if (result.code !== 0) return { reason: `could not read the mlx-lm version (python exited with ${result.code ?? "a signal"})` };
    const version = result.stdout.trim();
    if (result.truncated || !VERSION_TEXT.test(version)) return { reason: "the mlx-lm version text is not a version number" };
    return { version };
  };

  const readHelp = async (version: string, env: NodeJS.ProcessEnv): Promise<ProbeResult> => {
    let result: ProbeCommandResult;
    try {
      result = await run(deps.python, HELP_ARGS, { env, ...limits });
    } catch (error) {
      return failure(`could not run mlx_lm.server --help (${errorText(error)})`);
    }
    if (result.timedOut) return failure(`mlx_lm.server --help timed out after ${Math.round(limits.timeoutMs / 1000)} s`);
    if (result.truncated) return failure(`mlx_lm.server --help printed too much output (over ${Math.round(limits.maxBytes / 1024)} KiB)`);
    if (result.code !== 0) return failure(`mlx_lm.server --help exited with ${result.code ?? "a signal"}`);
    const flags = parseHelpFlags(result.stdout);
    if (flags.size === 0) return failure("the help text lists no recognizable flags");
    if (!flags.has("--model")) return failure("the help text does not list --model");
    cache.set(version, flags);
    return { ok: true, version, flags };
  };

  return {
    /** Only the cheap version query (no `--help`, no mlx import); nothing is cached and it never throws. */
    async installedVersion(): Promise<VersionResult> {
      const read = await readVersion(probeEnv(deps.env ?? process.env));
      return "reason" in read ? { ok: false, reason: reasonText(read.reason) } : { ok: true, version: read.version };
    },
    async probe() {
      const env = probeEnv(deps.env ?? process.env);
      const read = await readVersion(env);
      if ("reason" in read) return failure(read.reason);
      const { version } = read;
      const cached = cache.get(version);
      if (cached !== undefined) return { ok: true, version, flags: cached };
      let pending = inFlight.get(version);
      if (pending === undefined) {
        pending = readHelp(version, env).finally(() => inFlight.delete(version));
        inFlight.set(version, pending);
      }
      return pending;
    },
  };
}

/**
 * Split launch flags into those to pass and those the install cannot do. Core flags (host, port) are always passed.
 * A failed probe skips nothing (D-20). Order is kept.
 */
export function partitionFlags<T extends { flag: string; core: boolean }>(
  flags: readonly T[],
  probe: ProbeResult,
): { passed: T[]; skipped: T[] } {
  if (!probe.ok) return { passed: [...flags], skipped: [] };
  const passed: T[] = [];
  const skipped: T[] = [];
  for (const flag of flags) (flag.core || probe.flags.has(flag.flag) ? passed : skipped).push(flag);
  return { passed, skipped };
}

/** The one warning a launch shows for everything it skipped (D-19). */
export function skippedNotice(flags: readonly string[], version: string): string {
  return `Skipped ${flags.join(", ")}: not supported by mlx-lm ${version} (run /mlx-init to upgrade)`;
}

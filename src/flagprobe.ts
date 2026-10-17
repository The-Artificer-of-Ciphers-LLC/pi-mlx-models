// RED stub: signatures only, so the tests compile and fail on their assertions. Replaced by the implementation.

export type ProbeResult =
  | { ok: true; version: string; flags: ReadonlySet<string> }
  | { ok: false; reason: string };

export interface ProbeCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes: number;
  cwd?: string;
}

export interface ProbeCommandResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
}

export function parseHelpFlags(_help: string): Set<string> {
  return new Set();
}

export function probeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base };
}

export async function runProbeCommand(_command: string, _args: readonly string[], _options: ProbeCommandOptions): Promise<ProbeCommandResult> {
  return { code: null, stdout: "", timedOut: false, truncated: false };
}

export interface FlagProbeDeps {
  python: string;
  run?: typeof runProbeCommand;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
}

export function createFlagProbe(_deps: FlagProbeDeps): { probe(): Promise<ProbeResult> } {
  return { probe: async () => ({ ok: false, reason: "not implemented" }) };
}

export function partitionFlags<T extends { flag: string; core: boolean }>(flags: readonly T[], _probe: ProbeResult): { passed: T[]; skipped: T[] } {
  return { passed: [...flags], skipped: [] };
}

export function skippedNotice(_flags: readonly string[], _version: string): string {
  return "";
}

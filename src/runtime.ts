import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DEFAULT_PIP_INDEX, VENV_DIR, VENV_PYTHON } from "./config.js";
import { cleanLabel, clipDiagnostic } from "./diagnostic.js";

export type RuntimeEvent = {
  phase: "python" | "venv" | "pip" | "mlx-lm";
  state: "active" | "done";
  detail?: string;
  progress?: number;
};

/** The machine-facing seam: real in production, scripted in tests. */
export interface RuntimeHost {
  findPython(): string | null;
  searched?(): string[];
  exists(path: string): boolean;
  /** `options.timeoutMs` kills the child and rejects when it has not ended by then; without it the child may run for good. */
  run(cmd: string, args: string[], onLine?: (line: string) => void, options?: RunOptions): Promise<void>;
}

export interface RunOptions {
  timeoutMs?: number;
}

/**
 * What /mlx-init installs. `version` is the word "latest" or an exact version, both already checked by the settings
 * layer; `pipIndex` is the package index, the default one when omitted. Neither can reach pip as anything but part of
 * one argv element (`mlx-lm==VERSION`, `--index-url=VALUE`), so neither can become a second pip option.
 */
export interface InstallPolicy {
  version: string;
  pipIndex?: string;
}

/** The mlx-lm floor used when the version floats (D-05). */
const MLX_LM_FLOOR = "mlx-lm>=0.24.0";

/** mlx-lm 0.32 requires Python 3.11+. There is deliberately no ceiling. */
const MIN_PYTHON_MINOR = 11;

const PYTHON_OVERRIDE_ENV = "PI_MLX_MODELS_PYTHON";

const PYTHON_CANDIDATES = [
  "/opt/homebrew/bin/python3.14",
  "/opt/homebrew/bin/python3.13",
  "/opt/homebrew/bin/python3.12",
  "/opt/homebrew/bin/python3.11",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
];

type Probe = { ok: true } | { ok: false; reason: string };

function probePython(candidate: string): Probe {
  try {
    const s = spawnSync(candidate, ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 3000 });
    if (s.status !== 0) return { ok: false, reason: "did not run" };
    const out = `${s.stdout?.toString() || ""}${s.stderr?.toString() || ""}`;
    const m = out.match(/Python\s+3\.(\d+)/);
    if (!m) return { ok: false, reason: "not a Python 3 interpreter" };
    if (Number(m[1]) < MIN_PYTHON_MINOR) return { ok: false, reason: `Python 3.${m[1]} is older than 3.${MIN_PYTHON_MINOR}` };
    return { ok: true };
  } catch {
    return { ok: false, reason: "could not be executed" };
  }
}

/**
 * Names searched on PATH, newest first. The named probes stop at 3.14: a brand-new
 * interpreter may lack wheels for transitive dependencies, but a bare `python3` or an
 * explicit PI_MLX_MODELS_PYTHON of any newer version is still accepted (no ceiling).
 */
const PATH_PYTHON_NAMES = ["python3.14", "python3.13", "python3.12", "python3.11", "python3"];

/** Fixed candidates first, then PATH expanded name-major so the newest name anywhere wins. */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env, fixed: string[] = PYTHON_CANDIDATES): string[] {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const fromPath = PATH_PYTHON_NAMES.flatMap((name) => dirs.map((dir) => join(dir, name)));
  return [...new Set([...fixed, ...fromPath])];
}

/**
 * First acceptable Python 3.11+ interpreter, or null.
 * PI_MLX_MODELS_PYTHON (env only, never a project file) is tried first; when it is set
 * but unusable this throws by name rather than silently using another binary.
 */
export function findPython(options: { candidates?: string[]; env?: NodeJS.ProcessEnv } = {}): string | null {
  const env = options.env ?? process.env;
  const override = env[PYTHON_OVERRIDE_ENV]?.trim();
  if (override) {
    const probe = probePython(override);
    if (probe.ok) return override;
    throw new Error(
      `${PYTHON_OVERRIDE_ENV} is set to "${override}" but it is not a usable Python 3.${MIN_PYTHON_MINOR}+ interpreter (${probe.reason}).`,
    );
  }
  for (const c of pythonCandidates(env, options.candidates ?? PYTHON_CANDIDATES)) {
    if (probePython(c).ok) return c;
  }
  return null;
}

/** The most stderr kept for a failure message; the message shows the last 800 characters, so older output is dropped. */
const MAX_STDERR_KEPT = 4096;

/** What `run` rejects with when its `timeoutMs` ran out, so a caller can tell a slow command from a failed one. */
export class RunTimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    // Whole seconds read well; a bound under one second would round to "0 s", so it is given in milliseconds.
    const bound = timeoutMs < 1000 ? `${Math.round(timeoutMs)} ms` : `${Math.round(timeoutMs / 1000)} s`;
    super(`${cmd} timed out after ${bound}`);
    this.name = "RunTimeoutError";
  }
}

export function run(cmd: string, args: string[], onLine?: (line: string) => void, options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // A bounded run gets its own process group (POSIX), so the timeout can end the child and anything it started. An
    // unbounded run (the installer) stays in the caller's group, where a Ctrl-C still reaches pip.
    const bounded = options.timeoutMs !== undefined;
    const ownGroup = bounded && process.platform !== "win32";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: ownGroup });
    let err = "";
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const handle = (chunk: Buffer) => {
      if (!onLine) return;
      for (const line of chunk.toString().split(/\r?\n/)) {
        // pip output is untrusted text that ends up in the UI.
        const t = cleanLabel(line).trim();
        if (t) onLine(t);
      }
    };
    p.stdout?.on("data", handle);
    p.stderr?.on("data", (d) => {
      err = (err + d.toString()).slice(-MAX_STDERR_KEPT);
      handle(d);
    });
    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs;
      timer = setTimeout(() => {
        // The group first (the child leads it, so its id is the group id), the child alone when that is not possible.
        try {
          if (ownGroup && p.pid !== undefined) process.kill(-p.pid, "SIGKILL");
          else p.kill("SIGKILL");
        } catch {
          p.kill("SIGKILL");
        }
        // Settled here, not on `close`: a process that left the group could still hold the pipes open.
        settle(() => {
          p.stdout?.destroy();
          p.stderr?.destroy();
          reject(new RunTimeoutError(cmd, timeoutMs));
        });
      }, timeoutMs);
    }
    // `close`, not `exit`: exit can fire before the last stderr chunk has been read.
    p.on("close", (code) => {
      settle(() => {
        if (code === 0) resolve();
        else reject(new Error(clipDiagnostic(err, 800) || `${cmd} failed with exit ${code}`));
      });
    });
    p.on("error", (e) => {
      settle(() => reject(e));
    });
  });
}

export const systemHost: RuntimeHost = {
  findPython,
  searched: () => [...PYTHON_CANDIDATES, `${PATH_PYTHON_NAMES.join(", ")} on PATH`],
  exists: existsSync,
  run,
};

/** An import that takes longer than this is wedged: the check ends and answers "not installed". A cold first import is far shorter. */
const IMPORT_CHECK_TIMEOUT_MS = 60_000;

/**
 * True when the venv Python exists and can import mlx_lm: the one answer to "has /mlx-init been run". Runs only the fixed
 * command the installer already runs (`-c "import mlx_lm"`), with no user text, and never throws: any failure is false.
 */
export async function runtimeInstalled(host: RuntimeHost = systemHost): Promise<boolean> {
  try {
    if (!host.exists(VENV_PYTHON)) return false;
    await host.run(VENV_PYTHON, ["-c", "import mlx_lm"], undefined, { timeoutMs: IMPORT_CHECK_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Minor version of the venv's own interpreter, or null when it cannot be run or its output is not a Python 3 version. */
async function venvPythonMinor(host: RuntimeHost): Promise<number | null> {
  let minor: number | null = null;
  try {
    await host.run(VENV_PYTHON, ["--version"], (line) => {
      const m = line.match(/Python\s+3\.(\d+)/);
      if (m && minor === null) minor = Number(m[1]);
    });
  } catch {
    return null;
  }
  return minor;
}

/**
 * Make sure the venv with mlx-lm exists.
 * Without `upgrade`, an already-working install is left untouched (no network);
 * with it, pip and mlx-lm are always upgraded (the explicit `/mlx-init` path).
 */
export async function ensureInstalled(options: {
  upgrade?: boolean;
  onEvent?: (event: RuntimeEvent) => void;
  host?: RuntimeHost;
  /** Omitted means float to the newest mlx-lm on the default index. */
  policy?: InstallPolicy;
} = {}): Promise<void> {
  const host = options.host ?? systemHost;
  const emit = options.onEvent ?? (() => {});
  const policy = options.policy ?? { version: "latest" };
  // One element each, built from a validated value: a value can never become a second pip argument (D-18).
  const index = policy.pipIndex ?? DEFAULT_PIP_INDEX;
  const indexArg = `--index-url=${index}`;
  const mlxLmSpec = policy.version === "latest" ? MLX_LM_FLOOR : `mlx-lm==${policy.version}`;
  // What events and failures say about the index: already validated, and still cleaned and clipped (T-03-18).
  const shownIndex = clipDiagnostic(cleanLabel(index), 200, "start");

  if (!options.upgrade && (await runtimeInstalled(host))) {
    emit({ phase: "mlx-lm", state: "done", detail: "mlx-lm already installed" });
    return;
  }

  const py = host.findPython();
  if (!py) {
    const searched = host.searched?.() ?? [];
    throw new Error(
      [
        `Python 3.${MIN_PYTHON_MINOR}+ is required and no compatible interpreter was found.`,
        searched.length ? `Searched: ${searched.join(", ")}` : "",
        "Install one with: brew install python@3.13",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  emit({ phase: "python", state: "active", detail: `Using ${py}` });
  emit({ phase: "python", state: "done", detail: "Compatible Python found" });

  emit({ phase: "venv", state: "active", detail: "Checking virtual environment" });
  const onVenvLine = (line: string) => emit({ phase: "venv", state: "active", detail: cleanLabel(line) });
  if (!host.exists(VENV_PYTHON)) {
    await host.run(py, ["-m", "venv", VENV_DIR], onVenvLine);
  } else {
    // A venv built by an older interpreter keeps that interpreter; mlx-lm cannot be installed into it.
    const minor = await venvPythonMinor(host);
    if (minor !== null && minor < MIN_PYTHON_MINOR) {
      emit({
        phase: "venv",
        state: "active",
        detail: `Virtual environment uses Python 3.${minor}, older than 3.${MIN_PYTHON_MINOR}; recreating it`,
      });
      await host.run(py, ["-m", "venv", "--clear", VENV_DIR], onVenvLine);
    }
  }
  emit({ phase: "venv", state: "done", detail: "Virtual environment ready" });

  // The step keeps announcing what it does and where from while pip talks, so pip's own text never hides the index.
  const pipStep = (phase: "pip" | "mlx-lm", announcement: string) => (rawLine: string) => {
    const line = cleanLabel(rawLine);
    const m = line.match(/(\d+)%/);
    emit({ phase, state: "active", detail: `${announcement}: ${line.slice(0, 120)}`, progress: m ? Number(m[1]) / 100 : undefined });
  };

  // A failure keeps pip's own text whole (already cleaned and clipped to its last 800 characters by `run`), after a
  // prefix that says which spec and which index were being used, so a mistyped pin or an unreachable mirror reads at once.
  const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const pipAnnouncement = `Upgrading pip (index ${shownIndex})`;
  emit({ phase: "pip", state: "active", detail: pipAnnouncement });
  try {
    await host.run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "pip", indexArg], pipStep("pip", pipAnnouncement));
  } catch (error) {
    if (index === DEFAULT_PIP_INDEX) throw error;
    throw new Error(`pip could not be upgraded from ${shownIndex}: ${messageOf(error)}`);
  }
  emit({ phase: "pip", state: "done", detail: "pip upgraded" });

  const mlxLmAnnouncement = `Installing ${mlxLmSpec} (index ${shownIndex})`;
  emit({ phase: "mlx-lm", state: "active", detail: mlxLmAnnouncement });
  try {
    await host.run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", mlxLmSpec, indexArg], pipStep("mlx-lm", mlxLmAnnouncement));
  } catch (error) {
    throw new Error(`Installing ${mlxLmSpec} from ${shownIndex} failed: ${messageOf(error)}`);
  }
  emit({ phase: "mlx-lm", state: "done", detail: "mlx-lm installed" });
}

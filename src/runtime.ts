import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { VENV_DIR, VENV_PYTHON } from "./config.js";

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
  run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<void>;
}

const PYPI_INDEX = ["--index-url", "https://pypi.org/simple/"];

/** mlx-lm 0.32 requires Python 3.11+. There is deliberately no ceiling. */
const MIN_PYTHON_MINOR = 11;

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

export function pythonCandidates(_env: NodeJS.ProcessEnv = process.env, fixed: string[] = PYTHON_CANDIDATES): string[] {
  return [...fixed];
}

export function findPython(options: { candidates?: string[]; env?: NodeJS.ProcessEnv } = {}): string | null {
  for (const c of options.candidates ?? PYTHON_CANDIDATES) {
    if (probePython(c).ok) return c;
  }
  return null;
}

function run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let err = "";
    const handle = (chunk: Buffer) => {
      if (!onLine) return;
      for (const line of chunk.toString().split(/\r?\n/)) {
        const t = line.trim();
        if (t) onLine(t);
      }
    };
    p.stdout?.on("data", handle);
    p.stderr?.on("data", (d) => {
      err += d.toString();
      handle(d);
    });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-800) || `${cmd} failed with exit ${code}`))));
    p.on("error", reject);
  });
}

export const systemHost: RuntimeHost = {
  findPython,
  searched: () => [...PYTHON_CANDIDATES],
  exists: existsSync,
  run,
};

/**
 * Make sure the venv with mlx-lm exists.
 * Without `upgrade`, an already-working install is left untouched (no network);
 * with it, pip and mlx-lm are always upgraded (the explicit `/mlx-init` path).
 */
export async function ensureInstalled(options: {
  upgrade?: boolean;
  onEvent?: (event: RuntimeEvent) => void;
  host?: RuntimeHost;
} = {}): Promise<void> {
  const host = options.host ?? systemHost;
  const emit = options.onEvent ?? (() => {});

  if (!options.upgrade && host.exists(VENV_PYTHON)) {
    const importable = await host.run(VENV_PYTHON, ["-c", "import mlx_lm"]).then(
      () => true,
      () => false,
    );
    if (importable) {
      emit({ phase: "mlx-lm", state: "done", detail: "mlx-lm already installed" });
      return;
    }
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
  if (!host.exists(VENV_PYTHON)) {
    await host.run(py, ["-m", "venv", VENV_DIR], (line) => emit({ phase: "venv", state: "active", detail: line }));
  }
  emit({ phase: "venv", state: "done", detail: "Virtual environment ready" });

  const pipStep = (phase: "pip" | "mlx-lm") => (line: string) => {
    const m = line.match(/(\d+)%/);
    emit({ phase, state: "active", detail: line.slice(0, 120), progress: m ? Number(m[1]) / 100 : undefined });
  };

  emit({ phase: "pip", state: "active", detail: "Upgrading pip" });
  await host.run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "pip", ...PYPI_INDEX], pipStep("pip"));
  emit({ phase: "pip", state: "done", detail: "pip upgraded" });

  emit({ phase: "mlx-lm", state: "active", detail: "Installing mlx-lm" });
  await host.run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "mlx-lm>=0.24.0", ...PYPI_INDEX], pipStep("mlx-lm"));
  emit({ phase: "mlx-lm", state: "done", detail: "mlx-lm installed" });
}

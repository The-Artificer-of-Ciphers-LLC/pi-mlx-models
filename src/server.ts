import { spawn } from "node:child_process";
import { BASE_URL, HF_HOME, HOST, PORT, VENV_PYTHON } from "./config.js";

export type ServerEvent =
  | { type: "launched" }
  | { type: "starting" }
  | { type: "downloading"; done?: number; total?: number; progress?: number }
  | { type: "loading" }
  | { type: "warming" }
  | { type: "ready" }
  /** The current server process died on its own (not via stop() or a restart). */
  | { type: "exited" };

export interface ServerProcess {
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

/** The machine-facing seam: real child/fetch/timers in production, fakes in tests. */
export interface ServerHost {
  spawn(model: string): ServerProcess;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
}

export interface MlxServer {
  readonly running: boolean;
  /** Start (or restart) the server on `model` and resolve once it answers a completion. Rejects if the process dies first. */
  start(model: string, onEvent?: (event: ServerEvent) => void): Promise<void>;
  stop(): void;
}

const systemHost: ServerHost = {
  spawn: (model) =>
    spawn(VENV_PYTHON, ["-m", "mlx_lm.server", "--model", model, "--host", HOST, "--port", String(PORT)], {
      env: { ...process.env, HF_HOME, TRANSFORMERS_CACHE: HF_HOME, HF_HUB_DISABLE_TELEMETRY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export function createMlxServer(
  options: {
    host?: ServerHost;
    baseUrl?: string;
    healthTimeoutMs?: number;
    warmupTimeoutMs?: number;
    healthPollMs?: number;
    warmupPollMs?: number;
    killWaitMs?: number;
  } = {},
): MlxServer {
  const host = options.host ?? systemHost;
  const baseUrl = options.baseUrl ?? BASE_URL;
  const healthTimeoutMs = options.healthTimeoutMs ?? 600_000;
  const warmupTimeoutMs = options.warmupTimeoutMs ?? 1_800_000;
  const healthPollMs = options.healthPollMs ?? 1200;
  const warmupPollMs = options.warmupPollMs ?? 1500;
  const killWaitMs = options.killWaitMs ?? 5000;

  type Current = { proc: ServerProcess; exited: boolean; exitCode: number | null; stderrTail: string; onExit: Promise<void> };
  let current: Current | null = null;

  const describeDeath = (c: Current) =>
    `MLX server exited (code ${c.exitCode ?? "unknown"})${c.stderrTail.trim() ? `: ${c.stderrTail.trim().slice(-400)}` : ""}`;

  /** Throws when `c` died or was replaced/stopped while a start was waiting on it. */
  const assertAlive = (c: Current) => {
    if (c.exited) throw new Error(describeDeath(c));
    if (current !== c) throw new Error("MLX server start was cancelled");
  };

  const parseStderr = (text: string, emit: (event: ServerEvent) => void) => {
    const fetchMatch = text.match(/Fetching\s+(\d+)\s+files?:\s+(\d+)%.*?(\d+)\/(\d+)/);
    if (fetchMatch) {
      emit({ type: "downloading", progress: Number(fetchMatch[2]) / 100, done: Number(fetchMatch[3]), total: Number(fetchMatch[4]) });
    } else if (text.includes("Fetching") || text.includes("Downloading")) {
      emit({ type: "downloading" });
    } else if (text.toLowerCase().includes("starting") || text.includes("httpd")) {
      emit({ type: "starting" });
    }
  };

  async function waitForServer(c: Current) {
    const start = Date.now();
    while (Date.now() - start < healthTimeoutMs) {
      assertAlive(c);
      try {
        const res = await host.fetch(`${baseUrl}/models`);
        if (res.ok) return;
      } catch {
        // retry
      }
      await host.sleep(healthPollMs);
    }
    assertAlive(c);
    throw new Error("Local MLX server did not become healthy in time");
  }

  async function waitForInferenceReady(c: Current, model: string) {
    const start = Date.now();
    while (Date.now() - start < warmupTimeoutMs) {
      assertAlive(c);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120_000);
        const res = await host
          .fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: "Reply with: ok" }],
              max_tokens: 2,
              stream: false,
              temperature: 0,
            }),
            signal: controller.signal,
          })
          .finally(() => clearTimeout(timer));
        if (res.ok) return;
      } catch {
        // still loading/downloading
      }
      await host.sleep(warmupPollMs);
    }
    assertAlive(c);
    throw new Error("Model did not become inference-ready in time");
  }

  const stop = () => {
    const c = current;
    current = null;
    if (c && !c.exited) c.proc.kill("SIGTERM");
  };

  return {
    get running() {
      return current != null && !current.exited;
    },
    stop,
    async start(model, onEvent) {
      const emit = onEvent ?? (() => {});

      const previous = current;
      if (previous) {
        stop();
        await Promise.race([previous.onExit, host.sleep(killWaitMs)]);
      }

      const proc = host.spawn(model);
      let resolveExit!: () => void;
      const c: Current = {
        proc,
        exited: false,
        exitCode: null,
        stderrTail: "",
        onExit: new Promise<void>((r) => (resolveExit = r)),
      };
      current = c;

      proc.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        c.stderrTail = (c.stderrTail + text).slice(-800);
        if (current === c) parseStderr(text, emit);
      });
      proc.on("exit", (code) => {
        c.exited = true;
        c.exitCode = code;
        resolveExit();
        // A replaced or stopped process must not clobber its successor.
        if (current === c) {
          current = null;
          emit({ type: "exited" });
        }
      });

      emit({ type: "launched" });
      await waitForServer(c);
      emit({ type: "loading" });
      emit({ type: "warming" });
      await waitForInferenceReady(c, model);
      emit({ type: "ready" });
    },
  };
}

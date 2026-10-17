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

/** Where the server listens. Single-sourced from createMlxServer so the spawn and the probes agree. */
export interface ServerAddress {
  host: string;
  port: number;
}

/** The machine-facing seam: real child/fetch/timers in production, fakes in tests. */
export interface ServerHost {
  spawn(model: string, address: ServerAddress): ServerProcess;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
}

export interface MlxServer {
  readonly running: boolean;
  /** Start (or restart) the server on `model` and resolve once it answers a completion. Rejects if the process dies first. */
  start(model: string, onEvent?: (event: ServerEvent) => void): Promise<void>;
  /** Stop the server. Resolves (never rejects) once the child has exited; SIGKILL follows SIGTERM after `killWaitMs`. */
  stop(): Promise<void>;
}

export interface SystemHostOptions {
  /** Executable to spawn. Defaults to the venv python. */
  command?: string;
  /** argv for the command. Defaults to the module-form `python -m mlx_lm.server` launch. */
  buildArgs?: (model: string, address: ServerAddress) => string[];
  /** Extra environment, merged last so it wins over the defaults. */
  env?: NodeJS.ProcessEnv;
}

const moduleArgs = (model: string, address: ServerAddress) => [
  "-m",
  "mlx_lm.server",
  "--model",
  model,
  "--host",
  address.host,
  "--port",
  String(address.port),
];

/** The real child/fetch/timer host. Tests point `command`/`buildArgs` at a stub process. */
export function createSystemHost(options: SystemHostOptions = {}): ServerHost {
  const command = options.command ?? VENV_PYTHON;
  const buildArgs = options.buildArgs ?? moduleArgs;
  return {
    spawn: (model, address) =>
      spawn(command, buildArgs(model, address), {
        env: { ...process.env, HF_HOME, TRANSFORMERS_CACHE: HF_HOME, HF_HUB_DISABLE_TELEMETRY: "1", ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

const systemHost = createSystemHost();

export function createMlxServer(
  options: {
    host?: ServerHost;
    address?: ServerAddress;
    baseUrl?: string;
    healthTimeoutMs?: number;
    warmupTimeoutMs?: number;
    healthPollMs?: number;
    warmupPollMs?: number;
    killWaitMs?: number;
  } = {},
): MlxServer {
  const host = options.host ?? systemHost;
  const address = options.address ?? { host: HOST, port: PORT };
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

  /** SIGTERM, then SIGKILL after `killWaitMs`, each followed by a bounded wait for the exit event. Never rejects. */
  const terminate = async (c: Current): Promise<void> => {
    if (c.exited) return;
    c.proc.kill("SIGTERM");
    await Promise.race([c.onExit, host.sleep(killWaitMs)]);
    if (c.exited) return;
    c.proc.kill("SIGKILL");
    await Promise.race([c.onExit, host.sleep(killWaitMs)]);
  };

  /** The in-flight stop, so a start (or a second stop) issued mid-stop waits for the same process to be gone. */
  let pendingStop: Promise<void> | null = null;

  const stop = (): Promise<void> => {
    const c = current;
    // Clear synchronously: a start that is still waiting on `c` must see "cancelled" right away.
    current = null;
    if (!c) return pendingStop ?? Promise.resolve();
    const stopping: Promise<void> = terminate(c).finally(() => {
      if (pendingStop === stopping) pendingStop = null;
    });
    pendingStop = stopping;
    return stopping;
  };

  return {
    get running() {
      return current != null && !current.exited;
    },
    stop,
    async start(model, onEvent) {
      const emit = onEvent ?? (() => {});

      // Never spawn while the old process might still hold the port (D-05).
      if (current || pendingStop) await stop();

      const proc = host.spawn(model, address);
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

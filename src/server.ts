import { spawn } from "node:child_process";
import { BASE_URL, HF_HOME, HOST, PORT, VENV_PYTHON } from "./config.js";
import { probePort, waitForPortFree } from "./port.js";

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
  /** True when something already holds host:port (a connect or an exclusive bind says so). */
  portInUse(host: string, port: number): Promise<boolean>;
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
    portInUse: probePort,
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
    /** How long stop() waits for the port to refuse connections once the child has exited. */
    portReleaseTimeoutMs?: number;
    portPollMs?: number;
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
  const portReleaseTimeoutMs = options.portReleaseTimeoutMs ?? 10_000;
  const portPollMs = options.portPollMs ?? 200;

  type Current = {
    proc: ServerProcess;
    exited: boolean;
    exitCode: number | null;
    stderrTail: string;
    onExit: Promise<void>;
    /** Set when stderr reported an address-in-use bind failure; the process is then being terminated. */
    fatal?: string;
  };
  let current: Current | null = null;

  /**
   * mlx_lm.server stays alive after it fails to bind (the OSError ends the main thread but a
   * non-daemon worker thread keeps the interpreter running), so liveness alone cannot catch a
   * bind conflict. The message is matched against the rolling stderr tail so a split line is caught.
   */
  const BIND_FAILURE = /Address already in use|Errno (?:48|98)\b/;

  const describeDeath = (c: Current) =>
    `MLX server exited (code ${c.exitCode ?? "unknown"})${c.stderrTail.trim() ? `: ${c.stderrTail.trim().slice(-400)}` : ""}`;

  /** Throws when `c` failed to bind, died, or was replaced/stopped while a start was waiting on it. */
  const assertAlive = (c: Current) => {
    if (c.fatal) throw new Error(c.fatal);
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
      let ok = false;
      try {
        const res = await host.fetch(`${baseUrl}/models`);
        ok = res.ok;
      } catch {
        // retry
      }
      // A response only counts while the process we spawned is still alive: an old listener
      // on the port can keep answering after the new process died (D-06).
      assertAlive(c);
      if (ok) return;
      await host.sleep(healthPollMs);
    }
    assertAlive(c);
    throw new Error("Local MLX server did not become healthy in time");
  }

  async function waitForInferenceReady(c: Current, model: string) {
    const start = Date.now();
    while (Date.now() - start < warmupTimeoutMs) {
      assertAlive(c);
      let ok = false;
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
        ok = res.ok;
      } catch {
        // still loading/downloading
      }
      assertAlive(c); // same rule as the health check: never ready on a dead process's say-so
      if (ok) return;
      await host.sleep(warmupPollMs);
    }
    assertAlive(c);
    throw new Error("Model did not become inference-ready in time");
  }

  /** Wait up to `killWaitMs` for a SIGTERMed child to exit; if it does not, SIGKILL it and wait once more. */
  const awaitExit = async (c: Current): Promise<void> => {
    await Promise.race([c.onExit, host.sleep(killWaitMs)]);
    if (c.exited) return;
    c.proc.kill("SIGKILL");
    await Promise.race([c.onExit, host.sleep(killWaitMs)]);
  };

  /**
   * SIGTERM, then SIGKILL after `killWaitMs`, each followed by a bounded wait for the exit
   * event; once the child is gone, a bounded wait for the port to refuse connections. Never rejects.
   */
  const terminate = async (c: Current): Promise<void> => {
    if (!c.exited) {
      c.proc.kill("SIGTERM");
      await awaitExit(c);
    }
    // A child that survived SIGKILL still holds the port; there is nothing more to wait for.
    if (!c.exited) return;
    await waitForPortFree({
      host: address.host,
      port: address.port,
      probe: host.portInUse,
      sleep: host.sleep,
      timeoutMs: portReleaseTimeoutMs,
      pollMs: portPollMs,
    });
  };

  /** Bumped by every stop(), so a start still waiting on a probe can tell it was cancelled. */
  let generation = 0;

  /** The in-flight stop, so a start (or a second stop) issued mid-stop waits for the same process to be gone. */
  let pendingStop: Promise<void> | null = null;

  const stop = (): Promise<void> => {
    const c = current;
    // Clear synchronously: a start that is still waiting on `c` must see "cancelled" right away.
    current = null;
    generation += 1;
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
      const hadPrevious = current !== null || pendingStop !== null;
      const stopped = stop();
      if (hadPrevious) await stopped;
      const myGeneration = generation;

      // Ownership check (D-04): refuse an occupied port before anything is spawned.
      const inUse = await host.portInUse(address.host, address.port);
      if (generation !== myGeneration) throw new Error("MLX server start was cancelled");
      if (inUse) {
        throw new Error(
          hadPrevious
            ? `Port ${address.port} is still in use after stopping the previous MLX server. Retry in a moment, or set PI_MLX_MODELS_PORT to use a different port.`
            : `Port ${address.port} on ${address.host} is already in use by another process. Set PI_MLX_MODELS_PORT to a free port, or find what holds it with: lsof -nP -iTCP:${address.port} -sTCP:LISTEN`,
        );
      }

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
        if (current === c && !c.fatal && BIND_FAILURE.test(c.stderrTail)) {
          // The message deliberately omits the raw stderr text.
          c.fatal = `Port ${address.port} on ${address.host} is already in use, so the MLX server could not bind it. Set PI_MLX_MODELS_PORT to use a different port.`;
          c.proc.kill("SIGTERM");
        }
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
      try {
        await waitForServer(c);
        emit({ type: "loading" });
        emit({ type: "warming" });
        await waitForInferenceReady(c, model);
        emit({ type: "ready" });
      } catch (error) {
        // A bind failure leaves the real server alive; make sure it is gone (and has said so) before reporting.
        if (c.fatal && !c.exited) await awaitExit(c);
        throw error;
      }
    },
  };
}

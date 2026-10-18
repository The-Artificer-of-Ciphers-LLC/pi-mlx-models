import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiHost } from "./index.js";

/**
 * Shared helpers for tests that need a real child process standing in for
 * `mlx_lm.server`. Excluded from the production build (see tsconfig.json) and
 * never published.
 *
 * Compiled test files live flat in `.test-dist/`, so the relative hop below
 * lands on the repo-root `test/fixtures` directory.
 */
export const STUB_SERVER_PATH = fileURLToPath(new URL("../test/fixtures/stub-mlx-server.mjs", import.meta.url));

export type StubMode = "ok" | "flood" | "exit-early" | "bind-hang" | "warmup-400" | "hang" | "ignore-term";

/** Local address shape; deliberately not imported from server.ts. */
export interface StubAddress {
  host: string;
  port: number;
}

/** Ask the OS for a free loopback port, then release it. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not read the assigned port"));
        return;
      }
      const { port } = address;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** True when a TCP connect to the loopback port is refused. */
export function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

/** argv for the stub, mirroring the real server's --model/--host/--port flags; `extraArgs` are appended last. */
export function stubArgs(model: string, address: StubAddress, extraArgs: readonly string[] = []): string[] {
  return [STUB_SERVER_PATH, "--model", model, "--host", address.host, "--port", String(address.port), ...extraArgs];
}

type Handler = (args: string, ctx: any) => Promise<void>;
/** A handler registered with `pi.on`: session_shutdown takes nothing, before_provider_request takes an event and a context. */
export type HookHandler = (event?: any, ctx?: any) => unknown;
export type ProviderCall = { name: string; config: any };
export type Note = { message: string; type: string };
export type FlagRegistration = { name: string; options: { description?: string; type: "boolean" | "string"; default?: boolean | string } };

/**
 * A fake pi that records what the extension registers, so tests can drive the handlers directly.
 * Flags are recorded as registered (`flags`), set from the test with `setFlag` (undefined clears one) and
 * counted when read (`getFlagCalls`). Like pi, a registered default is written into the flag values at
 * registration, which is why the extension must never pass one.
 */
export function makeFakePi() {
  const commands = new Map<string, Handler>();
  const handlers = new Map<string, HookHandler>();
  const providerCalls: ProviderCall[] = [];
  const flags: FlagRegistration[] = [];
  const flagValues = new Map<string, boolean | string>();
  let getFlagCalls = 0;
  const pi: PiHost = {
    registerCommand(name, options) {
      commands.set(name, options.handler);
    },
    registerProvider(name, config) {
      providerCalls.push({ name, config });
    },
    registerFlag(name, options) {
      flags.push({ name, options });
      if (options.default !== undefined) flagValues.set(name, options.default);
    },
    getFlag(name) {
      getFlagCalls += 1;
      return flagValues.get(name);
    },
    // Explicit parameter types: PiHost.on is overloaded, so an object-literal method gets no contextual types.
    on(event: string, handler: HookHandler) {
      handlers.set(event, handler);
    },
  };
  return {
    pi,
    commands,
    handlers,
    providerCalls,
    flags,
    setFlag(name: string, value: boolean | string | undefined) {
      if (value === undefined) flagValues.delete(name);
      else flagValues.set(name, value);
    },
    getFlagCalls: () => getFlagCalls,
  };
}

export interface CtxOptions {
  /** The command's working directory; default is a fresh temporary directory. */
  cwd?: string;
  /** Whether an interactive UI is attached; default true. */
  hasUI?: boolean;
  /** The answer ui.confirm gives; default true. */
  confirm?: boolean;
}

/** A fake ctx.ui; `select` decides what the picker returns (default: the first option). */
export function makeCtx(
  select: (options: string[]) => string | undefined = (options) => options[0],
  options: CtxOptions = {},
) {
  const notes: Note[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const widgets: Array<{ id: string; lines: string[] | undefined }> = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const ctx = {
    cwd: options.cwd ?? mkdtempSync(join(tmpdir(), "pi-mlx-ctx-")),
    hasUI: options.hasUI ?? true,
    ui: {
      notify(message: string, type: string) {
        notes.push({ message, type });
      },
      async select(_title: string, choices: string[]) {
        return select(choices);
      },
      async confirm(title: string, message: string) {
        confirms.push({ title, message });
        return options.confirm ?? true;
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
      setWidget(id: string, lines: string[] | undefined) {
        widgets.push({ id, lines });
      },
    },
  };
  return { ctx, notes, statuses, widgets, confirms };
}

export interface SpawnStubOptions {
  mode: StubMode | (string & {});
  port: number;
  host?: string;
  model?: string;
  env?: Record<string, string>;
  stdio?: StdioOptions;
}

/** Spawn the stub under the current Node binary. */
export function spawnStub(options: SpawnStubOptions): ChildProcess {
  const { mode, port, host = "127.0.0.1", model = "stub/model", env = {}, stdio = ["ignore", "pipe", "pipe"] } = options;
  return spawn(process.execPath, stubArgs(model, { host, port }), {
    env: { ...process.env, ...env, STUB_MODE: mode },
    stdio,
  });
}

export interface WaitForHttpOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/** Poll until any HTTP response arrives; reject at the deadline. */
export async function waitForHttp(url: string, options: WaitForHttpOptions = {}): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 25 } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      await res.arrayBuffer().catch(() => undefined);
      return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`no HTTP response from ${url} within ${timeoutMs} ms: ${String(lastError)}`);
}

/** Resolve with the exit code/signal once the child has exited. */
export function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

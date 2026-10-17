import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

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

/** argv for the stub, mirroring the real server's --model/--host/--port flags. */
export function stubArgs(model: string, address: StubAddress): string[] {
  return [STUB_SERVER_PATH, "--model", model, "--host", address.host, "--port", String(address.port)];
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

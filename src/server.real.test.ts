import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import type { ChildProcess } from "node:child_process";
import { createMlxServer, createSystemHost, type ServerHost } from "./server.js";
import { freePort, stubArgs } from "./testkit.js";

/**
 * Real-process lifecycle tests: a real child (the stub from test/fixtures),
 * real sockets and real fetch. Ports always come from freePort(); nothing here
 * depends on the default port being free.
 */

/** A system host running the stub, remembering every child it spawns. */
function stubHost(env: Record<string, string>) {
  const base = createSystemHost({ command: process.execPath, buildArgs: stubArgs, env });
  const children: ChildProcess[] = [];
  const host: ServerHost = {
    ...base,
    spawn: (model, address) => {
      const child = base.spawn(model, address) as ChildProcess;
      children.push(child);
      return child;
    },
  };
  return { host, children };
}

function killAll(children: ChildProcess[]) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

/** True when a TCP connect to the loopback port is refused. */
function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

test("start reaches ready against the stub process and stop resolves only after the child has exited", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const { host, children } = stubHost({ STUB_MODE: "ok" });
  t.after(() => killAll(children));

  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthPollMs: 25,
    warmupPollMs: 25,
  });

  await server.start("stub/model");
  assert.equal(server.running, true);
  assert.equal(children.length, 1);

  await server.stop();

  assert.equal(server.running, false);
  const child = children[0];
  assert.ok(child.exitCode !== null || child.signalCode !== null, "the child must have exited before stop() resolved");
  assert.equal(await connectRefused(port), true, "the port must refuse connections after stop()");
});

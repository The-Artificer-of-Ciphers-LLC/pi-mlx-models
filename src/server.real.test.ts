import test from "node:test";
import assert from "node:assert/strict";
import { createConnection, createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { ChildProcess } from "node:child_process";
import { createMlxServer, createSystemHost, type ServerHost } from "./server.js";
import { freePort, stubArgs, waitForExit } from "./testkit.js";

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
    // The kill-wait timer outlives stop() by its full length, so keep it short in tests.
    killWaitMs: 1000,
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

test("a restart waits for the old stub to exit and release the port, then serves from a new process", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const { host, children } = stubHost({ STUB_MODE: "ok" });
  t.after(() => killAll(children));

  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthPollMs: 25,
    warmupPollMs: 25,
    killWaitMs: 1000,
  });

  await server.start("stub/first");
  await server.start("stub/second");

  assert.equal(children.length, 2);
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null, "the first child must be gone");
  assert.equal(children[1].exitCode, null, "the second child must be alive");
  assert.equal(children[1].signalCode, null);
  assert.equal(server.running, true);

  await server.stop();
});

test("start refuses a port held by a real listener, naming the port, and never spawns the stub", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const occupant: Server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    occupant.once("error", reject);
    occupant.listen(port, "127.0.0.1", () => resolve());
  });
  const { host, children } = stubHost({ STUB_MODE: "ok" });
  t.after(() => {
    killAll(children);
    occupant.close();
  });

  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthPollMs: 25,
    warmupPollMs: 25,
  });

  await assert.rejects(server.start("stub/model"), (err: Error) => {
    assert.ok(err.message.includes(String(port)), `message should name port ${port}: ${err.message}`);
    assert.match(err.message, /PI_MLX_MODELS_PORT/);
    return true;
  });
  assert.equal(children.length, 0, "the stub must never be spawned");
  assert.equal(server.running, false);
});

// Models a squatter that appears between the probe and the bind: the pre-spawn probe is
// forced to say "free", the stub then fails to bind (and, like the real server, stays alive),
// and the squatter keeps answering /v1/models. The extension must not believe that answer.
test("a squatter answering /v1/models cannot make a stub that failed to bind look ready", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const squatter = createHttpServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "squatter", object: "model" }] }));
    }, 600);
  });
  await new Promise<void>((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(port, "127.0.0.1", () => resolve());
  });
  const { host: stubbed, children } = stubHost({ STUB_MODE: "bind-hang" });
  const host: ServerHost = { ...stubbed, portInUse: async () => false };
  t.after(() => {
    killAll(children);
    squatter.closeAllConnections();
    squatter.close();
  });

  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthPollMs: 25,
    warmupPollMs: 25,
  });
  const events: string[] = [];

  const startedAt = Date.now();
  await assert.rejects(server.start("stub/model", (e) => events.push(e.type)), (err: Error) => {
    assert.ok(err.message.includes(String(port)), `message should name port ${port}: ${err.message}`);
    assert.match(err.message, /PI_MLX_MODELS_PORT/);
    return true;
  });
  assert.ok(Date.now() - startedAt < 10_000, "the failure must surface promptly");
  assert.ok(!events.includes("ready"), "ready must never be emitted");

  assert.equal(children.length, 1);
  const exit = await Promise.race([
    waitForExit(children[0]),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  assert.notEqual(exit, null, "the stub that failed to bind must be terminated within 5 seconds");
  assert.equal(server.running, false);
});

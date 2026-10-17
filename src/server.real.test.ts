import test from "node:test";
import assert from "node:assert/strict";
import { createConnection, createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// WR-02 (round 2): a spawn failure arrives only as an 'error' event, which would crash the host if unhandled.
test("a missing server command fails the start at once with a clear message and leaves running false", async () => {
  const port = await freePort();
  const missing = join(tmpdir(), `pi-mlx-missing-command-${process.pid}-${port}`);
  const host = createSystemHost({ command: missing, buildArgs: stubArgs });
  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthPollMs: 25,
    warmupPollMs: 25,
  });

  await assert.rejects(server.start("stub/model"), /Could not launch the MLX server: .*ENOENT/);

  assert.equal(server.running, false);
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
    killWaitMs: 1000,
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

// The stub writes megabytes to stdout before it listens (the real server logs heavily at startup).
// A launcher that never reads stdout blocks it once the pipe fills, so reaching ready proves the
// drain. If the drain is removed this test fails by its own timeout rather than passing.
test("a server that floods stdout still reaches ready", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const { host, children } = stubHost({ STUB_MODE: "flood" });
  t.after(() => killAll(children));

  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthPollMs: 25,
    warmupPollMs: 25,
    killWaitMs: 1000,
  });

  await server.start("stub/model");
  assert.equal(server.running, true);

  await server.stop();
});

test("an early exit reports the stderr tail and the stdout tail", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const { host, children } = stubHost({ STUB_MODE: "exit-early" });
  t.after(() => killAll(children));

  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthPollMs: 25,
    warmupPollMs: 25,
    killWaitMs: 1000,
  });

  await assert.rejects(server.start("stub/model"), (err: Error) => {
    assert.match(err.message, /exited \(code 3\).*ModuleNotFoundError.*stub: starting up/s);
    assert.ok(
      err.message.indexOf("ModuleNotFoundError") < err.message.indexOf("stub: starting up"),
      `the stderr part must come before the stdout part: ${err.message}`,
    );
    return true;
  });
  assert.equal(server.running, false);
});

test("a warm-up answered with HTTP 400 fails within seconds showing the server's message", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const { host, children } = stubHost({ STUB_MODE: "warmup-400" });
  t.after(() => killAll(children));

  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthPollMs: 25,
    warmupPollMs: 25,
    killWaitMs: 1000,
  });

  const startedAt = Date.now();
  await assert.rejects(server.start("stub/model"), (err: Error) => {
    assert.match(err.message, /HTTP 400/);
    assert.match(err.message, /stub: unsupported request/);
    return true;
  });
  assert.ok(Date.now() - startedAt < 5000, "a 4xx warm-up must fail fast instead of polling");
  assert.equal(server.running, false);
  assert.ok(
    children[0].exitCode !== null || children[0].signalCode !== null,
    "the failed start must have stopped the stub it spawned",
  );
});

test("a long warm-up error body from the server is truncated to 400 characters", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const { host, children } = stubHost({ STUB_MODE: "warmup-400", STUB_ERROR_PAD: "2000" });
  t.after(() => killAll(children));

  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthPollMs: 25,
    warmupPollMs: 25,
    killWaitMs: 1000,
  });

  await assert.rejects(server.start("stub/model"), (err: Error) => {
    const body = /^Warm-up request failed \(HTTP 400\): ([\s\S]*)$/.exec(err.message)?.[1];
    assert.ok(body, `message should carry a body: ${err.message}`);
    assert.ok(body.length <= 400, `body portion is ${body.length} characters`);
    return true;
  });
});

// The health request timeout is the owner-confirmed 10 second value, so this waits it out once.
// A listener that accepts connections and never answers must see its request aborted by the
// per-request signal, and the poll loop must keep going afterwards (an abort is not fatal).
test("a listener that never answers is cut off by the per-request health timeout", { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const { host: stubbed, children } = stubHost({ STUB_MODE: "hang" });
  t.after(() => killAll(children));

  let firstAbort!: (outcome: { ms: number; name: string }) => void;
  const aborted = new Promise<{ ms: number; name: string }>((resolve) => (firstAbort = resolve));
  let requests = 0;
  const host: ServerHost = {
    ...stubbed,
    fetch: async (input, init) => {
      requests += 1;
      const startedAt = Date.now();
      try {
        return await stubbed.fetch(input, init);
      } catch (err) {
        // Refused connections while the stub boots are expected; only the abort is the outcome.
        if (err instanceof Error && err.name === "TimeoutError") firstAbort({ ms: Date.now() - startedAt, name: err.name });
        throw err;
      }
    },
  };

  const server = createMlxServer({
    host,
    address: { host: "127.0.0.1", port },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthRequestTimeoutMs: 10000,
    healthPollMs: 25,
    warmupPollMs: 25,
    killWaitMs: 1000,
  });

  // Observe the outcome from the start so the later cancellation is never an unhandled rejection.
  const startOutcome = server.start("stub/model").then(
    () => undefined,
    (err: Error) => err,
  );
  const outcome = await aborted;
  assert.equal(outcome.name, "TimeoutError");
  assert.ok(outcome.ms >= 9000 && outcome.ms < 15000, `the request should be aborted by its own signal after about 10 s, took ${outcome.ms} ms`);

  await server.stop();
  const failure = await startOutcome;
  assert.match(String(failure?.message), /cancelled/);
  assert.ok(requests >= 1);
});

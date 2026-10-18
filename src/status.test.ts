import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { classifyHealth, createHealthProbe, formatStatus, type HealthProbe, type StatusView } from "./status.js";
import { freePort } from "./testkit.js";

/**
 * The probe runs over real loopback listeners (never a mock of the network): node:http for an answering server and
 * node:net for one that accepts and stays silent. Ports come from the OS and every listener is closed in t.after.
 */

async function listenHttp(t: TestContext, ids: string[]): Promise<number> {
  const server = createHttpServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return address.port;
}

async function listenSilent(t: TestContext): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return address.port;
}

const baseUrlOf = (port: number) => `http://127.0.0.1:${port}/v1`;

test("createHealthProbe: a real listener that serves one model accepts and answers", { timeout: 20_000 }, async (t) => {
  const port = await listenHttp(t, ["m"]);
  const probe = await createHealthProbe()({ host: "127.0.0.1", port }, baseUrlOf(port));
  assert.deepEqual(probe, { accepts: true, models: { answers: true, ids: ["m"] } });
});

test("createHealthProbe: with nothing listening it does not accept and makes no models request", { timeout: 20_000 }, async () => {
  const port = await freePort();
  let modelsCalls = 0;
  const probe = await createHealthProbe({
    models: async () => {
      modelsCalls += 1;
      return { answers: true, ids: [] };
    },
  })({ host: "127.0.0.1", port }, baseUrlOf(port));
  assert.deepEqual(probe, { accepts: false, models: { answers: false } });
  assert.equal(modelsCalls, 0, "no HTTP request when the connect is refused");
});

test("createHealthProbe: a listener that accepts and never replies accepts but does not answer, promptly", { timeout: 20_000 }, async (t) => {
  const port = await listenSilent(t);
  const startedAt = Date.now();
  const probe = await createHealthProbe({ timeoutMs: 300 })({ host: "127.0.0.1", port }, baseUrlOf(port));
  assert.deepEqual(probe, { accepts: true, models: { answers: false } });
  assert.ok(Date.now() - startedAt < 3000, "the bound must apply to a server that never answers");
});

test("createHealthProbe: the connect goes to the loopback for a wildcard host and the models call gets the base URL and the bound", async () => {
  const connects: Array<[string, number]> = [];
  const asked: Array<{ baseUrl: string; timeoutMs: number }> = [];
  const probe = await createHealthProbe({
    connect: async (host, port) => {
      connects.push([host, port]);
      return true;
    },
    models: async (options) => {
      asked.push(options);
      return { answers: true, ids: ["z"] };
    },
    timeoutMs: 123,
  })({ host: "0.0.0.0", port: 4321 }, "http://0.0.0.0:4321/v1");
  assert.deepEqual(connects, [["127.0.0.1", 4321]]);
  assert.deepEqual(asked, [{ baseUrl: "http://0.0.0.0:4321/v1", timeoutMs: 123 }]);
  assert.deepEqual(probe, { accepts: true, models: { answers: true, ids: ["z"] } });
});

test("createHealthProbe: tracer - a real listener is ready and its status block names the address, the id and who started it", { timeout: 20_000 }, async (t) => {
  const port = await listenHttp(t, ["m"]);
  const address = { host: "127.0.0.1", port };
  const probe: HealthProbe = await createHealthProbe()(address, baseUrlOf(port));
  const health = classifyHealth("none", probe);
  assert.equal(health, "ready");
  const view: StatusView = { health, address, session: "none", served: probe.models.answers ? probe.models.ids : [] };
  const text = formatStatus(view);
  assert.match(text, /ready/);
  assert.ok(text.includes(`127.0.0.1:${port}`), text);
  assert.ok(text.includes("m"), text);
  assert.match(text, /not started by this session/);
});

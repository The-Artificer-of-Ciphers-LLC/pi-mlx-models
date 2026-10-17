import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DISCOVERY_TIMEOUT_MS, discoverModelIds } from "./discovery.js";
import { freePort } from "./testkit.js";

/**
 * Real http servers on a loopback port picked by the OS: the timeout and error paths run
 * through the real fetch, never a mock of it.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(t: TestContext, handler: Handler): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "the server must report a port");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server };
}

const json = (status: number, body: string): Handler => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
};

test("returns the model ids from a 200 response and drops entries without an id", { timeout: 20_000 }, async (t) => {
  const { baseUrl } = await listen(t, json(200, JSON.stringify({ data: [{ id: "a" }, { id: "b" }, {}] })));
  assert.deepEqual(await discoverModelIds({ baseUrl }), ["a", "b"]);
});

test("requests exactly <baseUrl>/models", { timeout: 20_000 }, async (t) => {
  const seen: Array<{ method?: string; url?: string }> = [];
  const { baseUrl } = await listen(t, (req, res) => {
    seen.push({ method: req.method, url: req.url });
    json(200, JSON.stringify({ data: [] }))(req, res);
  });

  await discoverModelIds({ baseUrl });

  assert.deepEqual(seen, [{ method: "GET", url: "/v1/models" }]);
});

test("a non-200 response returns an empty list", { timeout: 20_000 }, async (t) => {
  const { baseUrl } = await listen(t, json(503, JSON.stringify({ data: [{ id: "a" }] })));
  assert.deepEqual(await discoverModelIds({ baseUrl }), []);
});

test("a 200 response with invalid JSON returns an empty list", { timeout: 20_000 }, async (t) => {
  const { baseUrl } = await listen(t, json(200, "not json at all"));
  assert.deepEqual(await discoverModelIds({ baseUrl }), []);
});

test("a 200 response of the wrong shape returns an empty list", { timeout: 20_000 }, async (t) => {
  const { baseUrl } = await listen(t, json(200, JSON.stringify({ data: "nope" })));
  assert.deepEqual(await discoverModelIds({ baseUrl }), []);
});

test("a server that accepts the connection and never answers returns an empty list at the timeout", { timeout: 20_000 }, async (t) => {
  const { baseUrl } = await listen(t, () => {});

  const startedAt = Date.now();
  const ids = await discoverModelIds({ baseUrl, timeoutMs: 500 });

  assert.deepEqual(ids, []);
  assert.ok(Date.now() - startedAt < 2000, "the request must be aborted by its own timeout");
});

test("a server that stalls after part of the body returns an empty list at the timeout", { timeout: 20_000 }, async (t) => {
  const { baseUrl } = await listen(t, (_req, res) => {
    // Status, headers and the start of the body arrive; the rest never does.
    res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
    res.write('{"data":[{"id":"a"},');
  });

  const startedAt = Date.now();
  const ids = await discoverModelIds({ baseUrl, timeoutMs: 500 });

  assert.deepEqual(ids, []);
  assert.ok(Date.now() - startedAt < 2000, "the timeout must cover the body read");
});

test("a closed port (connection refused) returns an empty list", { timeout: 20_000 }, async () => {
  const port = await freePort();
  assert.deepEqual(await discoverModelIds({ baseUrl: `http://127.0.0.1:${port}/v1` }), []);
});

test("DISCOVERY_TIMEOUT_MS is the five second bound", () => {
  assert.equal(DISCOVERY_TIMEOUT_MS, 5000);
});

test("without a timeout option the default bound applies to a server that never answers", { timeout: 20_000 }, async (t) => {
  const { baseUrl } = await listen(t, () => {});

  const startedAt = Date.now();
  const ids = await discoverModelIds({ baseUrl });
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(ids, []);
  assert.ok(elapsed >= 4500 && elapsed < 8000, `the default bound is five seconds, took ${elapsed} ms`);
});

test("uses an injected fetch and hands it one abort signal", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const ids = await discoverModelIds({
    baseUrl: "http://example.invalid/v1",
    fetch: async (_input, init) => {
      signals.push(init?.signal);
      return new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 });
    },
  });

  assert.deepEqual(ids, ["x"]);
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
});

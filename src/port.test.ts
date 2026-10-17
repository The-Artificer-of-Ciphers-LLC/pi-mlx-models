import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { bindProbe, connectProbe, probeAddress, probePort, waitForPortFree } from "./port.js";
import { freePort } from "./testkit.js";

/** Listen on an OS-assigned loopback port. Tests never touch the default port. */
function listenOnLoopback(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not read the assigned port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test("probePort is true for a live listener on 127.0.0.1 and false once it closes", async () => {
  const { server, port } = await listenOnLoopback();
  assert.equal(await probePort("127.0.0.1", port), true);
  await closeServer(server);
  assert.equal(await probePort("127.0.0.1", port), false);
});

test("connectProbe is true only when something accepts the connection", async () => {
  const { server, port } = await listenOnLoopback();
  assert.equal(await connectProbe("127.0.0.1", port), true);
  await closeServer(server);
  assert.equal(await connectProbe("127.0.0.1", port), false);
});

test("bindProbe reports an occupied address as true", async () => {
  const { server, port } = await listenOnLoopback();
  try {
    assert.equal(await bindProbe("127.0.0.1", port), true);
  } finally {
    await closeServer(server);
  }
});

test("bindProbe reports a free address as false and leaves the port free", async () => {
  const port = await freePort();
  assert.equal(await bindProbe("127.0.0.1", port), false);
  // The probe must have closed its own listener: a real listen on the same port succeeds.
  const again = createServer();
  await new Promise<void>((resolve, reject) => {
    again.once("error", reject);
    again.listen(port, "127.0.0.1", () => resolve());
  });
  await closeServer(again);
});

test("probeAddress maps wildcard hosts and the empty string to loopback and leaves other hosts alone", () => {
  assert.equal(probeAddress("0.0.0.0"), "127.0.0.1");
  assert.equal(probeAddress("::"), "127.0.0.1");
  assert.equal(probeAddress(""), "127.0.0.1");
  assert.equal(probeAddress("127.0.0.1"), "127.0.0.1");
  assert.equal(probeAddress("localhost"), "localhost");
  assert.equal(probeAddress("::1"), "::1");
  assert.equal(probeAddress("192.168.1.20"), "192.168.1.20");
});

test("probePort given a wildcard host probes loopback instead of binding the wildcard", async () => {
  const { server, port } = await listenOnLoopback();
  try {
    assert.equal(await probePort("0.0.0.0", port), true);
  } finally {
    await closeServer(server);
  }
});

test("waitForPortFree resolves true after exactly two sleeps when the probe answers busy, busy, free", async () => {
  const answers = [true, true, false];
  const sleeps: number[] = [];
  const free = await waitForPortFree({
    host: "127.0.0.1",
    port: 1,
    probe: async () => answers.shift() ?? false,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    timeoutMs: 1000,
    pollMs: 100,
  });
  assert.equal(free, true);
  assert.deepEqual(sleeps, [100, 100]);
});

test("waitForPortFree resolves false after ceil(timeoutMs / pollMs) probes when the port never frees up", async () => {
  let probes = 0;
  const free = await waitForPortFree({
    host: "127.0.0.1",
    port: 1,
    probe: async () => {
      probes += 1;
      return true;
    },
    sleep: async () => {},
    timeoutMs: 1050,
    pollMs: 100,
  });
  assert.equal(free, false);
  assert.equal(probes, 11);
});

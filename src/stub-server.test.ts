import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { freePort, spawnStub, waitForExit, waitForHttp } from "./testkit.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spawn the stub and guarantee it cannot outlive the test. */
function startStub(t: TestContext, options: Parameters<typeof spawnStub>[0]): ChildProcess {
  const child = spawnStub(options);
  t.after(() => {
    child.kill("SIGKILL");
  });
  return child;
}

/** Accumulate a stream into a string that can be inspected at any time. */
function capture(stream: NodeJS.ReadableStream | null): { text: () => string } {
  let buffer = "";
  stream?.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
  });
  return { text: () => buffer };
}

async function waitForText(read: () => string, needle: string, limitMs = 5000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (read().includes(needle)) return;
    await sleep(25);
  }
  throw new Error(`never saw ${JSON.stringify(needle)} in ${JSON.stringify(read())}`);
}

function occupy(t: TestContext, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    t.after(() => {
      server.close();
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

test(
  "stub in ok mode answers the models and chat endpoints on the port it was given",
  { timeout: 20_000 },
  async (t) => {
    const port = await freePort();
    startStub(t, { mode: "ok", port, model: "stub/model" });

    await waitForHttp(`http://127.0.0.1:${port}/v1/models`);

    const models = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(models.status, 200);
    const modelsBody = (await models.json()) as { data: Array<{ id: string }> };
    assert.equal(modelsBody.data[0]?.id, "stub/model");

    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(chat.status, 200);
    const chatBody = (await chat.json()) as { choices: unknown[] };
    assert.ok(Array.isArray(chatBody.choices) && chatBody.choices.length > 0);
  },
);

test(
  "stub in flood mode stalls before listening while stdout is unread and serves once it is drained",
  { timeout: 20_000 },
  async (t) => {
    const port = await freePort();
    const child = startStub(t, { mode: "flood", port });
    const url = `http://127.0.0.1:${port}/v1/models`;

    // Nobody reads stdout, so the stub is blocked inside its flood write.
    await sleep(1000);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(300) }), "stub must not be listening yet");
    assert.equal(child.exitCode, null);

    // Draining the pipe releases the stub, which then continues as ok mode.
    child.stdout?.resume();
    await waitForHttp(url, { timeoutMs: 10_000 });
    const res = await fetch(url);
    assert.equal(res.status, 200);
  },
);

test("stub in exit-early mode reports a missing module and exits with code 3 without listening", { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const child = startStub(t, { mode: "exit-early", port });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);

  const { code } = await waitForExit(child);

  assert.equal(code, 3);
  // "exit" can fire before the pipes are fully read, so wait for the text.
  await waitForText(stdout.text, "stub: starting up");
  await waitForText(stderr.text, "ModuleNotFoundError");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(300) }));
});

test("stub in bind-hang mode prints the address-in-use error but keeps running", { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  await occupy(t, port);
  const child = startStub(t, { mode: "bind-hang", port });
  const stderr = capture(child.stderr);

  await waitForText(stderr.text, "Address already in use");
  assert.match(stderr.text(), /Errno 48/);

  await sleep(500);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test("stub in warmup-400 mode serves models but rejects chat with a padded JSON error", { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  startStub(t, { mode: "warmup-400", port, env: { STUB_ERROR_PAD: "200" } });
  const base = `http://127.0.0.1:${port}`;

  await waitForHttp(`${base}/v1/models`);
  const models = await fetch(`${base}/v1/models`);
  assert.equal(models.status, 200);

  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "stub/model", messages: [] }),
  });
  assert.equal(chat.status, 400);
  const body = (await chat.json()) as { error: string };
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.startsWith("stub: unsupported request"));
  assert.equal(body.error.length, "stub: unsupported request".length + 200);
});

test("stub in hang mode accepts connections but never answers", { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const child = startStub(t, { mode: "hang", port });
  const stderr = capture(child.stderr);

  await waitForText(stderr.text, "Starting httpd");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(300) }));
  assert.equal(child.exitCode, null);
});

test("stub in ignore-term mode survives SIGTERM and only dies on SIGKILL", { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const child = startStub(t, { mode: "ignore-term", port });
  await waitForHttp(`http://127.0.0.1:${port}/v1/models`);

  child.kill("SIGTERM");
  await sleep(500);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);

  child.kill("SIGKILL");
  const { signal } = await waitForExit(child);
  assert.equal(signal, "SIGKILL");
});

test("stub with an unknown mode exits with code 2 and names the mode on stderr", { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const child = startStub(t, { mode: "no-such-mode", port });
  const stderr = capture(child.stderr);

  const { code } = await waitForExit(child);

  assert.equal(code, 2);
  await waitForText(stderr.text, "no-such-mode");
});

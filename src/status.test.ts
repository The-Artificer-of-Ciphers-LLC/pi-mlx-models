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

// ---- classifyHealth: a start in flight is loading even when the server answers (D-08, Pitfall 1) ----

const ANSWERING: HealthProbe = { accepts: true, models: { answers: true, ids: ["m"] } };
const SILENT: HealthProbe = { accepts: true, models: { answers: false } };
const REFUSED: HealthProbe = { accepts: false, models: { answers: false } };

test("classifyHealth: a start of this session under way is loading for every probe", () => {
  for (const probe of [ANSWERING, SILENT, REFUSED]) assert.equal(classifyHealth("starting", probe), "loading", JSON.stringify(probe));
});

test("classifyHealth: a finished start of this session whose server answers is ready", () => {
  assert.equal(classifyHealth("ready", ANSWERING), "ready");
});

test("classifyHealth: a finished start of this session whose server accepts but does not answer is loading", () => {
  assert.equal(classifyHealth("ready", SILENT), "loading");
});

test("classifyHealth: a finished start of this session whose port accepts nothing is down", () => {
  assert.equal(classifyHealth("ready", REFUSED), "down");
});

test("classifyHealth: a server this session did not start that answers is ready", () => {
  assert.equal(classifyHealth("none", ANSWERING), "ready");
});

test("classifyHealth: a server this session did not start that accepts but does not answer is not answering, never loading", () => {
  assert.equal(classifyHealth("none", SILENT), "not answering");
});

test("classifyHealth: a port that accepts nothing is down when this session started nothing", () => {
  assert.equal(classifyHealth("none", REFUSED), "down");
});

// ---- formatStatus ----

const ADDRESS = { host: "127.0.0.1", port: 8080 };
const LAUNCH = {
  modelId: "mlx-community/Qwen3-4B-4bit",
  presetKey: "qwen3",
  profileLine: "profile: coding (typed)",
  flagsLine: "flags: --prompt-cache-size 4",
  requestLine: "request: temperature 0.2",
  modelLine: "model: Qwen3 4B, 40960 context, reasoning",
};
const view = (overrides: Partial<StatusView>): StatusView => ({
  health: "ready",
  address: ADDRESS,
  session: "ready",
  launch: LAUNCH,
  served: [LAUNCH.modelId],
  ...overrides,
});
const lines = (text: string) => text.split("\n");

test("formatStatus: a ready launch of this session shows status, server, profile, flags, request and the model line in order", () => {
  const text = formatStatus(view({}));
  const out = lines(text);
  assert.match(out[0], /^status: ready/);
  const server = out.find((line) => line.startsWith("server:")) ?? "";
  assert.ok(server.includes(LAUNCH.modelId) && server.includes("qwen3") && server.includes("127.0.0.1:8080"), server);
  const order = [LAUNCH.profileLine, LAUNCH.flagsLine, LAUNCH.requestLine, LAUNCH.modelLine].map((line) => out.indexOf(line));
  assert.ok(order.every((at) => at > 0), `every supplied line appears exactly as given: ${text}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in the order profile, flags, request, model");
  assert.ok(out.findIndex((line) => line.startsWith("server:")) < order[0], "the server line comes before the supplied lines");
  assert.ok(!/unknown/i.test(text), text);
});

test("formatStatus: an empty line is omitted and a launch without a preset names only the model id", () => {
  const text = formatStatus(view({ launch: { ...LAUNCH, presetKey: undefined, flagsLine: "", requestLine: "" } }));
  assert.ok(!lines(text).includes(""), "no blank line");
  assert.ok(lines(text).includes(LAUNCH.profileLine));
  assert.ok(!text.includes("(undefined)") && !text.includes("undefined"), text);
});

test("formatStatus: a start under way is loading, says so, shows the lines and no model line", () => {
  const text = formatStatus(view({ health: "loading", session: "starting", launch: { ...LAUNCH, modelLine: undefined } }));
  assert.match(lines(text)[0], /^status: loading/);
  assert.match(text, /start is under way/);
  assert.ok(lines(text).includes(LAUNCH.profileLine) && lines(text).includes(LAUNCH.requestLine));
  assert.ok(!text.includes("model: "), "no model line");
  assert.match(text, /model details appear after the start finishes/);
});

test("formatStatus: a finished start whose server accepts but does not answer is loading and says busy", () => {
  const text = formatStatus(view({ health: "loading" }));
  assert.match(lines(text)[0], /^status: loading/);
  assert.match(lines(text)[0], /busy|not answering yet/);
});

test("formatStatus: a finished start whose server is down says the server this session started is not answering", () => {
  const text = formatStatus(view({ health: "down" }));
  assert.match(lines(text)[0], /^status: down/);
  assert.match(text, /server this session started is not answering/);
});

test("formatStatus: down with no launch of this session says nothing is listening on HOST:PORT", () => {
  const text = formatStatus({ health: "down", address: ADDRESS, session: "none", served: [] });
  assert.match(lines(text)[0], /^status: down/);
  assert.match(text, /nothing is listening on 127\.0\.0\.1:8080/);
});

test("formatStatus: an IPv6 host is shown bracketed", () => {
  const text = formatStatus({ health: "down", address: { host: "::1", port: 8080 }, session: "none", served: [] });
  assert.match(text, /nothing is listening on \[::1\]:8080/);
});

test("formatStatus: an answering server this session did not start shows the port, the ids, unknown profile and flags and one note", () => {
  const text = formatStatus({ health: "ready", address: ADDRESS, session: "none", served: ["alpha", "beta"] });
  assert.match(lines(text)[0], /^status: ready/);
  assert.match(text, /not started by this session/);
  assert.ok(text.includes("8080") && text.includes("alpha") && text.includes("beta"), text);
  assert.ok(lines(text).includes("profile: unknown") && lines(text).includes("flags: unknown"), text);
  assert.equal(lines(text).filter((line) => /model line is not shown/.test(line)).length, 1);
  assert.ok(!lines(text).some((line) => line.startsWith("model:")), "no model line");
});

test("formatStatus: an answering server with zero models says none are reported", () => {
  const text = formatStatus({ health: "ready", address: ADDRESS, session: "none", served: [] });
  assert.match(text, /none reported/);
});

test("formatStatus: a server this session did not start that accepts but does not answer is not answering", () => {
  const text = formatStatus({ health: "not answering", address: ADDRESS, session: "none", served: [] });
  assert.match(lines(text)[0], /^status: not answering/);
  assert.match(text, /accepts connections/);
  assert.match(text, /\/v1\/models/);
});

test("formatStatus: a served id holding an escape sequence is shown without control characters", () => {
  const text = formatStatus({ health: "ready", address: ADDRESS, session: "none", served: ["\u001b[31mred\u001b[0m\u009b2J"] });
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text), JSON.stringify(text));
  assert.ok(text.includes("red"));
});

test("formatStatus: a served id that is a URL with a user name and password has the credentials hidden", () => {
  const text = formatStatus({ health: "ready", address: ADDRESS, session: "none", served: ["https://admin:hunter2@example.com/model"] });
  assert.ok(!text.includes("hunter2") && !text.includes("admin"), text);
  assert.ok(text.includes("***"), text);
});

test("formatStatus: a served id of 500 characters is clipped", () => {
  const text = formatStatus({ health: "ready", address: ADDRESS, session: "none", served: ["x".repeat(500)] });
  assert.ok(text.includes("x".repeat(80)) && !text.includes("x".repeat(81)), "clipped to 80 characters");
});

test("formatStatus: a credential in front of a long id cannot come back through the clip", () => {
  const text = formatStatus({ health: "ready", address: ADDRESS, session: "none", served: [`https://u:pw-secret@host/${"a".repeat(500)}`] });
  assert.ok(!text.includes("pw-secret"), text);
});

test("formatStatus: 25 served ids list 10 and count the other 15", () => {
  const served = Array.from({ length: 25 }, (_, i) => `m${String(i).padStart(2, "0")}`);
  const text = formatStatus({ health: "ready", address: ADDRESS, session: "none", served });
  assert.ok(text.includes("m00") && text.includes("m09"), text);
  assert.ok(!text.includes("m10") && !text.includes("m24"), text);
  assert.match(text, /and 15 more/);
});

test("formatStatus: a launch model id and preset key with escape sequences are cleaned too", () => {
  const text = formatStatus(view({ launch: { ...LAUNCH, modelId: "org/\u001b[2Jmodel", presetKey: "pre\u001bset" } }));
  assert.ok(!text.includes("\u001b"), JSON.stringify(text));
  assert.ok(text.includes("model") && text.includes("pre"), text);
});

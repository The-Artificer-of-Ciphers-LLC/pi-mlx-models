import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMlxServer, type ServerEvent, type ServerHost, type ServerProcess } from "./server.js";

class FakeProc extends EventEmitter implements ServerProcess {
  stderr = new EventEmitter() as EventEmitter & { on(event: "data", l: (c: Buffer | string) => void): unknown };
  stdout = new EventEmitter() as EventEmitter & { on(event: "data", l: (c: Buffer | string) => void): unknown };
  killed: string | undefined;
  /** Shared with makeHost so tests can assert the order of kills, exits, probes and spawns. */
  log?: string[];
  kill(signal?: NodeJS.Signals) {
    this.killed = signal;
    this.log?.push(`kill:${signal}`);
    // Real processes exit asynchronously after SIGTERM.
    setImmediate(() => {
      this.log?.push("exit");
      this.emit("exit", null);
    });
  }
  die(code: number) {
    this.emit("exit", code);
  }
}

/** Records every signal and exits only when told to (or when a chosen signal arrives). */
class ManualProc extends FakeProc {
  signals: string[] = [];
  constructor(private readonly exitsOn: readonly string[] = []) {
    super();
  }
  override kill(signal?: NodeJS.Signals) {
    this.signals.push(String(signal));
    if (signal !== undefined && this.exitsOn.includes(signal)) this.emit("exit", null);
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * `busy` is a settable sequence of port-probe answers (true = port in use); once it is
 * used up the port reads free. `log` records spawn and probe order for ordering assertions.
 */
function makeHost(overrides: Partial<ServerHost> = {}, busy: boolean[] = []) {
  const procs: FakeProc[] = [];
  const log: string[] = [];
  const probes: Array<{ host: string; port: number }> = [];
  const host: ServerHost = {
    spawn: () => {
      log.push("spawn");
      const p = new FakeProc();
      p.log = log;
      procs.push(p);
      return p;
    },
    fetch: async () => new Response("{}", { status: 200 }),
    sleep: () => new Promise((r) => setImmediate(r)),
    portInUse: async (probeHost, port) => {
      probes.push({ host: probeHost, port });
      const inUse = busy.shift() ?? false;
      log.push(inUse ? "probe:busy" : "probe:free");
      return inUse;
    },
    ...overrides,
  };
  return { host, procs, log, probes };
}

const opts = { baseUrl: "http://x/v1", healthPollMs: 0, warmupPollMs: 0 };

test("start emits lifecycle events in order and marks the server running", async () => {
  const { host } = makeHost();
  const server = createMlxServer({ ...opts, host });
  const events: string[] = [];
  await server.start("m", (e) => events.push(e.type));
  assert.deepEqual(events, ["launched", "loading", "warming", "ready"]);
  assert.equal(server.running, true);
});

test("stderr download progress becomes typed events", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { host, procs } = makeHost({
    fetch: async (url) => {
      if (String(url).endsWith("/models")) await gate;
      return new Response("{}");
    },
  });
  const server = createMlxServer({ ...opts, host });
  const events: ServerEvent[] = [];
  const started = server.start("m", (e) => events.push(e));
  await tick(); // the pre-spawn port probe is awaited before the process exists
  procs[0].stderr.emit("data", Buffer.from("Fetching 4 files:  50%|███ | 2/4"));
  procs[0].stderr.emit("data", "Starting httpd");
  release();
  await started;
  assert.deepEqual(events.slice(1, 3), [{ type: "downloading", progress: 0.5, done: 2, total: 4 }, { type: "starting" }]);
});

test("restart does not let the replaced process clobber its successor", async () => {
  const { host, procs } = makeHost();
  const server = createMlxServer({ ...opts, host });
  await server.start("a");
  const events: string[] = [];
  await server.start("b", (e) => events.push(e.type));
  assert.equal(procs[0].killed, "SIGTERM");
  assert.equal(procs.length, 2);
  assert.equal(server.running, true, "old process exit must not null the new one");
  assert.ok(!events.includes("exited"));
});

test("a process dying during startup rejects with its stderr instead of waiting out the timeout", async () => {
  const { host, procs } = makeHost({
    fetch: async () => {
      throw new Error("refused");
    },
  });
  const server = createMlxServer({ ...opts, host });
  const events: string[] = [];
  const started = server.start("m", (e) => events.push(e.type));
  await tick();
  procs[0].stderr.emit("data", "ModuleNotFoundError: mlx");
  procs[0].die(1);
  await assert.rejects(started, /exited \(code 1\).*ModuleNotFoundError/s);
  assert.ok(events.includes("exited"));
  assert.equal(server.running, false);
});

test("stop during startup cancels the pending start without an exited event", async () => {
  const { host } = makeHost({
    fetch: async () => {
      throw new Error("refused");
    },
  });
  const server = createMlxServer({ ...opts, host });
  const events: string[] = [];
  const started = server.start("m", (e) => events.push(e.type));
  await new Promise((r) => setImmediate(r));
  server.stop();
  await assert.rejects(started, /cancelled/);
  assert.ok(!events.includes("exited"));
  assert.equal(server.running, false);
});

test("stop sends SIGTERM and resolves only after the process has exited", async () => {
  const proc = new ManualProc();
  const { host } = makeHost({
    spawn: () => proc,
    // The kill-wait window never elapses, so only the exit event can settle stop().
    sleep: () => new Promise<void>(() => {}),
  });
  const server = createMlxServer({ ...opts, host });
  await server.start("m");

  let settled = false;
  const stopping = server.stop().then(() => {
    settled = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  assert.equal(settled, false, "stop() must stay pending until the child's exit event");
  assert.equal(server.running, false, "running reflects the stop request immediately");

  proc.die(0);
  await stopping;
  assert.equal(settled, true);
  assert.deepEqual(proc.signals, ["SIGTERM"]);
});

test("stop escalates to SIGKILL when SIGTERM is ignored", async () => {
  const proc = new ManualProc(["SIGKILL"]);
  const { host } = makeHost({ spawn: () => proc });
  const server = createMlxServer({ ...opts, host });
  await server.start("m");

  await server.stop();

  assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(server.running, false);
});

test("stop resolves only after the port has been released", async () => {
  const busy: boolean[] = [];
  const { host, log } = makeHost({}, busy);
  const server = createMlxServer({ ...opts, host });
  await server.start("m");
  log.length = 0;
  busy.push(true, true, true);

  await server.stop();

  assert.deepEqual(log, ["kill:SIGTERM", "exit", "probe:busy", "probe:busy", "probe:busy", "probe:free"]);
});

test("start refuses an occupied port when there was no previous server, naming the port and PI_MLX_MODELS_PORT, and never spawns", async () => {
  const { host, procs, probes } = makeHost({}, [true]);
  const server = createMlxServer({ ...opts, host, address: { host: "127.0.0.1", port: 54321 } });

  await assert.rejects(server.start("m"), (err: Error) => {
    assert.match(err.message, /54321/);
    assert.match(err.message, /PI_MLX_MODELS_PORT/);
    assert.match(err.message, /lsof -nP -iTCP:54321 -sTCP:LISTEN/);
    assert.doesNotMatch(err.message, /still in use/);
    return true;
  });

  assert.equal(procs.length, 0, "spawn must never be reached");
  assert.deepEqual(probes, [{ host: "127.0.0.1", port: 54321 }]);
  assert.equal(server.running, false);
});

test("start on a running server spawns only after SIGTERM, exit and a free port, in that order", async () => {
  const busy: boolean[] = [];
  const { host, procs, log } = makeHost({}, busy);
  const server = createMlxServer({ ...opts, host });
  await server.start("a");
  log.length = 0;
  busy.push(true, true);

  await server.start("b");

  assert.deepEqual(log, ["kill:SIGTERM", "exit", "probe:busy", "probe:busy", "probe:free", "probe:free", "spawn"]);
  assert.equal(procs.length, 2);
  assert.equal(server.running, true);
});

test("start on a running server whose port stays busy rejects with 'still in use' and spawns no second process", async () => {
  let occupied = false;
  const { host, procs } = makeHost({ portInUse: async () => occupied });
  const server = createMlxServer({ ...opts, host });
  await server.start("a");
  occupied = true;

  await assert.rejects(server.start("b"), (err: Error) => {
    assert.match(err.message, /still in use/);
    assert.match(err.message, /PI_MLX_MODELS_PORT/);
    return true;
  });

  assert.equal(procs.length, 1, "no second process may be spawned");
  assert.equal(server.running, false);
});

test("a /v1/models response from an old listener cannot make a process that already died look ready", async () => {
  const { host, procs } = makeHost({
    // The response arrives fine, but the process we spawned died before it did.
    fetch: async () => {
      procs[0].stderr.emit("data", "ModuleNotFoundError: mlx");
      procs[0].die(1);
      return new Response("{}", { status: 200 });
    },
  });
  const server = createMlxServer({ ...opts, host });
  const events: string[] = [];

  await assert.rejects(server.start("m", (e) => events.push(e.type)), /exited \(code 1\).*ModuleNotFoundError/s);

  assert.deepEqual(events, ["launched", "exited"], "no loading, warming or ready event after a dead process answered");
  assert.equal(server.running, false);
});

test("a warm-up response that arrives after the process died never reports ready", async () => {
  const { host, procs } = makeHost({
    fetch: async (url) => {
      if (String(url).endsWith("/chat/completions")) {
        procs[0].stderr.emit("data", "ModuleNotFoundError: mlx");
        procs[0].die(1);
      }
      return new Response("{}", { status: 200 });
    },
  });
  const server = createMlxServer({ ...opts, host });
  const events: string[] = [];

  await assert.rejects(server.start("m", (e) => events.push(e.type)), /exited \(code 1\).*ModuleNotFoundError/s);

  assert.ok(!events.includes("ready"), "ready must not be emitted");
  assert.equal(server.running, false);
});

/** Run a start whose server only ever refuses connections, feeding it `chunks` on stderr. */
async function startWithBindFailure(chunks: string[]) {
  const { host, procs } = makeHost({
    fetch: async () => {
      throw new Error("refused");
    },
  });
  const server = createMlxServer({ ...opts, host, address: { host: "127.0.0.1", port: 54321 } });
  const events: string[] = [];
  let failure: Error | undefined;
  let settled = false;
  const started = server.start("m", (e) => events.push(e.type)).then(
    () => {
      settled = true;
    },
    (error: Error) => {
      settled = true;
      failure = error;
    },
  );
  await tick();
  for (const chunk of chunks) procs[0].stderr.emit("data", chunk);
  // Give a correct implementation a few event-loop turns to fail the start on its own, then cancel
  // whatever is still pending so a regression ends the test instead of polling for the health window.
  for (let turn = 0; turn < 5; turn += 1) await tick();
  const failedOnItsOwn = settled;
  await server.stop();
  await started;
  return { server, events, proc: procs[0], failedOnItsOwn, failure };
}

function assertBindFailureMessage(err: Error) {
  assert.match(err.message, /54321/);
  assert.match(err.message, /PI_MLX_MODELS_PORT/);
  assert.doesNotMatch(err.message, /Errno|Address already in use/, "the message must not embed raw stderr text");
  return true;
}

for (const [label, chunks] of [
  ["Errno 48", ["Traceback (most recent call last):\nOSError: [Errno 48] Address already in use\n"]],
  ["Errno 98", ["OSError: [Errno 98] Address already in use\n"]],
  ["a line split across two chunks", ["OSError: [Errno 48] Address alre", "ady in use\n"]],
] as const) {
  test(`a stderr bind failure (${label}) terminates the child and fails the start with the port message`, async () => {
    const { server, events, proc, failedOnItsOwn, failure } = await startWithBindFailure([...chunks]);

    assert.ok(failedOnItsOwn, "the start must fail on the bind error without waiting for the health window");
    assert.ok(failure, "the start must reject");
    assertBindFailureMessage(failure);
    assert.equal(proc.killed, "SIGTERM");
    assert.equal(server.running, false);
    assert.equal(events.filter((e) => e === "exited").length, 1, "exited is emitted exactly once");
  });
}

test("stop during the pre-spawn port probe cancels the pending start without spawning", async () => {
  let answer!: (inUse: boolean) => void;
  const { host, procs } = makeHost({ portInUse: () => new Promise<boolean>((r) => (answer = r)) });
  const server = createMlxServer({ ...opts, host });

  const started = server.start("m");
  await tick();
  await server.stop();
  answer(false);

  await assert.rejects(started, /cancelled/);
  assert.equal(procs.length, 0);
});

test("stdout output is tailed into the death message after the stderr tail", async () => {
  const { host, procs } = makeHost({
    fetch: async () => {
      throw new Error("refused");
    },
  });
  const server = createMlxServer({ ...opts, host });
  const started = server.start("m");
  await tick();
  procs[0].stdout.emit("data", Buffer.from("loading weights...\n"));
  procs[0].stderr.emit("data", "ModuleNotFoundError: mlx");
  procs[0].die(2);

  await assert.rejects(started, /exited \(code 2\): ModuleNotFoundError: mlx \| stdout: loading weights\.\.\./);
});

test("the stdout tail in a death message is bounded to its last 200 characters", async () => {
  const { host, procs } = makeHost({
    fetch: async () => {
      throw new Error("refused");
    },
  });
  const server = createMlxServer({ ...opts, host });
  const started = server.start("m");
  await tick();
  procs[0].stdout.emit("data", `${"a".repeat(1000)}END`);
  procs[0].die(1);

  await assert.rejects(started, (err: Error) => {
    const tail = err.message.split(" | stdout: ")[1];
    assert.ok(tail, `message should carry a stdout tail: ${err.message}`);
    assert.equal(tail.length, 200);
    assert.ok(tail.endsWith("END"));
    return true;
  });
});

test("diagnostic text has control characters removed", async () => {
  const { host, procs } = makeHost({
    fetch: async () => {
      throw new Error("refused");
    },
  });
  const server = createMlxServer({ ...opts, host });
  const started = server.start("m");
  await tick();
  procs[0].stderr.emit("data", "\u001b[31mred\u001b[0m\tTab\nnext\u007fline\u0000");
  procs[0].stdout.emit("data", "out\u001b]0;title\u0007put");
  procs[0].die(1);

  await assert.rejects(started, (err: Error) => {
    assert.doesNotMatch(err.message, /[\u0000-\u0008\u000b-\u001f\u007f]/, "no C0 control character or DEL may reach the message");
    assert.match(err.message, /red/);
    assert.ok(err.message.includes("\t") && err.message.includes("\n"), "newline and tab survive");
    return true;
  });
});

/** A host whose /models answers 200 and whose completion endpoint is scripted per call (exhausted script = 200). */
function scriptedWarmup(script: Array<Response | Error>) {
  const requests: string[] = [];
  const { host, procs } = makeHost({
    fetch: async (url) => {
      const target = String(url);
      requests.push(target);
      if (target.endsWith("/models")) return new Response("{}", { status: 200 });
      const next = script.shift() ?? new Response("{}", { status: 200 });
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { host, procs, completionCalls: () => requests.filter((r) => r.endsWith("/chat/completions")).length };
}

for (const status of [400, 404, 500]) {
  test(`a warm-up answered with HTTP ${status} fails the start at once, showing the server's message`, async () => {
    const { host, completionCalls } = scriptedWarmup([new Response('{"error":"bad model"}', { status })]);
    const server = createMlxServer({ ...opts, host });
    const events: string[] = [];

    await assert.rejects(server.start("m", (e) => events.push(e.type)), (err: Error) => {
      assert.match(err.message, new RegExp(`Warm-up request failed \\(HTTP ${status}\\): .*bad model`));
      return true;
    });

    assert.equal(completionCalls(), 1, "a 4xx/5xx warm-up must not be retried");
    assert.ok(!events.includes("ready"));
  });
}

test("a warm-up error body is clipped to 400 characters from the start", async () => {
  const { host } = scriptedWarmup([new Response(`${"x".repeat(2000)}TAIL`, { status: 400 })]);
  const server = createMlxServer({ ...opts, host });

  await assert.rejects(server.start("m"), (err: Error) => {
    const body = /^Warm-up request failed \(HTTP 400\): ([\s\S]*)$/.exec(err.message)?.[1];
    assert.ok(body, `message should carry a body: ${err.message}`);
    assert.equal(body.length, 400);
    assert.ok(!body.includes("TAIL"));
    return true;
  });
});

test("a warm-up error body has control characters removed", async () => {
  const { host } = scriptedWarmup([new Response("\u001b[31mbad\u001b[0m\u0007 model\u007f", { status: 400 })]);
  const server = createMlxServer({ ...opts, host });

  await assert.rejects(server.start("m"), (err: Error) => {
    assert.doesNotMatch(err.message, /[\u0000-\u0008\u000b-\u001f\u007f]/);
    assert.match(err.message, /bad/);
    return true;
  });
});

test("an empty or unreadable warm-up error body leaves the status without a colon part", async () => {
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("socket hang up"));
      },
    }),
    { status: 502 },
  );
  for (const response of [new Response("", { status: 500 }), broken]) {
    const { host } = scriptedWarmup([response]);
    const server = createMlxServer({ ...opts, host });
    await assert.rejects(server.start("m"), /Warm-up request failed \(HTTP \d{3}\)$/);
  }
});

test("a warm-up that fails on the network twice is retried and then reaches ready", async () => {
  const { host, completionCalls } = scriptedWarmup([new Error("refused"), new Error("timed out")]);
  const server = createMlxServer({ ...opts, host });
  const events: string[] = [];

  await server.start("m", (e) => events.push(e.type));

  assert.equal(completionCalls(), 3);
  assert.ok(events.includes("ready"));
});

test("a non-ok /v1/models response is retried, not fatal", async () => {
  let modelCalls = 0;
  const { host } = makeHost({
    fetch: async (url) => {
      if (String(url).endsWith("/models")) {
        modelCalls += 1;
        return new Response("loading", { status: modelCalls < 3 ? 503 : 200 });
      }
      return new Response("{}", { status: 200 });
    },
  });
  const server = createMlxServer({ ...opts, host });

  await server.start("m");

  assert.equal(modelCalls, 3);
  assert.equal(server.running, true);
});

test("every request carries its own AbortSignal, distinct for health and warm-up", async () => {
  const signals: Array<{ kind: "health" | "warmup"; signal: AbortSignal | null | undefined }> = [];
  const { host } = makeHost({
    fetch: async (url, init) => {
      signals.push({ kind: String(url).endsWith("/models") ? "health" : "warmup", signal: init?.signal });
      return new Response("{}", { status: 200 });
    },
  });
  const server = createMlxServer({ ...opts, host });

  await server.start("m");

  const health = signals.find((s) => s.kind === "health")?.signal;
  const warmup = signals.find((s) => s.kind === "warmup")?.signal;
  assert.ok(health instanceof AbortSignal, "the health request needs an AbortSignal");
  assert.ok(warmup instanceof AbortSignal, "the warm-up request needs an AbortSignal");
  assert.notEqual(health, warmup, "health and warm-up use separate signals");
  assert.equal(health.aborted, false);
  assert.equal(warmup.aborted, false);
});

/**
 * Poll waits advance the mocked clock so a health or warm-up window elapses without real waiting;
 * once the child has been signalled the wait is an ordinary tick, so its exit settles first.
 */
async function pollSleep(t: { mock: { timers: { tick(ms: number): void } } }, proc: () => FakeProc | undefined) {
  if (proc()?.killed === undefined) t.mock.timers.tick(60_000);
  else await tick();
}

// CR-01: a start that fails after spawning must not leave its own child behind.
for (const status of [400, 500]) {
  test(`a warm-up answered with HTTP ${status} stops the child it spawned and leaves the server not running`, async () => {
    const { host, procs } = scriptedWarmup([new Response("{}", { status })]);
    const server = createMlxServer({ ...opts, host });
    const events: string[] = [];

    await assert.rejects(server.start("m", (e) => events.push(e.type)), /Warm-up request failed/);

    assert.equal(procs.length, 1);
    assert.equal(procs[0].killed, "SIGTERM", "the failed start must terminate its own child");
    assert.equal(server.running, false);
    assert.ok(!events.includes("ready"));
  });
}

test("a health timeout stops the child it spawned and leaves the server not running", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { host, procs } = makeHost({
    fetch: async () => {
      throw new Error("refused");
    },
    sleep: () => pollSleep(t, () => procs[0]),
  });
  const server = createMlxServer({ ...opts, host });

  await assert.rejects(server.start("m"), /did not become healthy in time/);

  assert.equal(procs[0].killed, "SIGTERM");
  assert.equal(server.running, false);
});

test("a warm-up timeout stops the child it spawned and leaves the server not running", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { host, procs } = makeHost({
    fetch: async (url) => {
      if (String(url).endsWith("/models")) return new Response("{}", { status: 200 });
      throw new Error("still loading");
    },
    sleep: () => pollSleep(t, () => procs[0]),
  });
  const server = createMlxServer({ ...opts, host });

  await assert.rejects(server.start("m"), /did not become inference-ready in time/);

  assert.equal(procs[0].killed, "SIGTERM");
  assert.equal(server.running, false);
});

test("a start cancelled by a newer start does not stop the newer start's child", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { host, procs } = makeHost({
    fetch: async (url) => {
      if (String(url).endsWith("/models") && procs.length === 1) await gate;
      return new Response("{}", { status: 200 });
    },
  });
  const server = createMlxServer({ ...opts, host });

  const first = server.start("a");
  await tick();
  const second = server.start("b");
  await tick();
  release();

  await assert.rejects(first);
  await second;

  assert.equal(procs.length, 2);
  assert.equal(procs[1].killed, undefined, "the newer start's child must stay alive");
  assert.equal(server.running, true);
});

// WR-02: a stop() issued while a restart is tearing down the previous server must cancel the restart.
test("stop during the previous server's teardown cancels the pending restart without spawning", async () => {
  const proc = new ManualProc();
  let spawns = 0;
  const { host } = makeHost({
    spawn: () => {
      spawns += 1;
      return proc;
    },
    // The kill-wait window never elapses, so only the exit event settles the teardown.
    sleep: () => new Promise<void>(() => {}),
  });
  const server = createMlxServer({ ...opts, host });
  await server.start("a");

  const restarting = server.start("b");
  await tick();
  assert.deepEqual(proc.signals, ["SIGTERM"], "premise: the restart is tearing down the old server");
  const stopping = server.stop();
  proc.die(0);

  await assert.rejects(restarting, /cancelled/);
  await stopping;
  assert.equal(spawns, 1, "the cancelled restart must not spawn a second process");
  assert.equal(server.running, false);
});

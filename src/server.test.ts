import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMlxServer, type ServerEvent, type ServerHost, type ServerProcess } from "./server.js";

class FakeProc extends EventEmitter implements ServerProcess {
  stderr = new EventEmitter() as EventEmitter & { on(event: "data", l: (c: Buffer | string) => void): unknown };
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

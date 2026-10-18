import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { VENV_DIR, VENV_PYTHON } from "./config.js";
import { RunTimeoutError, ensureInstalled, findPython, pythonCandidates, run, runtimeCheck, runtimeInstalled, type RuntimeEvent, type RuntimeHost } from "./runtime.js";

function fakeHost(overrides: Partial<RuntimeHost> & { venv?: boolean } = {}) {
  const calls: string[][] = [];
  const host: RuntimeHost = {
    findPython: () => "/py3",
    exists: () => overrides.venv ?? false,
    run: async (cmd, args, onLine) => {
      calls.push([cmd, ...args]);
      onLine?.("Downloading 42%");
    },
    ...overrides,
  };
  return { host, calls };
}

test("an existing working install is left alone unless upgrade is requested", async () => {
  const { host, calls } = fakeHost({ venv: true });
  const events: RuntimeEvent[] = [];
  await ensureInstalled({ host, onEvent: (e) => events.push(e) });
  assert.deepEqual(calls, [[VENV_PYTHON, "-c", "import mlx_lm"]]);
  assert.deepEqual(events.map((e) => e.phase), ["mlx-lm"]);
});

test("upgrade always runs the pip steps, in phase order", async () => {
  const { host, calls } = fakeHost({ venv: true });
  const events: RuntimeEvent[] = [];
  await ensureInstalled({ host, upgrade: true, onEvent: (e) => events.push(e) });
  assert.equal(calls.length, 3, "the venv version probe plus the two pip steps");
  assert.deepEqual(
    [...new Set(events.map((e) => e.phase))],
    ["python", "venv", "pip", "mlx-lm"],
  );
  assert.equal(events.find((e) => e.phase === "pip" && e.progress != null)?.progress, 0.42);
});

test("a broken venv falls through to reinstall without upgrade", async () => {
  let n = 0;
  const { host, calls } = fakeHost({
    venv: true,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (n++ === 0) throw new Error("No module named mlx_lm");
    },
  });
  await ensureInstalled({ host });
  assert.equal(calls.length, 4, "import check, venv version probe and the two pip steps");
});

test("missing venv is created with the discovered python", async () => {
  const { host, calls } = fakeHost();
  await ensureInstalled({ host });
  assert.deepEqual(calls[0].slice(0, 3), ["/py3", "-m", "venv"]);
});

test("no compatible python is a clear error", async () => {
  const { host } = fakeHost({ findPython: () => null });
  await assert.rejects(ensureInstalled({ host }), /Python 3\.11\+ is required/);
});

// ---- the install policy (plan 03-03, RUN-02) ----

const PIP_INDEX = "--index-url=https://pypi.org/simple/";
/** The pip install calls, in order. */
const pipInstalls = (calls: string[][]) => calls.filter((call) => call.includes("pip") && call.includes("install"));
const mlxLmStep = (calls: string[][]) => pipInstalls(calls)[1];

test("a policy that is omitted floats on the default index", async () => {
  const { host, calls } = fakeHost({ venv: true });
  await ensureInstalled({ host, upgrade: true });
  assert.deepEqual(mlxLmStep(calls), [VENV_PYTHON, "-m", "pip", "install", "--upgrade", "mlx-lm>=0.24.0", PIP_INDEX]);
});

test("the policy latest is the same as no policy", async () => {
  const { host, calls } = fakeHost({ venv: true });
  await ensureInstalled({ host, upgrade: true, policy: { version: "latest" } });
  assert.deepEqual(mlxLmStep(calls), [VENV_PYTHON, "-m", "pip", "install", "--upgrade", "mlx-lm>=0.24.0", PIP_INDEX]);
});

test("an exact pin gives the single spec mlx-lm==X and no lower bound", async () => {
  const { host, calls } = fakeHost({ venv: true });
  await ensureInstalled({ host, upgrade: true, policy: { version: "0.31.1" } });
  assert.deepEqual(mlxLmStep(calls), [VENV_PYTHON, "-m", "pip", "install", "--upgrade", "mlx-lm==0.31.1", PIP_INDEX]);
  assert.ok(!mlxLmStep(calls).some((arg) => arg.includes(">=")));
});

test("a pin below the installed version is not special-cased: the step keeps --upgrade and never forces a reinstall", async () => {
  const { host, calls } = fakeHost({ venv: true });
  await ensureInstalled({ host, upgrade: true, policy: { version: "0.30.7" } });
  assert.equal(calls.length, 3, "the venv version probe plus the two pip steps, nothing that looks up the installed version");
  assert.ok(mlxLmStep(calls).includes("--upgrade"));
  assert.ok(!calls.flat().includes("--force-reinstall"));
});

test("the index is ONE argv element --index-url=VALUE in both pip steps", async () => {
  const { host, calls } = fakeHost({ venv: true });
  await ensureInstalled({ host, upgrade: true, policy: { version: "0.31.1" } });
  for (const step of pipInstalls(calls)) {
    assert.equal(step.filter((arg) => arg.startsWith("--index-url")).length, 1);
    assert.ok(step.includes(PIP_INDEX));
    assert.ok(!step.includes("--index-url"), "never the two-element spelling");
  }
  const custom = fakeHost({ venv: true });
  await ensureInstalled({ host: custom.host, upgrade: true, policy: { version: "latest", pipIndex: "https://mirror.test/simple/" } });
  for (const step of pipInstalls(custom.calls)) assert.ok(step.includes("--index-url=https://mirror.test/simple/"));
});

test("a first install with a pin also uses the pinned spec", async () => {
  const { host, calls } = fakeHost();
  await ensureInstalled({ host, policy: { version: "0.31.1" } });
  assert.deepEqual(calls[0].slice(0, 3), ["/py3", "-m", "venv"]);
  assert.deepEqual(mlxLmStep(calls), [VENV_PYTHON, "-m", "pip", "install", "--upgrade", "mlx-lm==0.31.1", PIP_INDEX]);
});

// ---- progress and failures that name the spec and the index (plan 03-04, RUN-04) ----

const MIRROR = "https://mirror.example/simple/";
const DEFAULT_INDEX = "https://pypi.org/simple/";
/** The first active event of a phase: the one the step announces itself with, before any pip output. */
const announcement = (events: RuntimeEvent[], phase: RuntimeEvent["phase"]) => events.find((e) => e.phase === phase && e.state === "active")?.detail;
const isPipUpgrade = (args: string[]) => args.includes("install") && args.includes("pip");
const isMlxLmInstall = (args: string[]) => args.includes("install") && args.some((arg) => arg.startsWith("mlx-lm"));

test("the pip step announces the index it upgrades from", async () => {
  const { host } = fakeHost({ venv: true });
  const events: RuntimeEvent[] = [];
  await ensureInstalled({ host, upgrade: true, policy: { version: "latest", pipIndex: MIRROR }, onEvent: (e) => events.push(e) });
  assert.equal(announcement(events, "pip"), `Upgrading pip (index ${MIRROR})`);

  const long = fakeHost({ venv: true });
  const longEvents: RuntimeEvent[] = [];
  const pipIndex = `https://mirror.example/${"a".repeat(500)}`;
  await ensureInstalled({ host: long.host, upgrade: true, policy: { version: "latest", pipIndex }, onEvent: (e) => longEvents.push(e) });
  const detail = announcement(longEvents, "pip") ?? "";
  assert.ok(detail.startsWith("Upgrading pip (index https://mirror.example/aaa"), detail);
  assert.ok(detail.length <= "Upgrading pip (index )".length + 200, `${detail.length}`);
});

test("the mlx-lm step announces the exact spec and the index", async () => {
  const { host } = fakeHost({ venv: true });
  const events: RuntimeEvent[] = [];
  await ensureInstalled({ host, upgrade: true, policy: { version: "0.31.1", pipIndex: MIRROR }, onEvent: (e) => events.push(e) });
  assert.equal(announcement(events, "mlx-lm"), `Installing mlx-lm==0.31.1 (index ${MIRROR})`);
  assert.equal(events.find((e) => e.phase === "mlx-lm" && e.state === "done")?.detail, "mlx-lm installed");
  assert.equal(events.find((e) => e.phase === "pip" && e.state === "done")?.detail, "pip upgraded");
});

test("a failing mlx-lm step names the spec and the index before pip's own text", async () => {
  const { host } = fakeHost({
    venv: true,
    run: async (_cmd, args) => {
      if (isMlxLmInstall(args)) throw new Error("ERROR: No matching distribution found");
    },
  });
  await assert.rejects(
    ensureInstalled({ host, upgrade: true, policy: { version: "0.99.0" } }),
    (error: Error) => {
      assert.ok(error.message.startsWith(`Installing mlx-lm==0.99.0 from ${DEFAULT_INDEX} failed: `), error.message);
      assert.ok(error.message.endsWith("ERROR: No matching distribution found"), error.message);
      return true;
    },
  );
});

test("pip's last sentence stays at the end of a long failure message", async () => {
  const versions = Array.from({ length: 250 }, (_, i) => `0.${i}.0`).join(", ").slice(0, 1500);
  const tail = "No matching distribution found for mlx-lm==0.99.0";
  const { host } = fakeHost({
    venv: true,
    run: async (_cmd, args) => {
      if (isMlxLmInstall(args)) throw new Error(`${versions}\n${tail}`);
    },
  });
  await assert.rejects(ensureInstalled({ host, upgrade: true, policy: { version: "0.99.0" } }), (error: Error) => {
    assert.ok(error.message.startsWith("Installing mlx-lm==0.99.0 from"), error.message);
    assert.ok(error.message.endsWith(tail), error.message.slice(-120));
    return true;
  });
});

test("a failing pip upgrade on a non-default index names the index and keeps the original text", async () => {
  const { host } = fakeHost({
    venv: true,
    run: async (_cmd, args) => {
      if (isPipUpgrade(args)) throw new Error("Connection refused");
    },
  });
  await assert.rejects(ensureInstalled({ host, upgrade: true, policy: { version: "latest", pipIndex: MIRROR } }), {
    message: `pip could not be upgraded from ${MIRROR}: Connection refused`,
  });
});

test("a failing pip upgrade on the default index is rethrown unchanged", async () => {
  const original = new Error("Connection refused");
  const { host } = fakeHost({
    venv: true,
    run: async (_cmd, args) => {
      if (isPipUpgrade(args)) throw original;
    },
  });
  await assert.rejects(ensureInstalled({ host, upgrade: true }), (error: Error) => {
    assert.equal(error.message, "Connection refused");
    assert.equal(error, original);
    return true;
  });
});

/** A temp directory removed when the test ends. */
async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-mlx-py-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A real executable that runs through the real spawnSync probe. */
async function stub(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const reportsVersion = (dir: string, name: string, version: string) => stub(dir, name, `echo "Python ${version}"`);

test("a 3.10 interpreter is below the floor and is rejected", async (t) => {
  const dir = await tempDir(t);
  const py = await reportsVersion(dir, "python3", "3.10.14");
  assert.equal(findPython({ candidates: [py], env: {} }), null);
});

test("3.11 is the lowest accepted interpreter", async (t) => {
  const dir = await tempDir(t);
  const py = await reportsVersion(dir, "python3", "3.11.9");
  assert.equal(findPython({ candidates: [py], env: {} }), py);
});

test("3.14 is accepted, there is no upper ceiling", async (t) => {
  const dir = await tempDir(t);
  const py = await reportsVersion(dir, "python3", "3.14.8");
  assert.equal(findPython({ candidates: [py], env: {} }), py);
});

test("a 3.15 release candidate is accepted", async (t) => {
  const dir = await tempDir(t);
  const py = await reportsVersion(dir, "python3", "3.15.0rc1");
  assert.equal(findPython({ candidates: [py], env: {} }), py);
});

test("failing, non-python and missing candidates are skipped without throwing", async (t) => {
  const dir = await tempDir(t);
  const failing = await stub(dir, "failing", "exit 1");
  const notPython = await stub(dir, "not-python", 'echo "hello world"');
  const good = await reportsVersion(dir, "good", "3.12.1");
  const missing = join(dir, "does-not-exist");
  assert.equal(findPython({ candidates: [failing, notPython, missing, good], env: {} }), good);
});

test("ensureInstalled stops before the venv on a 3.10-only machine and says what to do", async (t) => {
  const dir = await tempDir(t);
  const old = await reportsVersion(dir, "python3", "3.10.14");
  const { host, calls } = fakeHost({
    findPython: () => findPython({ candidates: [old], env: {} }),
    searched: () => [old],
  });
  await assert.rejects(ensureInstalled({ host }), (err: Error) => {
    assert.match(err.message, /3\.11/);
    assert.match(err.message, /brew install python@3\.13/);
    assert.ok(err.message.includes(old), "message lists the interpreters searched");
    return true;
  });
  assert.deepEqual(calls, []);
});

test("ensureInstalled proceeds to the venv step with a discovered 3.12 interpreter", async (t) => {
  const dir = await tempDir(t);
  const py = await reportsVersion(dir, "python3", "3.12.4");
  const { host, calls } = fakeHost({ findPython: () => findPython({ candidates: [py], env: {} }) });
  await ensureInstalled({ host });
  assert.deepEqual(calls[0].slice(0, 3), [py, "-m", "venv"]);
});

test("PI_MLX_MODELS_PYTHON is tried first and beats every candidate", async (t) => {
  const dir = await tempDir(t);
  const override = await reportsVersion(dir, "mine", "3.12.1");
  const other = await reportsVersion(dir, "other", "3.13.0");
  assert.equal(findPython({ candidates: [other], env: { PI_MLX_MODELS_PYTHON: override } }), override);
});

test("an override below 3.11 throws by name and does not fall through", async (t) => {
  const dir = await tempDir(t);
  const old = await reportsVersion(dir, "old", "3.10.4");
  const other = await reportsVersion(dir, "other", "3.13.0");
  assert.throws(
    () => findPython({ candidates: [other], env: { PI_MLX_MODELS_PYTHON: old } }),
    (err: Error) => {
      assert.ok(err.message.includes("PI_MLX_MODELS_PYTHON"));
      assert.ok(err.message.includes(old));
      assert.match(err.message, /3\.11/);
      return true;
    },
  );
});

test("an override that does not exist throws by name", async (t) => {
  const dir = await tempDir(t);
  const missing = join(dir, "no-such-python");
  const other = await reportsVersion(dir, "other", "3.13.0");
  assert.throws(
    () => findPython({ candidates: [other], env: { PI_MLX_MODELS_PYTHON: missing } }),
    (err: Error) => err.message.includes("PI_MLX_MODELS_PYTHON") && err.message.includes(missing),
  );
});

test("an empty or whitespace-only override is ignored", async (t) => {
  const dir = await tempDir(t);
  const other = await reportsVersion(dir, "other", "3.13.0");
  assert.equal(findPython({ candidates: [other], env: { PI_MLX_MODELS_PYTHON: "" } }), other);
  assert.equal(findPython({ candidates: [other], env: { PI_MLX_MODELS_PYTHON: "   " } }), other);
});

test("on PATH a named newest-first probe beats a bare python3", async (t) => {
  const dir = await tempDir(t);
  await reportsVersion(dir, "python3", "3.10.4");
  const named = await reportsVersion(dir, "python3.12", "3.12.1");
  assert.equal(findPython({ candidates: [], env: { PATH: dir } }), named);
});

test("a bare python3 on PATH is used when it is 3.11 or newer", async (t) => {
  const dir = await tempDir(t);
  const bare = await reportsVersion(dir, "python3", "3.15.0rc1");
  assert.equal(findPython({ candidates: [], env: { PATH: dir } }), bare);
});

test("the first PATH directory wins for the same name and empty entries are skipped", async (t) => {
  const first = await tempDir(t);
  const second = await tempDir(t);
  const winner = await reportsVersion(first, "python3.13", "3.13.1");
  await reportsVersion(second, "python3.13", "3.13.2");
  const PATH = ["", first, "", second].join(delimiter);
  assert.equal(findPython({ candidates: [], env: { PATH } }), winner);
});

test("with no PATH and no candidates nothing is found and nothing throws", () => {
  assert.equal(findPython({ candidates: [], env: {} }), null);
});

test("pythonCandidates lists the fixed paths newest first, then PATH, with no 3.10 and no duplicates", () => {
  const list = pythonCandidates({ PATH: ["/opt/homebrew/bin", "/somewhere/bin"].join(delimiter) });
  assert.deepEqual(list.slice(0, 7), [
    "/opt/homebrew/bin/python3.14",
    "/opt/homebrew/bin/python3.13",
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.11",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
  ]);
  assert.ok(list.includes(join("/somewhere/bin", "python3.14")));
  assert.ok(list.indexOf(join("/somewhere/bin", "python3.11")) < list.indexOf(join("/somewhere/bin", "python3")));
  assert.ok(!list.some((c) => c.includes("python3.10")));
  assert.equal(new Set(list).size, list.length);
});

test("PATH entries are expanded name-major so the newest name anywhere beats an earlier bare python3", () => {
  const PATH = ["/a", "/b"].join(delimiter);
  assert.deepEqual(pythonCandidates({ PATH }, []), [
    join("/a", "python3.14"),
    join("/b", "python3.14"),
    join("/a", "python3.13"),
    join("/b", "python3.13"),
    join("/a", "python3.12"),
    join("/b", "python3.12"),
    join("/a", "python3.11"),
    join("/b", "python3.11"),
    join("/a", "python3"),
    join("/b", "python3"),
  ]);
});

// WR-03: `exit` can fire before the child's stderr is fully read; a failure must carry the final output.
test("run reports stderr that a lingering grandchild writes after the child has already exited", async () => {
  // The child spawns a grandchild that inherits stderr and writes after Node starts up, then exits at once.
  const grandchild = "process.stderr.write('LATE-TAIL')";
  const child = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] }); process.exit(1)`;

  await assert.rejects(run(process.execPath, ["-e", child]), /LATE-TAIL/);
});

// WR-06: pip output is untrusted text that reaches the UI.
test("pip progress lines are cleaned of control characters before they become event details", async () => {
  const { host } = fakeHost({
    venv: true,
    run: async (_cmd, _args, onLine) => {
      onLine?.("\u001b[31mDownloading\u009b31m 42%\u0007");
    },
  });
  const events: RuntimeEvent[] = [];

  await ensureInstalled({ host, upgrade: true, onEvent: (e) => events.push(e) });

  const details = events.filter((e) => e.phase === "pip" && e.detail?.includes("Downloading")).map((e) => e.detail ?? "");
  assert.ok(details.length > 0, "premise: the scripted line reached an event");
  for (const detail of details) assert.doesNotMatch(detail, /[\u0000-\u001f\u007f-\u009f]/);
});

test("run's failure message is cleaned of control characters", async () => {
  const script = "process.stderr.write('\\u001b[31mpip exploded\\u009b31m\\u0007'); process.exit(1)";

  await assert.rejects(run(process.execPath, ["-e", script]), (err: Error) => {
    assert.match(err.message, /pip exploded/);
    assert.doesNotMatch(err.message, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    return true;
  });
});

test("run's onLine lines are cleaned of control characters", async () => {
  const script = "process.stdout.write('\\u001b[2Kline\\u009b\\n')";
  const lines: string[] = [];

  await run(process.execPath, ["-e", script], (line) => lines.push(line));

  assert.ok(lines.some((l) => l.includes("line")));
  for (const line of lines) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/);
});

// IN-03: a child that never ends must not hang the caller for good.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("run with a timeout kills a child that does not end and rejects with a fixed phrase", { timeout: 20_000 }, async () => {
  const script = "process.stdout.write('pid=' + process.pid + '\\n'); setInterval(() => {}, 1000)";
  let pid = 0;
  const started = Date.now();
  await assert.rejects(run(process.execPath, ["-e", script], (line) => {
    const m = line.match(/^pid=(\d+)$/);
    if (m) pid = Number(m[1]);
  }, { timeoutMs: 500 }), /timed out/);
  assert.ok(Date.now() - started < 10_000, "rejected soon after the bound");
  assert.ok(pid > 0, "premise: the child reported its pid");
  for (let i = 0; i < 40 && isAlive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isAlive(pid), false, "the child was killed");
});

test("run with a timeout also ends a grandchild that holds the output pipes", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  // The child starts a grandchild that inherits stdout and would live 6 s; the caller must not wait for it.
  const script = [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' });",
    "process.stdout.write('gpid=' + g.pid + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  let gpid = 0;
  const started = Date.now();
  try {
    await assert.rejects(run(process.execPath, ["-e", script], (line) => {
      const m = line.match(/^gpid=(\d+)$/);
      if (m) gpid = Number(m[1]);
    }, { timeoutMs: 400 }), /timed out/);
    assert.ok(Date.now() - started < 3000, "rejected at the bound, not when the grandchild ended");
    assert.ok(gpid > 0, "premise: the child reported the grandchild's pid");
    for (let i = 0; i < 40 && isAlive(gpid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(isAlive(gpid), false, "the grandchild was killed with the child");
  } finally {
    if (gpid > 0 && isAlive(gpid)) process.kill(gpid, "SIGKILL");
  }
});

test("run with a sub-second timeout says so in milliseconds, never 0 s", { timeout: 20_000 }, async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, { timeoutMs: 300 }),
    (error: Error) => /timed out after 300 ms/.test(error.message) && !/after 0 s/.test(error.message),
  );
});

test("run with a timeout of whole seconds says so in seconds", { timeout: 20_000 }, async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, { timeoutMs: 1000 }),
    /timed out after 1 s/,
  );
});

test("run with a timeout that is not reached resolves as before", async () => {
  await run(process.execPath, ["-e", "process.exit(0)"], undefined, { timeoutMs: 20_000 });
});

test("runtimeInstalled: the import check is run with a bound, so a wedged import cannot hang auto-start", async () => {
  const seen: unknown[] = [];
  const { host } = fakeHost({
    venv: true,
    run: async (_cmd, _args, _onLine, options) => {
      seen.push(options);
    },
  });
  assert.equal(await runtimeInstalled(host), true);
  const options = seen[0] as { timeoutMs?: unknown } | undefined;
  assert.equal(typeof options?.timeoutMs, "number");
  assert.ok((options?.timeoutMs as number) > 0);
});

// WR-07: a venv built by an older Python cannot take mlx-lm; it is recreated with a compatible interpreter.
/** A host whose venv exists and whose `--version` probe reports `venvVersion`; the import check fails unless `importable`. */
function venvHost(venvVersion: string, importable = false) {
  const calls: string[][] = [];
  const host: RuntimeHost = {
    findPython: () => "/py3",
    exists: () => true,
    run: async (cmd, args, onLine) => {
      calls.push([cmd, ...args]);
      if (args[0] === "-c" && !importable) throw new Error("No module named mlx_lm");
      if (args[0] === "--version") onLine?.(`Python ${venvVersion}`);
    },
  };
  return { host, calls };
}

const recreates = (calls: string[][]) => calls.filter((c) => c[0] === "/py3" && c.includes("--clear"));

test("a venv on Python 3.10 that cannot import mlx_lm is recreated before pip runs", async () => {
  const { host, calls } = venvHost("3.10.14");
  const events: RuntimeEvent[] = [];

  await ensureInstalled({ host, onEvent: (e) => events.push(e) });

  assert.deepEqual(recreates(calls), [["/py3", "-m", "venv", "--clear", VENV_DIR]]);
  const clearAt = calls.findIndex((c) => c.includes("--clear"));
  const pipAt = calls.findIndex((c) => c.includes("pip"));
  assert.ok(clearAt >= 0 && clearAt < pipAt, "the venv must be recreated before pip installs into it");
  const message = events.find((e) => e.phase === "venv" && e.detail?.includes("3.10"))?.detail ?? "";
  assert.match(message, /3\.11/, "the message names the floor");
  assert.match(message, /recreat/i);
});

test("mlx-init (upgrade) also recreates a venv on Python 3.9", async () => {
  const { host, calls } = venvHost("3.9.6");

  await ensureInstalled({ host, upgrade: true });

  assert.equal(recreates(calls).length, 1);
});

test("a venv on Python 3.11 or newer is kept", async () => {
  for (const version of ["3.11.0", "3.12.4", "3.15.0rc1"]) {
    const { host, calls } = venvHost(version);
    await ensureInstalled({ host });
    assert.deepEqual(recreates(calls), [], version);
  }
});

test("a venv whose version cannot be read is left alone", async () => {
  const { host, calls } = venvHost("not a version");
  await ensureInstalled({ host });
  assert.deepEqual(recreates(calls), []);
});

test("a working install is not probed for its version at all", async () => {
  const { host, calls } = venvHost("3.10.14", true);
  await ensureInstalled({ host });
  assert.ok(!calls.some((c) => c.includes("--version")));
});

test("pip's own output does not replace the index in either pip step's progress line", async () => {
  const { host } = fakeHost({ venv: true });
  const events: RuntimeEvent[] = [];
  await ensureInstalled({ host, upgrade: true, policy: { version: "0.31.1", pipIndex: MIRROR }, onEvent: (e) => events.push(e) });
  const fromPip = (phase: RuntimeEvent["phase"]) => events.filter((e) => e.phase === phase && e.state === "active" && e.progress != null);
  for (const phase of ["pip", "mlx-lm"] as const) {
    assert.ok(fromPip(phase).length > 0, `${phase} reported pip output`);
    for (const event of fromPip(phase)) {
      assert.ok(event.detail?.includes(`(index ${MIRROR})`), `${phase}: ${event.detail}`);
      assert.ok(event.detail?.includes("Downloading 42%"), "pip's line is still shown");
    }
  }
  assert.ok(fromPip("mlx-lm")[0].detail?.includes("mlx-lm==0.31.1"));
});

// ---- runtimeInstalled: the one answer to "has /mlx-init been run" (plan 06-03, D-27) ----

test("runtimeInstalled: a host without the venv Python is not installed and nothing is run", async () => {
  const { host, calls } = fakeHost({ venv: false });
  assert.equal(await runtimeInstalled(host), false);
  assert.deepEqual(calls, []);
});

test("runtimeInstalled: the venv Python that imports mlx_lm is installed, with one fixed command", async () => {
  const { host, calls } = fakeHost({ venv: true });
  assert.equal(await runtimeInstalled(host), true);
  assert.deepEqual(calls, [[VENV_PYTHON, "-c", "import mlx_lm"]]);
});

test("runtimeInstalled: a run that rejects is not installed", async () => {
  const { host } = fakeHost({
    venv: true,
    run: async () => {
      throw new Error("No module named mlx_lm");
    },
  });
  assert.equal(await runtimeInstalled(host), false);
});

test("runtimeCheck tells a timed-out import check from a missing runtime, and runtimeInstalled still answers false for both", async () => {
  const timedOut = fakeHost({
    venv: true,
    run: async () => {
      throw new RunTimeoutError("python", 60_000);
    },
  });
  const missing = fakeHost({
    venv: true,
    run: async () => {
      throw new Error("No module named mlx_lm");
    },
  });
  assert.equal(await runtimeCheck(timedOut.host), "timed out");
  assert.equal(await runtimeCheck(missing.host), "missing");
  assert.equal(await runtimeCheck(fakeHost({ venv: false }).host), "missing");
  assert.equal(await runtimeCheck(fakeHost({ venv: true }).host), "installed");
  assert.equal(await runtimeInstalled(timedOut.host), false);
});

test("runtimeInstalled: a run that throws before it returns a promise is not installed", async () => {
  const { host } = fakeHost({
    venv: true,
    run: () => {
      throw new Error("spawn failed");
    },
  });
  assert.equal(await runtimeInstalled(host), false);
});

test("runtimeInstalled: an exists that throws is not installed and nothing is run", async () => {
  const { host, calls } = fakeHost({
    exists: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(await runtimeInstalled(host), false);
  assert.deepEqual(calls, []);
});

test("runtimeInstalled: is callable with no argument, which means the system host", () => {
  assert.equal(typeof runtimeInstalled, "function");
  assert.equal(runtimeInstalled.length, 0, "the host parameter has a default");
});

test("runtimeInstalled: ensureInstalled with an installed runtime still reports it and never looks for Python", async () => {
  const { host, calls } = fakeHost({
    venv: true,
    findPython: () => {
      throw new Error("findPython must not be called");
    },
  });
  const events: RuntimeEvent[] = [];
  await ensureInstalled({ host, onEvent: (e) => events.push(e) });
  assert.deepEqual(calls, [[VENV_PYTHON, "-c", "import mlx_lm"]]);
  assert.deepEqual(events, [{ phase: "mlx-lm", state: "done", detail: "mlx-lm already installed" }]);
});

test("runtimeInstalled: ensureInstalled with upgrade does not ask whether the venv exists up front", async () => {
  let existsCalls = 0;
  const { host } = fakeHost({
    exists: () => {
      existsCalls += 1;
      return true;
    },
  });
  // The pip steps and the venv step still look at the venv; the short cut must not add a call of its own.
  await ensureInstalled({ host, upgrade: true });
  const withUpgrade = existsCalls;
  existsCalls = 0;
  await ensureInstalled({ host });
  assert.equal(withUpgrade, 1, "only the venv step asks");
  assert.equal(existsCalls, 1, "the short cut asks once and an installed runtime stops there");
});

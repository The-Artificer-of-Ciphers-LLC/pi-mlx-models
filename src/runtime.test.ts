import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { VENV_DIR, VENV_PYTHON } from "./config.js";
import { ensureInstalled, findPython, pythonCandidates, run, type RuntimeEvent, type RuntimeHost } from "./runtime.js";

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

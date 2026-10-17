import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENV_PYTHON } from "./config.js";
import { ensureInstalled, findPython, type RuntimeEvent, type RuntimeHost } from "./runtime.js";

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
  assert.equal(calls.length, 2);
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
  assert.equal(calls.length, 3);
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

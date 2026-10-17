import test from "node:test";
import assert from "node:assert/strict";
import { VENV_PYTHON } from "./config.js";
import { ensureInstalled, type RuntimeEvent, type RuntimeHost } from "./runtime.js";

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
  await assert.rejects(ensureInstalled({ host }), /Python 3\.10–3\.13 not found/);
});

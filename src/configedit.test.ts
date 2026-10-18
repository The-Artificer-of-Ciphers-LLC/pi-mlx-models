import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigTree, editConfig, getAt, setAt, unsetAt } from "./configedit.js";
import { prepareSettings, readLayerFile } from "./settings.js";

/** A fresh directory under the system temp directory, removed when the test ends. */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mlx-configedit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The effective settings of a real file, through the same reader and validation a launch uses. */
function resolved(path: string) {
  const file = readLayerFile(path);
  return prepareSettings({ global: file, env: {} });
}

test("editConfig creates: with no file the first edit writes the key and creates the directory", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "data", "config.json");
  const outcome = editConfig(path, (draft) => setAt(draft, ["server", "port"], 8081));
  assert.deepEqual(outcome, { ok: true, created: true, changed: true });
  assert.equal(readFileSync(path, "utf8"), pretty({ server: { port: 8081 } }));
  const result = resolved(path);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.prepared.address.port, 8081);
});

test("editConfig keeps the rest: the other keys and the order of the keys stay as they were", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  writeFileSync(path, pretty({ server: { port: 8080, logLevel: "INFO" }, defaultModel: "qwen3_4b" }));
  const outcome = editConfig(path, (draft) => setAt(draft, ["server", "port"], 8081));
  assert.deepEqual(outcome, { ok: true, created: false, changed: true });
  assert.equal(readFileSync(path, "utf8"), pretty({ server: { port: 8081, logLevel: "INFO" }, defaultModel: "qwen3_4b" }));
});

test("editConfig refuses an invalid result with the problem line a hand edit shows, and writes nothing", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  const before = pretty({ server: { port: 8080 } });
  writeFileSync(path, before);
  const outcome = editConfig(path, (draft) => setAt(draft, ["server", "port"], 70000));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, "invalid");
  assert.match(outcome.message, /server\.port \(global config\.json\)/);
  assert.match(outcome.message, /may already have been in the file/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("editConfig refuses an unreadable file: it names the file, says it was not changed and leaves it as it was", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  const before = "{ this is not json";
  writeFileSync(path, before);
  const outcome = editConfig(path, (draft) => setAt(draft, ["server", "port"], 8081));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, "unreadable");
  assert.ok(outcome.message.includes(path), outcome.message);
  assert.match(outcome.message, /it was not changed/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("editConfig no change: a value the file already holds writes nothing, whatever the file's formatting", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  const before = '{\n    "server": {\n        "port": 8080\n    }\n}';
  writeFileSync(path, before);
  const inode = statSync(path).ino;
  const outcome = editConfig(path, (draft) => setAt(draft, ["server", "port"], 8080));
  assert.deepEqual(outcome, { ok: true, created: false, changed: false });
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(statSync(path).ino, inode);
});

test("editConfig no change: removing a key from a file that does not exist creates no file", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "data", "config.json");
  const outcome = editConfig(path, (draft) => unsetAt(draft, ["server", "port"]));
  assert.deepEqual(outcome, { ok: true, created: false, changed: false });
  assert.throws(() => statSync(join(dir, "data")), /ENOENT/);
});

test("editConfig removes a key: unsetAt through an edit leaves the other keys", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  writeFileSync(path, pretty({ server: { port: 8080, logLevel: "INFO" } }));
  const outcome = editConfig(path, (draft) => unsetAt(draft, ["server", "port"]));
  assert.deepEqual(outcome, { ok: true, created: false, changed: true });
  assert.equal(readFileSync(path, "utf8"), pretty({ server: { logLevel: "INFO" } }));
});

test("setAt does not change its input and shares no object with it", () => {
  const input: ConfigTree = { server: { port: 8080 }, list: [1, 2] };
  const snapshot = JSON.stringify(input);
  const out = setAt(input, ["server", "port"], 9);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(JSON.stringify(out), JSON.stringify({ server: { port: 9 }, list: [1, 2] }));
  assert.notEqual(out.server, input.server);
  assert.notEqual(out.list, input.list);
  const added = setAt({}, ["a", "b", "c"], true);
  assert.equal(JSON.stringify(added), '{"a":{"b":{"c":true}}}');
});

test("unsetAt of a missing path is a no-op that still returns a copy", () => {
  const input: ConfigTree = { server: { port: 8080 } };
  const out = unsetAt(input, ["server", "logLevel"]);
  assert.equal(JSON.stringify(out), JSON.stringify(input));
  assert.notEqual(out, input);
  assert.equal(JSON.stringify(unsetAt(input, ["nope", "deeper"])), JSON.stringify(input));
  assert.equal(JSON.stringify(unsetAt(input, ["server", "port", "x"])), JSON.stringify(input));
});

test("getAt returns undefined for a missing path and never reads a prototype property", () => {
  const tree: ConfigTree = { server: { port: 8080 }, scalar: 5 };
  assert.equal(getAt(tree, ["server", "port"]), 8080);
  assert.equal(getAt(tree, ["server", "host"]), undefined);
  assert.equal(getAt(tree, ["scalar", "x"]), undefined);
  assert.equal(getAt(tree, ["toString"]), undefined);
  assert.equal(getAt(tree, ["server", "constructor"]), undefined);
  assert.equal(getAt(tree, ["__proto__"]), undefined);
  assert.equal(getAt({}, ["a", "b"]), undefined);
});

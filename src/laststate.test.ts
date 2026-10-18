import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAST_LAUNCH_FILE, LAST_LAUNCH_VERSION, MAX_LAST_LAUNCH_BYTES, lastLaunchPath, readLastLaunch, writeLastLaunch } from "./laststate.js";

const POSIX_MODES = process.platform === "win32" ? "file modes are not enforced on win32" : false;

/** A fresh directory under the system temp directory, removed when the test ends. */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mlx-laststate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MODEL = "mlx-community/Qwen3-4B-Instruct-2507-4bit";

test("lastLaunchPath puts the record next to the global config file", () => {
  assert.equal(LAST_LAUNCH_FILE, "last-launch.json");
  assert.equal(LAST_LAUNCH_VERSION, 1);
  assert.equal(MAX_LAST_LAUNCH_BYTES, 8192);
  assert.equal(lastLaunchPath(join("DIR", "data", "config.json")), join("DIR", "data", "last-launch.json"));
});

test("lastLaunch round trip: what one call writes another reads, as the single line the format names, with mode 0o600", { skip: POSIX_MODES }, (t) => {
  const dir = tempDir(t);
  const path = join(dir, LAST_LAUNCH_FILE);
  assert.deepEqual(writeLastLaunch(path, { model: MODEL, profile: "fast" }), { ok: true });
  assert.deepEqual(readLastLaunch(path), { state: "ok", value: { model: MODEL, profile: "fast" } });
  assert.equal(readFileSync(path, "utf8"), `{"version":1,"model":"${MODEL}","profile":"fast"}\n`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), [LAST_LAUNCH_FILE]);
});

test("lastLaunch profile null: a record without a profile round-trips as null", (t) => {
  const dir = tempDir(t);
  const path = join(dir, LAST_LAUNCH_FILE);
  assert.deepEqual(writeLastLaunch(path, { model: MODEL, profile: null }), { ok: true });
  assert.equal(readFileSync(path, "utf8"), `{"version":1,"model":"${MODEL}","profile":null}\n`);
  assert.deepEqual(readLastLaunch(path), { state: "ok", value: { model: MODEL, profile: null } });
});

test("lastLaunch absent: a missing file and a missing directory read as absent and create nothing", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readLastLaunch(join(dir, LAST_LAUNCH_FILE)), { state: "absent" });
  assert.deepEqual(readLastLaunch(join(dir, "nope", LAST_LAUNCH_FILE)), { state: "absent" });
  assert.equal(existsSync(join(dir, "nope")), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("lastLaunch last writer wins: two writes in a row leave the second record", (t) => {
  const dir = tempDir(t);
  const path = join(dir, LAST_LAUNCH_FILE);
  assert.deepEqual(writeLastLaunch(path, { model: MODEL, profile: "fast" }), { ok: true });
  assert.deepEqual(writeLastLaunch(path, { model: "other/model", profile: null }), { ok: true });
  assert.deepEqual(readLastLaunch(path), { state: "ok", value: { model: "other/model", profile: null } });
  assert.deepEqual(readdirSync(dir), [LAST_LAUNCH_FILE]);
});

test("lastLaunch creates the directory: writing under a data directory that does not exist yet creates it", (t) => {
  const dir = tempDir(t);
  const path = lastLaunchPath(join(dir, "data", "config.json"));
  assert.equal(existsSync(join(dir, "data")), false);
  assert.deepEqual(writeLastLaunch(path, { model: MODEL, profile: null }), { ok: true });
  assert.deepEqual(readLastLaunch(path), { state: "ok", value: { model: MODEL, profile: null } });
  assert.deepEqual(readdirSync(join(dir, "data")), [LAST_LAUNCH_FILE]);
});

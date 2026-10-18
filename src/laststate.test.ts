import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Write exactly this text as the record and read it back. */
function readRaw(dir: string, text: string | Buffer): ReturnType<typeof readLastLaunch> {
  const path = join(dir, LAST_LAUNCH_FILE);
  writeFileSync(path, text);
  return readLastLaunch(path);
}

/** A record as the writer would produce it, with parts replaced to build a hostile one. */
const record = (parts: Record<string, unknown> = {}): string => `${JSON.stringify({ version: 1, model: MODEL, profile: null, ...parts })}\n`;

const UNKNOWN_VERSION = "was written in an unknown format version";
const BAD_MODEL = "has an invalid model id";
const BAD_PROFILE = "has an invalid profile name";

function assertUnreadable(result: ReturnType<typeof readLastLaunch>, reason: string | RegExp, label: string): void {
  assert.equal(result.state, "unreadable", `${label} must read as unreadable`);
  if (result.state !== "unreadable") return;
  if (typeof reason === "string") assert.equal(result.reason, reason, label);
  else assert.match(result.reason, reason, label);
}

test("lastLaunch unreadable, shape: empty, blank, not JSON and not an object read as unreadable with fixed words only", (t) => {
  const dir = tempDir(t);
  assertUnreadable(readRaw(dir, ""), "is empty", "an empty file");
  assertUnreadable(readRaw(dir, "   \n\t \n"), "is empty", "a blank file");
  assertUnreadable(readRaw(dir, "SECRET-TOKEN-1234 {not json"), "is not valid JSON", "text that is not JSON");
  for (const text of ["[1,2]", "42", '"SECRET-TOKEN-1234"', "null", "true"]) {
    assertUnreadable(readRaw(dir, text), "must contain a JSON object", `the JSON text ${text}`);
  }
});

test("lastLaunch unreadable, size: a file larger than the cap is refused", (t) => {
  const dir = tempDir(t);
  const padding = " ".repeat(MAX_LAST_LAUNCH_BYTES + 1 - Buffer.byteLength(record()));
  const text = record().trimEnd() + padding;
  assert.equal(Buffer.byteLength(text), MAX_LAST_LAUNCH_BYTES + 1);
  assertUnreadable(readRaw(dir, text), "is larger than 8 KiB", "one byte over the cap");
  assert.equal(readRaw(dir, record()).state, "ok", "the same record without padding reads");
});

test("lastLaunch unreadable, kind: a directory at the path is refused without being read", (t) => {
  const dir = tempDir(t);
  const path = join(dir, LAST_LAUNCH_FILE);
  mkdirSync(path);
  assertUnreadable(readLastLaunch(path), "is not a regular file", "a directory");
});

test("lastLaunch unreadable, permission: a file that cannot be read says so with the error code", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs a non-root POSIX user" : false }, (t) => {
  const dir = tempDir(t);
  const path = join(dir, LAST_LAUNCH_FILE);
  writeFileSync(path, record());
  chmodSync(path, 0o000);
  t.after(() => chmodSync(path, 0o600));
  assertUnreadable(readLastLaunch(path), /^cannot be read \(EACCES\)$/, "a file with no read permission");
});

test("lastLaunch unreadable, version: only the number 1 is a known format version", (t) => {
  const dir = tempDir(t);
  for (const version of [0, 2, "1", 1.5, null, true, [1]]) {
    assertUnreadable(readRaw(dir, record({ version })), UNKNOWN_VERSION, `version ${JSON.stringify(version)}`);
  }
  assertUnreadable(readRaw(dir, '{"model":"a/b","profile":null}\n'), UNKNOWN_VERSION, "a missing version");
  assert.deepEqual(readRaw(dir, record({ version: 1 })), { state: "ok", value: { model: MODEL, profile: null } });
});

test("lastLaunch unreadable, keys: exactly version, model and profile, and no key is ever copied onto another object", (t) => {
  const dir = tempDir(t);
  const fields = /^does not hold exactly the fields version, model and profile$/;
  assertUnreadable(readRaw(dir, record({ port: 8080 })), fields, "an extra key");
  assertUnreadable(readRaw(dir, '{"version":1,"model":"a/b"}\n'), fields, "a missing profile key");
  assertUnreadable(readRaw(dir, '{"version":1,"profile":null}\n'), fields, "a missing model key");
  assertUnreadable(readRaw(dir, '{"version":1,"model":"a/b","profile":null,"__proto__":{"polluted":true}}\n'), fields, "a __proto__ key in the text");
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, "Object.prototype is untouched");
});

test("lastLaunch unreadable, model: a non-string, an empty, padded, dash-leading, control-character or overlong id is refused", (t) => {
  const dir = tempDir(t);
  const hostile: unknown[] = [5, null, ["a/b"], {}, "", " a/b", "a/b ", "\ta/b", "-x", "--port", "--foo=bar", "a/\u0000b", "a/\u001b[31mb", "a/b\nc", "a/\u007fb", "a/\u0085b", "a/\u009fb", "x".repeat(4097)];
  for (const model of hostile) {
    assertUnreadable(readRaw(dir, record({ model })), BAD_MODEL, `model ${JSON.stringify(model)?.slice(0, 30)}`);
  }
  const longest = "m".repeat(4096);
  assert.deepEqual(readRaw(dir, record({ model: longest })), { state: "ok", value: { model: longest, profile: null } });
  assert.deepEqual(readRaw(dir, record({ model: "/Users/me/models/My Model" })), { state: "ok", value: { model: "/Users/me/models/My Model", profile: null } });
});

test("lastLaunch unreadable, profile: a number, an empty or malformed name or a 65-character name is refused", (t) => {
  const dir = tempDir(t);
  for (const profile of [5, true, "", "-x", ".x", "a b", "a/b", "x".repeat(65), ["fast"]]) {
    assertUnreadable(readRaw(dir, record({ profile })), BAD_PROFILE, `profile ${JSON.stringify(profile)}`);
  }
  for (const profile of ["a.b_c-1", "x".repeat(64), null]) {
    assert.deepEqual(readRaw(dir, record({ profile })), { state: "ok", value: { model: MODEL, profile } });
  }
});

test("lastLaunch hostile text never echoed: a reason carries no escape sequence, credential or path", (t) => {
  const dir = tempDir(t);
  const secrets = ["\u001b]0;pwned\u0007", "sk-live-SECRET-CREDENTIAL", "https://user:hunter2@example.com/"];
  const results = [
    readRaw(dir, record({ model: `${secrets[0]} ${secrets[1]}` })),
    readRaw(dir, record({ profile: secrets.join(" ") })),
    readRaw(dir, record({ version: secrets.join(" ") })),
    readRaw(dir, `${secrets.join(" ")} {`),
    readRaw(dir, `{"${secrets.join(" ")}":1}`),
  ];
  for (const result of results) {
    assert.equal(result.state, "unreadable");
    if (result.state !== "unreadable") continue;
    for (const piece of ["\u001b", "pwned", "SECRET", "hunter2", "example.com", dir, LAST_LAUNCH_FILE]) {
      assert.equal(result.reason.includes(piece), false, `reason ${JSON.stringify(result.reason)} must not contain ${JSON.stringify(piece)}`);
    }
    assert.match(result.reason, /^[A-Za-z0-9 ,]+$/, "a reason is plain words");
  }
});

test("lastLaunch accepts a leading byte-order mark like the config reader", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readRaw(dir, `\uFEFF${record({ profile: "fast" })}`), { state: "ok", value: { model: MODEL, profile: "fast" } });
});

test("lastLaunch write refuses what it could not read back and touches no file", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "data", LAST_LAUNCH_FILE);
  const badModels = ["", "-x", "a/\u001bb", "a/\u007fb", "a/\u0085b", "x".repeat(4097), " a/b", "a/b "];
  for (const model of badModels) {
    assert.deepEqual(writeLastLaunch(path, { model, profile: null }), { ok: false, reason: "the model id cannot be remembered" }, JSON.stringify(model).slice(0, 30));
  }
  for (const profile of ["", "-x", ".x", "a b", "x".repeat(65)]) {
    assert.deepEqual(writeLastLaunch(path, { model: MODEL, profile }), { ok: false, reason: "the profile name cannot be remembered" }, profile);
  }
  assert.equal(existsSync(join(dir, "data")), false, "a refused record does not even create the data directory");
  assert.deepEqual(writeLastLaunch(path, { model: MODEL, profile: "fast" }), { ok: true });
  const before = readFileSync(path, "utf8");
  assert.deepEqual(writeLastLaunch(path, { model: "-x", profile: "fast" }), { ok: false, reason: "the model id cannot be remembered" });
  assert.equal(readFileSync(path, "utf8"), before, "an existing valid record stays as it was");
  assert.deepEqual(readdirSync(join(dir, "data")), [LAST_LAUNCH_FILE]);
});

test("lastLaunch write refuses a record whose text would be larger than the cap", (t) => {
  const dir = tempDir(t);
  const path = join(dir, LAST_LAUNCH_FILE);
  // Every quote is escaped in the JSON text, so 4096 of them are about 8 KiB of record.
  const model = '"'.repeat(4096);
  const result = writeLastLaunch(path, { model, profile: null });
  assert.deepEqual(result, { ok: false, reason: "the record is too large to remember" });
  assert.deepEqual(readdirSync(dir), []);
});

test("lastLaunch write stores only the version, the model id and the profile name", (t) => {
  const dir = tempDir(t);
  const path = join(dir, LAST_LAUNCH_FILE);
  const withExtras = { model: MODEL, profile: "fast", port: 9999, temperature: 0.2, flags: ["--trust-remote-code"] } as unknown as { model: string; profile: string };
  assert.deepEqual(writeLastLaunch(path, withExtras), { ok: true });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")) as object), ["version", "model", "profile"]);
  assert.equal(readFileSync(path, "utf8"), `{"version":1,"model":"${MODEL}","profile":"fast"}\n`);
});

test("lastLaunch write failure keeps the old record: a directory at the target fails and leaves no temporary file", (t) => {
  const dir = tempDir(t);
  const path = join(dir, LAST_LAUNCH_FILE);
  mkdirSync(path);
  const result = writeLastLaunch(path, { model: MODEL, profile: null });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /^[A-Za-z0-9 ]{1,40}$/, "the reason is an error code or a fixed phrase");
  assert.deepEqual(readdirSync(dir), [LAST_LAUNCH_FILE], "no temporary file remains");
  assert.equal(statSync(path).isDirectory(), true);
});

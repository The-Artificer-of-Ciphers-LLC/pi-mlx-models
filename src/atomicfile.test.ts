import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomicfile.js";

const POSIX_MODES = process.platform === "win32" ? "file modes are not enforced on win32" : false;
const SYMLINKS = process.platform === "win32" ? "symlinks need privileges on win32" : false;

/** A fresh directory under the system temp directory, removed when the test ends. */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mlx-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const permissionBits = (path: string): number => statSync(path).mode & 0o777;

test("writeFileAtomic creates the missing parent directories and the file reads back byte for byte", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "a", "b", "c", "state.json");
  const text = '{"name":"héllo ✓","n":1}\n';
  assert.deepEqual(writeFileAtomic(target, text), { ok: true });
  assert.equal(readFileSync(target, "utf8"), text);
  assert.deepEqual(readFileSync(target), Buffer.from(text, "utf8"));
});

test("writeFileAtomic replaces existing content and leaves no file but the target in the directory", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "state.json");
  writeFileSync(target, "old content that is longer than the new one\n");
  assert.deepEqual(writeFileAtomic(target, "new\n"), { ok: true });
  assert.equal(readFileSync(target, "utf8"), "new\n");
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("writeFileAtomic gives a new file mode 0o600 by default and the mode asked for when one is passed", { skip: POSIX_MODES }, (t) => {
  const dir = tempDir(t);
  const plain = join(dir, "plain.json");
  assert.deepEqual(writeFileAtomic(plain, "x"), { ok: true });
  assert.equal(permissionBits(plain), 0o600);
  const wider = join(dir, "wider.json");
  assert.deepEqual(writeFileAtomic(wider, "x", { mode: 0o644 }), { ok: true });
  assert.equal(permissionBits(wider), 0o644);
});

test("writeFileAtomic with keepMode keeps the permission bits of the existing file; without it the file gets the default", { skip: POSIX_MODES }, (t) => {
  const dir = tempDir(t);
  const kept = join(dir, "kept.json");
  writeFileSync(kept, "old");
  chmodSync(kept, 0o640);
  assert.deepEqual(writeFileAtomic(kept, "new", { keepMode: true }), { ok: true });
  assert.equal(readFileSync(kept, "utf8"), "new");
  assert.equal(permissionBits(kept), 0o640);
  const reset = join(dir, "reset.json");
  writeFileSync(reset, "old");
  chmodSync(reset, 0o640);
  assert.deepEqual(writeFileAtomic(reset, "new"), { ok: true });
  assert.equal(permissionBits(reset), 0o600);
  const fresh = join(dir, "fresh.json");
  assert.deepEqual(writeFileAtomic(fresh, "new", { keepMode: true, mode: 0o644 }), { ok: true });
  assert.equal(permissionBits(fresh), 0o644, "keepMode on a file that does not exist yet falls back to mode");
});

test("writeFileAtomic with followSymlink writes the file behind the link and keeps the link", { skip: SYMLINKS }, (t) => {
  const dir = tempDir(t);
  const real = join(dir, "dotfiles", "config.json");
  mkdirSync(join(dir, "dotfiles"));
  writeFileSync(real, "old");
  const link = join(dir, "config.json");
  symlinkSync(real, link);
  assert.deepEqual(writeFileAtomic(link, "through the link", { followSymlink: true }), { ok: true });
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
  assert.equal(readFileSync(real, "utf8"), "through the link");
  assert.equal(readFileSync(link, "utf8"), "through the link");
  assert.deepEqual(readdirSync(join(dir, "dotfiles")), ["config.json"]);
});

test("writeFileAtomic without followSymlink replaces the link with a regular file and leaves the file behind it alone", { skip: SYMLINKS }, (t) => {
  const dir = tempDir(t);
  const real = join(dir, "real.json");
  writeFileSync(real, "behind the link");
  const link = join(dir, "link.json");
  symlinkSync(real, link);
  assert.deepEqual(writeFileAtomic(link, "replaced"), { ok: true });
  assert.ok(!lstatSync(link).isSymbolicLink(), "the link is now a regular file");
  assert.equal(readFileSync(link, "utf8"), "replaced");
  assert.equal(readFileSync(real, "utf8"), "behind the link");
});

test("writeFileAtomic with followSymlink and a link to nothing creates the file behind the link and keeps the link", { skip: SYMLINKS }, (t) => {
  const dir = tempDir(t);
  const real = join(dir, "dotfiles", "config.json");
  mkdirSync(join(dir, "dotfiles"));
  const link = join(dir, "config.json");
  symlinkSync(real, link);
  assert.deepEqual(writeFileAtomic(link, "through the dangling link", { followSymlink: true }), { ok: true });
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
  assert.equal(readFileSync(real, "utf8"), "through the dangling link");
  assert.deepEqual(readdirSync(join(dir, "dotfiles")), ["config.json"]);
});

test("writeFileAtomic with followSymlink follows a relative link and a chain of links to nothing, creating the missing directory", { skip: SYMLINKS }, (t) => {
  const dir = tempDir(t);
  const first = join(dir, "first.json");
  const second = join(dir, "second.json");
  symlinkSync("second.json", first);
  symlinkSync(join("managed", "config.json"), second);
  assert.deepEqual(writeFileAtomic(first, "end of the chain", { followSymlink: true }), { ok: true });
  assert.ok(lstatSync(first).isSymbolicLink());
  assert.ok(lstatSync(second).isSymbolicLink());
  assert.equal(readFileSync(join(dir, "managed", "config.json"), "utf8"), "end of the chain");
});

test("writeFileAtomic with followSymlink and a loop of links gives up with a reason and leaves the links alone", { skip: SYMLINKS }, (t) => {
  const dir = tempDir(t);
  const a = join(dir, "a.json");
  const b = join(dir, "b.json");
  symlinkSync("b.json", a);
  symlinkSync("a.json", b);
  const outcome = writeFileAtomic(a, "never", { followSymlink: true });
  assert.equal(outcome.ok, false);
  assert.ok(lstatSync(a).isSymbolicLink());
  assert.ok(lstatSync(b).isSymbolicLink());
});

test("writeFileAtomic with followSymlink writes a plain path that does not exist yet", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "missing", "config.json");
  assert.deepEqual(writeFileAtomic(target, "created", { followSymlink: true }), { ok: true });
  assert.equal(readFileSync(target, "utf8"), "created");
});

test("writeFileAtomic failure with a regular file where a directory is needed returns a reason and changes nothing", (t) => {
  const dir = tempDir(t);
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "I am a file");
  const sibling = join(dir, "sibling.json");
  writeFileSync(sibling, "untouched");
  const result = writeFileAtomic(join(blocker, "state.json"), "never written");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.length > 0);
  assert.equal(readFileSync(blocker, "utf8"), "I am a file");
  assert.equal(readFileSync(sibling, "utf8"), "untouched");
  assert.deepEqual(readdirSync(dir).sort(), ["blocker", "sibling.json"]);
});

test("writeFileAtomic failure when the target is a directory leaves the directory intact and no temp file behind", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "state.json");
  mkdirSync(target);
  writeFileSync(join(target, "inside.txt"), "keep me");
  const result = writeFileAtomic(target, "text that cannot replace a directory");
  assert.equal(result.ok, false);
  assert.ok(statSync(target).isDirectory());
  assert.equal(readFileSync(join(target, "inside.txt"), "utf8"), "keep me");
  assert.deepEqual(readdirSync(dir), ["state.json"]);
  assert.deepEqual(readdirSync(target), ["inside.txt"]);
});

test("writeFileAtomic failure keeps the previous content of an existing target when its directory cannot take a new file", { skip: POSIX_MODES }, (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores directory permissions");
    return;
  }
  const dir = tempDir(t);
  const target = join(dir, "state.json");
  writeFileSync(target, "previous");
  chmodSync(dir, 0o500);
  let result: ReturnType<typeof writeFileAtomic>;
  try {
    result = writeFileAtomic(target, "replacement");
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(result.ok, false);
  assert.equal(readFileSync(target, "utf8"), "previous");
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("writeFileAtomic reason is a short errno code or fixed phrase and never holds the path or the text", (t) => {
  const dir = tempDir(t);
  const blocker = join(dir, "SECRET-DIRECTORY-NAME");
  writeFileSync(blocker, "x");
  const text = "SECRET-TEXT-OF-THE-WRITE";
  const result = writeFileAtomic(join(blocker, "child.json"), text);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.reason.length > 0 && result.reason.length <= 40, result.reason);
  assert.ok(!result.reason.includes("SECRET"), result.reason);
  assert.ok(!result.reason.includes(dir), result.reason);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(result.reason), "a single clean line");
  const directory = join(dir, "a-directory");
  mkdirSync(directory);
  const refused = writeFileAtomic(directory, text);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && /^[A-Z][A-Z0-9_]*$|^write failed$/.test(refused.reason), !refused.ok ? refused.reason : "");
});

test("writeFileAtomic several writes in a row from one process all succeed and the last one wins", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "state.json");
  for (let index = 0; index < 25; index += 1) {
    assert.deepEqual(writeFileAtomic(target, `write ${index}\n`), { ok: true }, `write ${index}`);
  }
  assert.equal(readFileSync(target, "utf8"), "write 24\n");
  assert.deepEqual(readdirSync(dir), ["state.json"]);
  // The same base name in two directories, written alternately, collides on nothing either.
  const other = join(dir, "other", "state.json");
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(writeFileAtomic(other, `other ${index}`), { ok: true });
    assert.deepEqual(writeFileAtomic(target, `again ${index}`), { ok: true });
  }
  assert.equal(readFileSync(other, "utf8"), "other 4");
  assert.equal(readFileSync(target, "utf8"), "again 4");
});

test("writeFileAtomic does not refuse an empty string: the callers do", (t) => {
  const dir = tempDir(t);
  const target = join(dir, "empty.json");
  assert.deepEqual(writeFileAtomic(target, ""), { ok: true });
  assert.ok(existsSync(target));
  assert.equal(readFileSync(target, "utf8"), "");
  assert.equal(statSync(target).size, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmationFor, renderConfig } from "./configedit.js";
import { ACTION, type ConfigMenuUi, MENU, runConfigMenu } from "./configmenu.js";
import { SETTINGS, readLayerFile } from "./settings.js";
import { makeCtx, scriptInput, scriptSelect } from "./testkit.js";

/** A fresh directory under the system temp directory, removed when the test ends. */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mlx-configmenu-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface SessionOptions {
  /** The file to start with: an object is written as JSON, a string as it is; absent means no file. */
  file?: unknown;
  select?: Array<string | number | undefined>;
  input?: Array<string | undefined>;
  confirm?: boolean | ((title: string, message: string) => boolean);
  serverRunning?: boolean;
  hasUI?: boolean;
  /** Replaces methods of the UI, for a dialog that throws or answers undefined. */
  ui?: Partial<ConfigMenuUi>;
}

/** A scripted menu session over a real temporary config file. */
function session(t: { after(fn: () => void): void }, options: SessionOptions = {}) {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  if (options.file !== undefined) writeFileSync(path, typeof options.file === "string" ? options.file : pretty(options.file));
  const select = scriptSelect(...(options.select ?? []));
  const input = scriptInput(...(options.input ?? []));
  const kit = makeCtx(select, { input, confirm: options.confirm, hasUI: options.hasUI });
  const ui: ConfigMenuUi = { ...kit.ctx.ui, ...options.ui };
  return {
    dir,
    path,
    select,
    input,
    ...kit,
    run: () => runConfigMenu({ ui, hasUI: options.hasUI ?? true, path, serverRunning: options.serverRunning ?? false }),
    text: () => readFileSync(path, "utf8"),
    json: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
    /** The script and the menu agreed: no answer matched nothing and none is left over. */
    assertScriptsUsed() {
      assert.deepEqual(select.errors, []);
      assert.equal(select.remaining(), 0, "unused select answers");
      assert.equal(input.remaining(), 0, "unused input answers");
    },
  };
}

const row = (path: string) => {
  const found = SETTINGS.find((candidate) => candidate.path === path);
  assert.ok(found, `no settings row ${path}`);
  return found;
};

test("configmenu sets a general setting: the key is written, the notice names it and says it takes effect on the next start", async (t) => {
  const s = session(t, { file: {}, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["8081"] });
  await s.run();
  assert.deepEqual(s.json(), { server: { port: 8081 } });
  const saved = s.notes.filter((note) => note.message.includes("server.port") && /next \/mlx-start/.test(note.message));
  assert.equal(saved.length, 1, JSON.stringify(s.notes));
  assert.equal(saved[0].type, "info");
  assert.match(saved[0].message, /^Saved server\.port\./);
  assert.equal(s.confirms.length, 0);
  s.assertScriptsUsed();
});

test("configmenu points to /mlx-restart only when a server of this session is running, and never restarts anything", async (t) => {
  const running = session(t, { file: {}, serverRunning: true, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["8082"] });
  await running.run();
  const withPointer = running.notes.find((note) => note.message.includes("server.port"));
  assert.ok(withPointer);
  assert.match(withPointer.message, /\/mlx-restart/);
  assert.match(withPointer.message, /next \/mlx-start/);

  const idle = session(t, { file: {}, serverRunning: false, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["8082"] });
  await idle.run();
  const without = idle.notes.find((note) => note.message.includes("server.port"));
  assert.ok(without);
  assert.doesNotMatch(without.message, /\/mlx-restart/);
  running.assertScriptsUsed();
  idle.assertScriptsUsed();
});

test("configmenu view: the view entry notifies the text renderConfig gives for the file and writes nothing", async (t) => {
  const before = pretty({ server: { port: 8081 } });
  const s = session(t, { file: before, select: [MENU.view, MENU.done] });
  await s.run();
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0].message, renderConfig(readLayerFile(s.path), s.path));
  assert.equal(s.notes[0].type, "info");
  assert.equal(s.text(), before);
  s.assertScriptsUsed();
});

test("configmenu asks before a sensitive key: autoStart true opens one confirm built by confirmationFor; no and false do not write", async (t) => {
  const autoStart = row("autoStart");
  const expected = confirmationFor(autoStart, true);
  assert.ok(expected);

  const yes = session(t, { file: {}, confirm: true, select: [MENU.general, "autoStart", "true", MENU.done] });
  await yes.run();
  assert.deepEqual(yes.json(), { autoStart: true });
  assert.equal(yes.confirms.length, 1);
  assert.deepEqual(yes.confirms[0], expected);
  yes.assertScriptsUsed();

  const before = pretty({ server: { port: 8080 } });
  const no = session(t, { file: before, confirm: false, select: [MENU.general, "autoStart", "true", MENU.done] });
  await no.run();
  assert.equal(no.text(), before);
  assert.equal(no.confirms.length, 1);
  const info = no.notes.find((note) => /nothing was saved/i.test(note.message));
  assert.ok(info, JSON.stringify(no.notes));
  assert.equal(info.type, "info");
  no.assertScriptsUsed();

  const off = session(t, { file: {}, select: [MENU.general, "autoStart", "false", MENU.done] });
  await off.run();
  assert.deepEqual(off.json(), { autoStart: false });
  assert.equal(off.confirms.length, 0);
  off.assertScriptsUsed();
});

test("configmenu rejects a bad typed value: the notice holds the expected text, nothing is written and the menu goes on", async (t) => {
  const before = pretty({ server: { port: 8080 } });
  const s = session(t, { file: before, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["70000"] });
  await s.run();
  assert.equal(s.text(), before);
  const error = s.notes.find((note) => note.type === "error");
  assert.ok(error, JSON.stringify(s.notes));
  assert.ok(error.message.includes(row("server.port").expected), error.message);
  s.assertScriptsUsed();
});

test("configmenu dismissal: select undefined at the top level ends the menu; input undefined leaves the file and returns to the menu", async (t) => {
  const top = session(t, { select: [undefined, MENU.general] });
  await top.run();
  assert.equal(existsSync(top.path), false);
  assert.equal(top.select.remaining(), 1, "the menu ended at the dismissal");
  assert.equal(top.prompts.length, 1);

  const before = pretty({ server: { port: 8080 } });
  const typed = session(t, { file: before, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: [undefined] });
  await typed.run();
  assert.equal(typed.text(), before);
  assert.equal(typed.notes.some((note) => note.type === "error"), false);
  typed.assertScriptsUsed();
});

test("configmenu kit: makeCtx gives the select callback its title and records every dialog in order", async () => {
  const seen: string[] = [];
  const kit = makeCtx(
    (options, title) => {
      seen.push(title);
      return options[1];
    },
    { input: (title, placeholder) => `${title}|${placeholder ?? "-"}`, confirm: (title, message) => title === "yes" && message === "m" },
  );
  assert.equal(await kit.ctx.ui.select("pick", ["a", "b"]), "b");
  assert.equal(await kit.ctx.ui.input("name", "hint"), "name|hint");
  assert.equal(await kit.ctx.ui.confirm("yes", "m"), true);
  assert.equal(await kit.ctx.ui.confirm("no", "m"), false);
  assert.deepEqual(seen, ["pick"]);
  assert.deepEqual(kit.prompts, [
    { kind: "select", title: "pick", options: ["a", "b"] },
    { kind: "input", title: "name" },
    { kind: "confirm", title: "yes", message: "m" },
    { kind: "confirm", title: "no", message: "m" },
  ]);
  assert.deepEqual(kit.confirms, [
    { title: "yes", message: "m" },
    { title: "no", message: "m" },
  ]);
});

test("configmenu kit: without an input option ui.input answers undefined, and a boolean confirm option still works", async () => {
  const kit = makeCtx(undefined, { confirm: false });
  assert.equal(await kit.ctx.ui.input("name"), undefined);
  assert.equal(await kit.ctx.ui.confirm("t", "m"), false);
  assert.equal(await makeCtx().ctx.ui.confirm("t", "m"), true);
});

test("configmenu kit: scriptSelect picks by text or index, answers undefined for a dismissal or an exhausted script and records a mismatch", () => {
  const select = scriptSelect("two", 0, undefined, "missing", 9);
  const options = ["one", "two", "twenty"];
  assert.equal(select(options, "t"), "two");
  assert.equal(select(options, "t"), "one");
  assert.equal(select(options, "t"), undefined);
  assert.deepEqual(select.errors, []);
  assert.equal(select(options, "t"), undefined);
  assert.equal(select(options, "t"), undefined);
  assert.equal(select.errors.length, 2);
  assert.match(select.errors[0], /"missing"/);
  assert.match(select.errors[0], /"twenty"/);
  assert.equal(select.remaining(), 0);
  assert.equal(select(options, "t"), undefined);
  assert.equal(select.errors.length, 2, "an exhausted script is not a mismatch");

  const input = scriptInput("a", undefined, "c");
  assert.equal(input("t"), "a");
  assert.equal(input("t"), undefined);
  assert.equal(input.remaining(), 1);
  assert.equal(input("t"), "c");
  assert.equal(input("t"), undefined);
  assert.equal(input.remaining(), 0);
});

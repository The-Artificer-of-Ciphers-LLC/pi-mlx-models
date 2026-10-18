import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmationFor, renderConfig, setAt } from "./configedit.js";
import { ACTION, CARRY_MAX_CHARS, CARRY_MAX_LINES, type ConfigMenuUi, MENU, MENU_TITLE, NEW_ENTRY, NEW_PROFILE, NO_DEFAULT, PROFILE_ACTION, carriedCopy, runConfigMenu } from "./configmenu.js";
import { MODEL_PRESETS } from "./presets.js";
import { PROFILE_NAME_SHORT_RULE, SETTINGS, prepareSettings, readLayerFile } from "./settings.js";
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
  /** Put the config file in a directory that does not exist yet. */
  nested?: boolean;
  /** Replaces methods of the UI, for a dialog that throws or answers undefined. */
  ui?: Partial<ConfigMenuUi>;
}

/** A scripted menu session over a real temporary config file. */
function session(t: { after(fn: () => void): void }, options: SessionOptions = {}) {
  const dir = tempDir(t);
  const path = options.nested === true ? join(dir, "data", "config.json") : join(dir, "config.json");
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

test("configmenu model block: the options that apply to every model are written inside the model block", async (t) => {
  const s = session(t, { file: {}, select: [MENU.modelBlock, "model.sampling.temperature", ACTION.set, MENU.done], input: ["0.3"] });
  await s.run();
  assert.deepEqual(s.json(), { model: { sampling: { temperature: 0.3 } } });
  assert.ok(s.notes.some((note) => /^Saved model\.sampling\.temperature\./.test(note.message)), JSON.stringify(s.notes));
  s.assertScriptsUsed();
});

test("configmenu new model entry: NEW_ENTRY asks for a key, an existing entry does not, and a bad key is an error that writes nothing", async (t) => {
  const created = session(t, { select: [MENU.modelEntry, NEW_ENTRY, "numDraftTokens", ACTION.set, MENU.done], input: ["qwen3_4b", "2"] });
  await created.run();
  assert.deepEqual(created.json(), { models: { qwen3_4b: { numDraftTokens: 2 } } });
  const keyPrompt = created.prompts.find((prompt) => prompt.kind === "input");
  assert.ok(keyPrompt);
  assert.match(keyPrompt.title, /qwen3_4b/, "the prompt names the preset keys");
  assert.match(keyPrompt.title, /Hugging Face/);
  created.assertScriptsUsed();

  const existing = session(t, { file: { models: { qwen3_4b: { numDraftTokens: 2 } } }, select: [MENU.modelEntry, "qwen3_4b", "numDraftTokens", ACTION.set, MENU.done], input: ["3"] });
  await existing.run();
  assert.deepEqual(existing.json(), { models: { qwen3_4b: { numDraftTokens: 3 } } });
  assert.equal(existing.prompts.filter((prompt) => prompt.kind === "input").length, 1, "only the value is asked for");
  existing.assertScriptsUsed();

  const bad = session(t, {
    select: [MENU.modelEntry, NEW_ENTRY, MENU.modelEntry, NEW_ENTRY, MENU.modelEntry, NEW_ENTRY, MENU.done],
    input: ["", "-x", "a\u0007b"],
  });
  await bad.run();
  assert.equal(existsSync(bad.path), false);
  assert.equal(bad.notes.filter((note) => note.type === "error").length, 3, JSON.stringify(bad.notes));
  bad.assertScriptsUsed();
});

test("configmenu WR-01: a typed model key that cannot match asks Add anyway, states a likelihood and a no writes nothing", async (t) => {
  const s = session(t, { confirm: false, select: [MENU.profiles, NEW_ENTRY, MENU.done], input: ["careful"] });
  await s.run();
  assert.equal(s.confirms.length, 1, JSON.stringify(s.prompts));
  assert.match(s.confirms[0].title, /careful/);
  assert.match(s.confirms[0].title, /anyway\?/);
  for (const preset of MODEL_PRESETS) assert.ok(s.confirms[0].message.includes(preset.key), preset.key);
  const message = s.confirms[0].message;
  assert.match(message, /unlikely/);
  assert.match(message, /exactly/);
  assert.match(message, /no slash/);
  assert.match(message, /profile name/);
  assert.match(message, /Yes adds it anyway/);
  assert.doesNotMatch(message, /\b(no start|never)\b/i);
  assert.equal(existsSync(s.path), false);
  assert.ok(s.notes.some((note) => note.type === "info" && /nothing was added/i.test(note.message)), JSON.stringify(s.notes));
  s.assertScriptsUsed();
});

test("configmenu typed model key that cannot match: a yes adds the entry and a profile can be created under it", async (t) => {
  const s = session(t, { confirm: true, select: [MENU.profiles, NEW_ENTRY, NEW_PROFILE, PROFILE_ACTION.back, MENU.done], input: ["careful", "fast"] });
  await s.run();
  assert.deepEqual(s.json(), { models: { careful: { profiles: { fast: {} } } } });
  const file = readLayerFile(s.path);
  assert.equal(file.state, "ok");
  assert.equal(prepareSettings({ global: file, env: {} }).ok, true);
  assert.equal(s.confirms.length, 1);
  s.assertScriptsUsed();
});

test("configmenu WR-01: a bare model id such as gpt2 is asked about as unlikely, and a yes adds it", async (t) => {
  const s = session(t, { confirm: true, select: [MENU.profiles, NEW_ENTRY, NEW_PROFILE, PROFILE_ACTION.back, MENU.done], input: ["gpt2", "fast"] });
  await s.run();
  assert.equal(s.confirms.length, 1, JSON.stringify(s.prompts));
  assert.match(s.confirms[0].message, /unlikely/);
  assert.doesNotMatch(s.confirms[0].message, /\b(no start|never)\b/i);
  assert.deepEqual(s.json(), { models: { gpt2: { profiles: { fast: {} } } } });
  const file = readLayerFile(s.path);
  assert.equal(file.state, "ok");
  assert.equal(prepareSettings({ global: file, env: {} }).ok, true);
  s.assertScriptsUsed();
});

test("configmenu 06 review IN-06: an all-digit model key is asked about with a sentence that a number is read as a preset number, and other keys do not get it", async (t) => {
  const digits = session(t, { confirm: true, select: [MENU.profiles, NEW_ENTRY, NEW_PROFILE, PROFILE_ACTION.back, MENU.done], input: ["2", "fast"] });
  await digits.run();
  assert.equal(digits.confirms.length, 1, JSON.stringify(digits.prompts));
  assert.match(digits.confirms[0].message, /preset number/);
  assert.match(digits.confirms[0].message, /unlikely/);
  assert.deepEqual(digits.json(), { models: { "2": { profiles: { fast: {} } } } });
  digits.assertScriptsUsed();

  const word = session(t, { confirm: true, select: [MENU.profiles, NEW_ENTRY, NEW_PROFILE, PROFILE_ACTION.back, MENU.done], input: ["gpt2", "fast"] });
  await word.run();
  assert.equal(word.confirms.length, 1);
  assert.doesNotMatch(word.confirms[0].message, /preset number/);
  word.assertScriptsUsed();
});

test("configmenu typed model key that can match asks nothing: a preset key, org/name and local paths are added directly", async (t) => {
  for (const key of ["qwen3_4b", "org/name", "/abs/path/model", "./rel/model", "../up/model"]) {
    const s = session(t, { confirm: true, select: [MENU.profiles, NEW_ENTRY, NEW_PROFILE, PROFILE_ACTION.back, MENU.done], input: [key, "fast"] });
    await s.run();
    assert.deepEqual(s.json(), { models: { [key]: { profiles: { fast: {} } } } }, key);
    assert.equal(s.confirms.length, 0, key);
    s.assertScriptsUsed();
  }
});

test("configmenu a typed model key is asked about only when it is new: a key picked from the list and a typed key already in the file ask nothing", async (t) => {
  const file = { models: { careful: {} } };
  const picked = session(t, { file, select: [MENU.modelEntry, "1. careful", "numDraftTokens", ACTION.set, MENU.done], input: ["2"] });
  await picked.run();
  assert.deepEqual(picked.json(), { models: { careful: { numDraftTokens: 2 } } });
  assert.equal(picked.confirms.length, 0);
  picked.assertScriptsUsed();

  const retyped = session(t, { file, select: [MENU.modelEntry, NEW_ENTRY, "numDraftTokens", ACTION.set, MENU.done], input: ["careful", "2"] });
  await retyped.run();
  assert.deepEqual(retyped.json(), { models: { careful: { numDraftTokens: 2 } } });
  assert.equal(retyped.confirms.length, 0);
  retyped.assertScriptsUsed();

  const other = session(t, { file, confirm: false, select: [MENU.modelEntry, NEW_ENTRY, MENU.done], input: ["fast"] });
  await other.run();
  assert.equal(other.confirms.length, 1);
  assert.deepEqual(other.json(), file);
  other.assertScriptsUsed();
});

test("configmenu the Add anyway question fails closed: no, undefined and a throw add nothing, a yes adds the entry", async (t) => {
  const answers: Array<[string, Partial<ConfigMenuUi>, boolean]> = [
    ["no", { confirm: async () => false }, false],
    ["undefined", { confirm: async () => undefined as unknown as boolean }, false],
    ["throw", { confirm: async () => { throw new Error("dialog failed"); } }, false],
    ["yes", { confirm: async () => true }, true],
  ];
  for (const [answer, ui, writes] of answers) {
    const select = writes ? [MENU.profiles, NEW_ENTRY, NEW_PROFILE, PROFILE_ACTION.back, MENU.done] : [MENU.profiles, NEW_ENTRY, MENU.done];
    const s = session(t, { select, input: writes ? ["careful", "fast"] : ["careful"], ui });
    await s.run();
    s.assertScriptsUsed();
    if (writes) {
      assert.deepEqual(s.json(), { models: { careful: { profiles: { fast: {} } } } }, answer);
    } else {
      assert.equal(existsSync(s.path), false, answer);
    }
  }
});

test("configmenu the Add anyway question shows a hostile key safely: credentials hidden, long text clipped, no control character", async (t) => {
  const secret = session(t, { confirm: false, select: [MENU.profiles, NEW_ENTRY, MENU.done], input: ["user:secret@host"] });
  await secret.run();
  assert.equal(secret.confirms.length, 1);
  const { title, message } = secret.confirms[0];
  assert.equal(title.includes("secret"), false, title);
  assert.equal(message.includes("secret"), false, message);
  assert.ok(title.includes("***") && message.includes("***"), `${title} | ${message}`);
  assert.equal(secret.notes.some((note) => note.message.includes("secret")), false, JSON.stringify(secret.notes));
  secret.assertScriptsUsed();

  const long = session(t, { confirm: false, select: [MENU.profiles, NEW_ENTRY, MENU.done], input: ["a".repeat(4000)] });
  await long.run();
  assert.equal(long.confirms.length, 1);
  assert.ok(long.confirms[0].title.length < 140, String(long.confirms[0].title.length));
  assert.ok(long.confirms[0].message.length < 1200, String(long.confirms[0].message.length));
  assert.equal(long.notes.some((note) => /[\u0000-\u001f\u007f-\u009f]/.test(note.message)), false);
  long.assertScriptsUsed();
});

test("configmenu add a profile: an empty profile is created, then its keys land in sampling and limits objects, and the file validates", async (t) => {
  const start = { models: { qwen3_4b: {} } };
  const created = session(t, { file: start, select: [MENU.profiles, "qwen3_4b", NEW_PROFILE, PROFILE_ACTION.back, MENU.done], input: ["fast"] });
  await created.run();
  assert.deepEqual(created.json(), { models: { qwen3_4b: { profiles: { fast: {} } } } });
  created.assertScriptsUsed();

  const s = session(t, {
    file: start,
    select: [
      MENU.profiles, "qwen3_4b", NEW_PROFILE, PROFILE_ACTION.edit, "sampling.temperature", ACTION.set,
      MENU.profiles, "qwen3_4b", "fast", PROFILE_ACTION.edit, "limits.contextWindow", ACTION.set,
      MENU.done,
    ],
    input: ["fast", "0.2", "32768"],
  });
  await s.run();
  assert.deepEqual(s.json(), { models: { qwen3_4b: { profiles: { fast: { sampling: { temperature: 0.2 }, limits: { contextWindow: 32768 } } } } } });
  const file = readLayerFile(s.path);
  assert.equal(file.state, "ok");
  assert.equal(prepareSettings({ global: file, env: {} }).ok, true);
  s.assertScriptsUsed();
});

test("configmenu profile name rule: names the rule does not allow are errors that name the rule and write nothing", async (t) => {
  const before = pretty({ models: { qwen3_4b: {} } });
  const names = ["-x", ".x", "a b", "a".repeat(65)];
  const select = names.flatMap(() => [MENU.profiles, "qwen3_4b", NEW_PROFILE]);
  const s = session(t, { file: before, select: [...select, MENU.done], input: names });
  await s.run();
  assert.equal(s.text(), before);
  const errors = s.notes.filter((note) => note.type === "error");
  assert.equal(errors.length, names.length, JSON.stringify(s.notes));
  for (const error of errors) assert.ok(error.message.includes(PROFILE_NAME_SHORT_RULE), error.message);
  s.assertScriptsUsed();
});

test("configmenu delete a profile: a confirm removes it, the default profile that named it is cleared in the same write, no leaves the file", async (t) => {
  const start = { models: { qwen3_4b: { defaultProfile: "fast", profiles: { fast: {}, slow: {} } } } };

  const named = session(t, { file: start, confirm: true, select: [MENU.profiles, "qwen3_4b", "fast", PROFILE_ACTION.delete, MENU.done] });
  await named.run();
  assert.deepEqual(named.json(), { models: { qwen3_4b: { profiles: { slow: {} } } } });
  assert.equal(named.confirms.length, 1);
  const saved = named.notes.find((note) => /defaultProfile/.test(note.message) && /next \/mlx-start/.test(note.message));
  assert.ok(saved, JSON.stringify(named.notes));
  named.assertScriptsUsed();

  const other = session(t, { file: start, confirm: true, select: [MENU.profiles, "qwen3_4b", "slow", PROFILE_ACTION.delete, MENU.done] });
  await other.run();
  assert.deepEqual(other.json(), { models: { qwen3_4b: { defaultProfile: "fast", profiles: { fast: {} } } } });
  assert.equal(other.notes.some((note) => /defaultProfile/.test(note.message)), false);

  const declined = session(t, { file: start, confirm: false, select: [MENU.profiles, "qwen3_4b", "fast", PROFILE_ACTION.delete, MENU.done] });
  await declined.run();
  assert.equal(declined.text(), pretty(start));
  assert.equal(declined.confirms.length, 1);
  declined.assertScriptsUsed();
});

test("configmenu delete a model entry: the empty entry left by deleting its last profile is removed and is gone from the file and from every model list", async (t) => {
  const s = session(t, {
    file: { models: { careful: { profiles: { fast: {} } } } },
    confirm: true,
    select: [MENU.profiles, "careful", "fast", PROFILE_ACTION.delete, MENU.deleteEntry, "careful", MENU.modelEntry, undefined, MENU.done],
  });
  await s.run();
  assert.deepEqual(s.json(), { models: {} });
  const file = readLayerFile(s.path);
  assert.equal(file.state, "ok");
  assert.equal(prepareSettings({ global: file, env: {} }).ok, true);
  assert.equal(s.confirms.length, 2);
  assert.ok(s.confirms[1].title.includes("careful"), s.confirms[1].title);
  const saved = s.notes.filter((note) => note.message.startsWith("Deleted model entry"));
  assert.equal(saved.length, 1, JSON.stringify(s.notes));
  assert.match(saved[0].message, /next \/mlx-start/);
  // The last model list is the one MENU.modelEntry opened after the delete; the first was opened before it.
  const lists = s.prompts.filter((prompt) => prompt.kind === "select" && prompt.options?.includes(NEW_ENTRY));
  assert.equal(lists.length, 2, "the profile flow's list and the model entry flow's list; the delete flow's list has no new entry");
  assert.deepEqual(lists[lists.length - 1].options, [NEW_ENTRY]);
  s.assertScriptsUsed();
});

test("configmenu delete a model entry names what is lost: the profiles, the options and the default profile are listed, and a shell says nothing is lost", async (t) => {
  const start = { models: { qwen3_4b: { numDraftTokens: 2, defaultProfile: "fast", profiles: { fast: {}, slow: {} } }, other: {} } };
  const s = session(t, { file: start, confirm: true, select: [MENU.deleteEntry, "qwen3_4b", MENU.done] });
  await s.run();
  assert.equal(s.confirms.length, 1);
  assert.ok(s.confirms[0].title.includes("qwen3_4b"), s.confirms[0].title);
  for (const part of ["fast", "slow", "numDraftTokens", "defaultProfile"]) assert.ok(s.confirms[0].message.includes(part), `${part}: ${s.confirms[0].message}`);
  assert.deepEqual(s.json(), { models: { other: {} } });
  s.assertScriptsUsed();

  const shell = session(t, { file: { models: { careful: { profiles: {} } } }, confirm: true, select: [MENU.deleteEntry, "careful", MENU.done] });
  await shell.run();
  assert.equal(shell.confirms.length, 1);
  assert.match(shell.confirms[0].message, /holds nothing/);
  assert.match(shell.confirms[0].message, /no setting is lost/);
  assert.doesNotMatch(shell.confirms[0].message, /profile/i);
  assert.deepEqual(shell.json(), { models: {} });
  shell.assertScriptsUsed();
});

test("configmenu delete a model entry declined: a no, an undefined and a throw leave the file byte for byte and the menu goes on", async (t) => {
  const start = { models: { careful: { numDraftTokens: 2, profiles: { fast: {} } } } };
  const answers: Array<[string, Partial<ConfigMenuUi>]> = [
    ["no", { confirm: async () => false }],
    ["undefined", { confirm: async () => undefined as unknown as boolean }],
    ["throw", { confirm: async () => { throw new Error("dialog failed"); } }],
  ];
  for (const [answer, ui] of answers) {
    const s = session(t, { file: start, select: [MENU.deleteEntry, "careful", MENU.done], ui });
    await s.run();
    assert.equal(s.text(), pretty(start), answer);
    s.assertScriptsUsed();
    if (answer === "no") assert.ok(s.notes.some((note) => note.type === "info" && /Nothing was deleted/.test(note.message)), JSON.stringify(s.notes));
  }
  const plain = session(t, { file: start, confirm: false, select: [MENU.deleteEntry, "careful", MENU.done] });
  await plain.run();
  assert.equal(plain.text(), pretty(start));
  assert.equal(plain.confirms.length, 1);
  assert.ok(plain.notes.some((note) => note.type === "info" && /Nothing was deleted/.test(note.message)), JSON.stringify(plain.notes));
  plain.assertScriptsUsed();

  const dismissed = session(t, { file: start, select: [MENU.deleteEntry, undefined, MENU.done] });
  await dismissed.run();
  assert.equal(dismissed.text(), pretty(start));
  assert.equal(dismissed.confirms.length, 0);
  dismissed.assertScriptsUsed();
});

test("configmenu delete a model entry with nothing to delete: no model entries open no dialog, and an unreadable file is reported and ends the menu", async (t) => {
  for (const file of [undefined, {}, { server: { port: 8081 } }, { models: {} }]) {
    const s = session(t, { file, select: [MENU.deleteEntry, MENU.done] });
    await s.run();
    assert.equal(s.confirms.length, 0);
    assert.equal(s.prompts.filter((prompt) => prompt.kind === "select").length, 2, "only the top menu was shown, twice");
    if (file === undefined) assert.equal(existsSync(s.path), false);
    else assert.equal(s.text(), pretty(file));
    assert.ok(s.notes.some((note) => note.type === "info" && /no model/i.test(note.message)), JSON.stringify(s.notes));
    s.assertScriptsUsed();
  }

  const before = "[1, 2]";
  const unreadable = session(t, { file: before, select: [MENU.deleteEntry, MENU.done] });
  await unreadable.run();
  assert.equal(unreadable.text(), before);
  assert.ok(unreadable.notes.some((note) => note.type === "error" && /not changed/.test(note.message)), JSON.stringify(unreadable.notes));
  assert.equal(unreadable.select.remaining(), 1);
  assert.equal(unreadable.confirms.length, 0);
});

test("configmenu delete a model entry with hostile names: keys are shown cleaned and removed exactly, and __proto__ is a plain key", async (t) => {
  const key = "qwen\u001b[31mred";
  const text = `{"models": {${JSON.stringify(key)}: {"numDraftTokens": 2}, "__proto__": {}}}`;
  const s = session(t, { file: text, confirm: true, select: [MENU.deleteEntry, "qwen", MENU.deleteEntry, 0, MENU.done] });
  await s.run();
  const control = /[\u0000-\u001f\u007f-\u009f]/;
  const lists = s.prompts.filter((prompt) => prompt.kind === "select" && prompt.title === "Choose the model entry to delete");
  assert.equal(lists.length, 2);
  for (const list of lists) assert.equal(list.options?.some((option) => control.test(option)), false, "no control character reaches a menu line");
  assert.equal(s.confirms.length, 2);
  for (const confirm of s.confirms) assert.equal(control.test(confirm.title) || control.test(confirm.message), false, `${confirm.title} | ${confirm.message}`);
  assert.equal(s.notes.some((note) => control.test(note.message.replace(/\n/g, " "))), false, JSON.stringify(s.notes));
  assert.equal(s.notes.filter((note) => note.message.startsWith("Deleted model entry")).length, 2, JSON.stringify(s.notes));
  assert.deepEqual(s.json(), { models: {} });
  assert.deepEqual(Object.keys(Object.prototype), []);
  s.assertScriptsUsed();
});

test("configmenu default profile: a profile name sets it, NO_DEFAULT removes it, and a model without profiles gets a notice and no write", async (t) => {
  const profiles = { fast: {}, slow: {} };
  const set = session(t, { file: { models: { qwen3_4b: { profiles } } }, select: [MENU.defaultProfile, "qwen3_4b", "slow", MENU.done] });
  await set.run();
  assert.deepEqual(set.json(), { models: { qwen3_4b: { profiles, defaultProfile: "slow" } } });
  set.assertScriptsUsed();

  const cleared = session(t, { file: { models: { qwen3_4b: { defaultProfile: "slow", profiles } } }, select: [MENU.defaultProfile, "qwen3_4b", NO_DEFAULT, MENU.done] });
  await cleared.run();
  assert.deepEqual(cleared.json(), { models: { qwen3_4b: { profiles } } });
  cleared.assertScriptsUsed();

  const none = pretty({ models: { plain: {} } });
  const without = session(t, { file: none, select: [MENU.defaultProfile, "plain", MENU.done] });
  await without.run();
  assert.equal(without.text(), none);
  assert.ok(without.notes.some((note) => /no profiles/i.test(note.message)), JSON.stringify(without.notes));
  without.assertScriptsUsed();

  const empty = session(t, { select: [MENU.defaultProfile, MENU.done] });
  await empty.run();
  assert.equal(existsSync(empty.path), false);
  assert.ok(empty.notes.some((note) => /no models/i.test(note.message)), JSON.stringify(empty.notes));
  empty.assertScriptsUsed();
});

test("configmenu offers only per-model keys in a profile: limits and sampling rows, never a server-wide key", async (t) => {
  const s = session(t, { file: { models: { qwen3_4b: { profiles: { fast: {} } } } }, select: [MENU.profiles, "qwen3_4b", "fast", PROFILE_ACTION.edit, undefined] });
  await s.run();
  const list = s.prompts.find((prompt) => prompt.kind === "select" && prompt.options?.some((option) => option.startsWith("limits.contextWindow")));
  assert.ok(list?.options, "the profile key list was shown");
  const text = list.options.join("\n");
  assert.match(text, /limits\.contextWindow/);
  assert.match(text, /sampling\.temperature/);
  for (const absent of ["server.port", "baseUrl", "autoStart"]) assert.equal(text.includes(absent), false, absent);
});

test("configmenu hostile names: __proto__ is a plain key, and a listed key with an escape sequence is shown cleaned but still edited exactly", async (t) => {
  const proto = session(t, { confirm: true, select: [MENU.modelEntry, NEW_ENTRY, "numDraftTokens", ACTION.set, MENU.done], input: ["__proto__", "2"] });
  await proto.run();
  assert.equal(proto.confirms.length, 1, "a key that can never match a start is asked about");
  const models = (proto.json() as { models: object }).models;
  assert.equal(Object.hasOwn(models, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(models), Object.prototype);
  assert.deepEqual(Object.keys(Object.prototype), []);
  assert.equal(Object.hasOwn(Object.prototype, "numDraftTokens"), false);
  proto.assertScriptsUsed();

  const key = "qwen\u001b[31mred";
  const listed = session(t, { file: pretty({ models: { [key]: {} } }), select: [MENU.modelEntry, 0, "numDraftTokens", ACTION.set, MENU.done], input: ["2"] });
  await listed.run();
  const list = listed.prompts.find((prompt) => prompt.kind === "select" && prompt.options?.includes(NEW_ENTRY));
  assert.ok(list?.options);
  assert.equal(list.options.some((option) => /[\u0000-\u001f\u007f-\u009f]/.test(option)), false, "no control character reaches a menu line");
  assert.match(list.options[0], /qwen/);
  assert.deepEqual(listed.json(), { models: { [key]: { numDraftTokens: 2 } } });
  assert.equal(listed.notes.some((note) => /[\u0000-\u001f\u007f-\u009f]/.test(note.message.replace(/\n/g, " "))), false, "no control character reaches a notice");
  listed.assertScriptsUsed();
});

test("configmenu rename is add plus delete: a profile added under a new name with the same key, then the old one deleted, leaves only the new one", async (t) => {
  const s = session(t, {
    file: { models: { qwen3_4b: { profiles: { a: { sampling: { temperature: 0.2 } } } } } },
    confirm: true,
    select: [
      MENU.profiles, "qwen3_4b", NEW_PROFILE, PROFILE_ACTION.edit, "sampling.temperature", ACTION.set,
      MENU.profiles, "qwen3_4b", "a", PROFILE_ACTION.delete,
      MENU.done,
    ],
    input: ["b", "0.2"],
  });
  await s.run();
  assert.deepEqual(s.json(), { models: { qwen3_4b: { profiles: { b: { sampling: { temperature: 0.2 } } } } } });
  s.assertScriptsUsed();
});

test("configmenu without a UI: the config is printed with a read-only warning, no dialog opens and nothing is written", async (t) => {
  const before = pretty({ server: { port: 8081 } });
  const s = session(t, { file: before, hasUI: false, select: [MENU.general, "server.port", ACTION.set], input: ["9000"] });
  await s.run();
  assert.equal(s.prompts.length, 0);
  assert.equal(s.select.remaining(), 3);
  assert.equal(s.input.remaining(), 1);
  assert.equal(s.notes.length, 2);
  assert.deepEqual(s.notes[0], { message: renderConfig(readLayerFile(s.path), s.path), type: "info" });
  assert.equal(s.notes[1].type, "warning");
  assert.match(s.notes[1].message, /interactive pi session/);
  assert.match(s.notes[1].message, /read-only/);
  assert.equal(s.text(), before);
});

test("configmenu fails closed: a dialog that throws is a dismissal, a confirm that throws or is dismissed is a no, and a notify that throws does not stop the menu", async (t) => {
  const boom = async (): Promise<never> => {
    throw new Error("dialog failed");
  };

  const top = session(t, { select: [MENU.general], ui: { select: boom } });
  await top.run();
  assert.equal(existsSync(top.path), false);
  assert.equal(top.select.remaining(), 1, "the failed select ended the menu without asking again");

  const before = pretty({ server: { port: 8080 } });
  const typed = session(t, { file: before, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["8081"], ui: { input: boom } });
  await typed.run();
  assert.equal(typed.text(), before);
  assert.equal(typed.select.remaining(), 0, "the menu went on after the failed input");

  const noisy = session(t, {
    file: {},
    select: [MENU.general, "server.port", ACTION.set, MENU.general, "server.logLevel", ACTION.set, MENU.done],
    input: ["8081", "DEBUG"],
    ui: { notify: () => { throw new Error("notify failed"); } },
  });
  await noisy.run();
  assert.deepEqual(noisy.json(), { server: { port: 8081, logLevel: "DEBUG" } });
  assert.equal(noisy.select.remaining(), 0);
});

const SENSITIVE = [
  { key: "server.trustRemoteCode", bool: true, value: true },
  { key: "server.host", text: "0.0.0.0", value: "0.0.0.0" },
  { key: "server.allowedOrigins", text: "https://example.com", value: ["https://example.com"] },
  { key: "baseUrl", text: "http://192.168.1.5:8080/v1", value: "http://192.168.1.5:8080/v1" },
  { key: "mlxLm.pipIndex", text: "https://pypi.example.org/simple", value: "https://pypi.example.org/simple" },
  { key: "autoStart", bool: true, value: true },
];

test("configmenu a sensitive key is written only after a yes: no, undefined and a throw each write nothing", async (t) => {
  const before = pretty({ server: { port: 8080 } });
  const answers: Array<[string, Partial<ConfigMenuUi> | undefined, boolean]> = [
    ["yes", undefined, true],
    ["no", { confirm: async () => false }, false],
    ["undefined", { confirm: async () => undefined as unknown as boolean }, false],
    ["throw", { confirm: async () => { throw new Error("dialog failed"); } }, false],
  ];
  for (const sensitive of SENSITIVE) {
    for (const [answer, ui, writes] of answers) {
      const label = `${sensitive.key} with ${answer}`;
      const steps = sensitive.bool === true ? [MENU.general, sensitive.key, "true", MENU.done] : [MENU.general, sensitive.key, ACTION.set, MENU.done];
      const s = session(t, { file: before, confirm: true, select: steps, input: sensitive.text === undefined ? [] : [sensitive.text], ui });
      await s.run();
      s.assertScriptsUsed();
      if (writes) {
        assert.deepEqual(s.json(), JSON.parse(JSON.stringify(setAt({ server: { port: 8080 } }, sensitive.key.split("."), sensitive.value))), label);
      } else {
        assert.equal(s.text(), before, label);
      }
    }
  }
});

test("configmenu a value that is not sensitive does not prompt: a loopback host and a port are written without a dialog", async (t) => {
  const s = session(t, { file: {}, select: [MENU.general, "server.host", ACTION.set, MENU.general, "server.port", ACTION.set, MENU.done], input: ["127.0.0.1", "8085"] });
  await s.run();
  assert.deepEqual(s.json(), { server: { host: "127.0.0.1", port: 8085 } });
  assert.equal(s.confirms.length, 0);
  s.assertScriptsUsed();
});

test("configmenu unreadable file: the notice names the file and says it was not changed, the file is untouched and the menu ends", async (t) => {
  const before = "{ this is not json";
  const s = session(t, { file: before, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["8081"] });
  await s.run();
  assert.equal(s.text(), before);
  const error = s.notes.find((note) => note.type === "error");
  assert.ok(error, JSON.stringify(s.notes));
  assert.ok(error.message.includes("config.json"), error.message);
  assert.match(error.message, /not changed/);
  assert.equal(s.select.remaining(), 1, "the menu ended instead of asking again");
});

test("configmenu unreadable file in the default-profile flow: the same notice and the menu ends", async (t) => {
  const before = "[1, 2]";
  const s = session(t, { file: before, select: [MENU.defaultProfile, MENU.done] });
  await s.run();
  assert.equal(s.text(), before);
  assert.ok(s.notes.some((note) => note.type === "error" && /not changed/.test(note.message)), JSON.stringify(s.notes));
  assert.equal(s.select.remaining(), 1);
});

test("configmenu first edit creates the file: with no data directory a first edit creates it and the notice says so", async (t) => {
  const s = session(t, { nested: true, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["8081"] });
  assert.equal(existsSync(s.path), false);
  await s.run();
  assert.deepEqual(s.json(), { server: { port: 8081 } });
  const saved = s.notes.find((note) => note.message.includes("server.port"));
  assert.ok(saved);
  assert.match(saved.message, /was created/);
  s.assertScriptsUsed();
});

test("configmenu an exhausted script ends the menu, and a UI that always gives the same answer cannot keep it running forever", async (t) => {
  const exhausted = session(t, { select: [MENU.view] });
  await exhausted.run();
  assert.equal(exhausted.notes.length, 1);

  const stuck = session(t, { ui: { select: async () => MENU.view } });
  await stuck.run();
  assert.ok(stuck.notes.length > 0 && stuck.notes.length < 10000, `${stuck.notes.length} notices`);
});

test("configmenu only the given path is written: the directory holds the config file and nothing else, and a project file is unchanged", async (t) => {
  const s = session(t, {
    file: { models: { qwen3_4b: {} } },
    select: [MENU.general, "server.port", ACTION.set, MENU.modelBlock, "model.sampling.temperature", ACTION.set, MENU.profiles, "qwen3_4b", NEW_PROFILE, PROFILE_ACTION.back, MENU.done],
    input: ["8081", "0.3", "fast"],
  });
  const project = join(s.dir, "proj", ".pi", "pi-mlx-models.json");
  mkdirSync(join(s.dir, "proj", ".pi"), { recursive: true });
  const projectText = pretty({ server: { port: 9999 } });
  writeFileSync(project, projectText);
  await s.run();
  assert.deepEqual(readdirSync(s.dir).sort(), ["config.json", "proj"]);
  assert.equal(readFileSync(project, "utf8"), projectText);
  assert.equal(s.confirms.length, 0);
  s.assertScriptsUsed();
  assert.deepEqual(s.json(), { models: { qwen3_4b: { profiles: { fast: {} } } }, server: { port: 8081 }, model: { sampling: { temperature: 0.3 } } });
});

test("configmenu an invalid combined result: a file that already holds an unknown key refuses an edit of another key and lists the problem", async (t) => {
  const before = pretty({ server: { port: 8080, bogusKey: 1 } });
  const s = session(t, { file: before, select: [MENU.general, "server.logLevel", ACTION.set, MENU.done], input: ["DEBUG"] });
  await s.run();
  assert.equal(s.text(), before);
  const error = s.notes.find((note) => note.type === "error");
  assert.ok(error, JSON.stringify(s.notes));
  assert.match(error.message, /bogusKey/);
  assert.match(error.message, /may already have been in the file/);
  s.assertScriptsUsed();
});

/** The select prompts that are the top menu: found by their options (they include Done), never by their title. */
const topMenus = (prompts: Array<{ kind: string; title: string; options?: string[] }>) =>
  prompts.filter((prompt) => prompt.kind === "select" && prompt.options?.includes(MENU.done) === true);

test("configmenu carries the last result: a saved notice is still notified and is also the top of the next top menu title, with no extra dialog", async (t) => {
  const s = session(t, { file: {}, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["8081"] });
  await s.run();
  const saved = s.notes.filter((note) => /^Saved server\.port\./.test(note.message));
  assert.equal(saved.length, 1, JSON.stringify(s.notes));
  const menus = topMenus(s.prompts);
  assert.equal(menus.length, 2);
  assert.equal(menus[0].title, MENU_TITLE);
  assert.ok(menus[1].title.includes(saved[0].message), menus[1].title);
  assert.ok(menus[1].title.endsWith(MENU_TITLE), menus[1].title);
  assert.ok(menus[1].title.indexOf(saved[0].message) < menus[1].title.lastIndexOf(MENU_TITLE));
  assert.ok(menus[1].title.includes(`${saved[0].message}\n\n${MENU_TITLE}`), "a blank line separates the notice from the menu title");
  assert.deepEqual(
    s.prompts.map((prompt) => prompt.kind),
    ["select", "select", "select", "input", "select"],
  );
  s.assertScriptsUsed();
});

test("configmenu IN-03: carries the last result for every kind of notice: each scenario emits one notice and a later select title holds it, and every notice site has a row", async (t) => {
  const qwenProfiles = { models: { qwen3_4b: { defaultProfile: "fast", profiles: { fast: {}, slow: {} } } } };
  const scenarios: Array<{ name: string; site: string; expect: RegExp; options: SessionOptions }> = [
    { name: "unchanged", site: "write", expect: /^Nothing changed/, options: { file: { server: { port: 8081 } }, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["8081"] } },
    { name: "rejected typed value", site: "editKey", expect: /^Not saved/, options: { file: {}, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["70000"] } },
    { name: "sensitive key not confirmed", site: "editKey", expect: /^Nothing was saved/, options: { file: {}, confirm: false, select: [MENU.general, "autoStart", "true", MENU.done] } },
    { name: "rejected model key", site: "chooseModel", expect: /^Not added/, options: { select: [MENU.modelEntry, NEW_ENTRY, MENU.done], input: ["-x"] } },
    { name: "declined Add anyway", site: "chooseModel", expect: /^Nothing was added/, options: { confirm: false, select: [MENU.profiles, NEW_ENTRY, MENU.done], input: ["careful"] } },
    { name: "rejected profile name", site: "profilesFlow", expect: /^Not added/, options: { file: { models: { qwen3_4b: {} } }, select: [MENU.profiles, "qwen3_4b", NEW_PROFILE, MENU.done], input: ["-x"] } },
    { name: "declined profile delete", site: "deleteProfile", expect: /^Nothing was deleted: profile/, options: { file: qwenProfiles, confirm: false, select: [MENU.profiles, "qwen3_4b", "fast", PROFILE_ACTION.delete, MENU.done] } },
    { name: "confirmed profile delete", site: "deleteProfile", expect: /^Deleted profile/, options: { file: qwenProfiles, confirm: true, select: [MENU.profiles, "qwen3_4b", "fast", PROFILE_ACTION.delete, MENU.done] } },
    { name: "default profile of a model without profiles", site: "defaultProfileFlow", expect: /has no profiles/, options: { file: { models: { plain: {} } }, select: [MENU.defaultProfile, "plain", MENU.done] } },
    { name: "default profile with no models", site: "defaultProfileFlow", expect: /lists no models/, options: { file: {}, select: [MENU.defaultProfile, MENU.done] } },
    { name: "declined entry delete", site: "deleteEntryFlow", expect: /^Nothing was deleted: model entry/, options: { file: { models: { careful: {} } }, confirm: false, select: [MENU.deleteEntry, "careful", MENU.done] } },
    { name: "entry delete with no models", site: "deleteEntryFlow", expect: /no model entries/, options: { file: {}, select: [MENU.deleteEntry, MENU.done] } },
    { name: "confirmed entry delete", site: "deleteEntryFlow", expect: /^Deleted model entry/, options: { file: { models: { careful: {} } }, confirm: true, select: [MENU.deleteEntry, "careful", MENU.done] } },
    { name: "default profile set", site: "defaultProfileFlow", expect: /the default profile/, options: { file: qwenProfiles, select: [MENU.defaultProfile, "qwen3_4b", "slow", MENU.done] } },
    { name: "saved edit", site: "write", expect: /^Saved server\.port\./, options: { file: {}, select: [MENU.general, "server.port", ACTION.set, MENU.done], input: ["8081"] } },
    { name: "refused edit", site: "write", expect: /^Not saved/, options: { file: { server: { port: 8080, bogusKey: 1 } }, select: [MENU.general, "server.logLevel", ACTION.set, MENU.done], input: ["DEBUG"] } },
    { name: "default profile removed", site: "defaultProfileFlow", expect: /was removed/, options: { file: qwenProfiles, select: [MENU.defaultProfile, "qwen3_4b", NO_DEFAULT, MENU.done] } },
  ];
  const failing: string[] = [];
  for (const scenario of scenarios) {
    const s = session(t, scenario.options);
    await s.run();
    s.assertScriptsUsed();
    assert.equal(s.notes.length, 1, `${scenario.name}: ${JSON.stringify(s.notes)}`);
    const [note] = s.notes;
    assert.match(note.message, scenario.expect, scenario.name);
    const titles = s.prompts.filter((prompt) => prompt.kind === "select").map((prompt) => prompt.title);
    const carried = titles.find((title) => title.includes(note.message));
    if (carried === undefined) {
      failing.push(scenario.name);
    } else {
      assert.ok(carried.startsWith("Last result: "), `${scenario.name}: ${carried}`);
    }
  }
  assert.deepEqual(failing, [], "scenarios whose notice is not carried into a later select title");
  const sites = new Set(scenarios.map((scenario) => scenario.site));
  for (const site of ["write", "editKey", "chooseModel", "profilesFlow", "deleteProfile", "defaultProfileFlow", "deleteEntryFlow"]) {
    assert.ok(sites.has(site), `no scenario for the notice site ${site}`);
  }
});

test("configmenu carries a result into the profile action menu: a created profile and an existing one show their notice above the heading, and the top menu after it is plain", async (t) => {
  const created = session(t, { file: { models: { qwen3_4b: {} } }, select: [MENU.profiles, "qwen3_4b", NEW_PROFILE, PROFILE_ACTION.back, MENU.done], input: ["fast"] });
  await created.run();
  const submenu = created.prompts.find((prompt) => prompt.kind === "select" && prompt.options?.includes(PROFILE_ACTION.edit) === true);
  assert.ok(submenu, JSON.stringify(created.prompts));
  assert.ok(submenu.title.includes("Created profile"), submenu.title);
  assert.ok(submenu.title.endsWith("Profile fast of model qwen3_4b"), submenu.title);
  const createdTops = topMenus(created.prompts);
  assert.equal(createdTops.length, 2);
  assert.deepEqual(
    createdTops.map((menu) => menu.title),
    [MENU_TITLE, MENU_TITLE],
  );
  created.assertScriptsUsed();

  const existing = session(t, {
    file: { models: { qwen3_4b: { profiles: { fast: {} } } } },
    select: [MENU.profiles, "qwen3_4b", NEW_PROFILE, PROFILE_ACTION.back, MENU.done],
    input: ["fast"],
  });
  await existing.run();
  const again = existing.prompts.find((prompt) => prompt.kind === "select" && prompt.options?.includes(PROFILE_ACTION.edit) === true);
  assert.ok(again, JSON.stringify(existing.prompts));
  assert.ok(again.title.includes("already exists"), again.title);
  assert.ok(again.title.endsWith("Profile fast of model qwen3_4b"), again.title);
  existing.assertScriptsUsed();
});

test("configmenu WR-03: a result is not lost when the profile action menu is dismissed or fails: the next top menu shows it once", async (t) => {
  const file = { models: { qwen3_4b: {} } };
  const created = (messages: Array<{ message: string }>) => messages.filter((note) => note.message.startsWith("Created profile"));

  // Dismissed: the action menu is shown and answered with nothing.
  const dismissed = session(t, { file, select: [MENU.profiles, "qwen3_4b", NEW_PROFILE, undefined, MENU.view, MENU.done], input: ["fast"] });
  await dismissed.run();
  const shownAction = dismissed.prompts.find((prompt) => prompt.kind === "select" && prompt.options?.includes(PROFILE_ACTION.edit) === true);
  assert.ok(shownAction, JSON.stringify(dismissed.prompts));
  assert.ok(shownAction.title.includes("Created profile"), shownAction.title);
  const dismissedTops = topMenus(dismissed.prompts);
  assert.equal(dismissedTops.length, 3, JSON.stringify(dismissedTops.map((menu) => menu.title)));
  assert.equal(dismissedTops[0].title, MENU_TITLE);
  assert.ok(dismissedTops[1].title.startsWith("Last result: Created profile"), dismissedTops[1].title);
  assert.ok(dismissedTops[1].title.endsWith(MENU_TITLE), dismissedTops[1].title);
  assert.equal(dismissedTops[2].title, MENU_TITLE);
  assert.equal(created(dismissed.notes).length, 1, JSON.stringify(dismissed.notes));
  assert.equal(dismissed.notes.length, 2, "the created notice and the view text, as before");
  dismissed.assertScriptsUsed();

  // Fails: the dialog of the action menu throws, which dialogs.select turns into undefined.
  let failing: ReturnType<typeof session> | undefined;
  failing = session(t, {
    file,
    select: [MENU.profiles, "qwen3_4b", NEW_PROFILE, MENU.view, MENU.done],
    input: ["fast"],
    ui: {
      select: async (title, options) => {
        if (options.includes(PROFILE_ACTION.edit)) throw new Error("dialog failed");
        return failing?.ctx.ui.select(title, options);
      },
    },
  });
  await failing.run();
  const failedTops = topMenus(failing.prompts);
  assert.equal(failedTops.length, 3, JSON.stringify(failedTops.map((menu) => menu.title)));
  assert.equal(failedTops[0].title, MENU_TITLE);
  assert.ok(failedTops[1].title.startsWith("Last result: Created profile"), failedTops[1].title);
  assert.ok(failedTops[1].title.endsWith(MENU_TITLE), failedTops[1].title);
  assert.equal(failedTops[2].title, MENU_TITLE);
  assert.equal(created(failing.notes).length, 1, JSON.stringify(failing.notes));
  failing.assertScriptsUsed();
});

test("configmenu shows the result once and does not carry View: the menu after a View has the plain title, and a dismissed edit leaves nothing to carry", async (t) => {
  const viewed = session(t, { file: {}, select: [MENU.general, "server.port", ACTION.set, MENU.view, MENU.done], input: ["8081"] });
  await viewed.run();
  const tops = topMenus(viewed.prompts);
  assert.equal(tops.length, 3);
  assert.ok(tops[1].title.startsWith("Last result: Saved server.port."), tops[1].title);
  assert.equal(tops[2].title, MENU_TITLE);
  const view = viewed.notes.find((note) => !note.message.startsWith("Saved"));
  assert.ok(view, JSON.stringify(viewed.notes));
  assert.equal(viewed.notes.length, 2);
  assert.equal(view.type, "info");
  for (const prompt of viewed.prompts) assert.equal(prompt.title.includes(view.message), false, prompt.title);
  viewed.assertScriptsUsed();

  const dismissed = session(t, { file: {}, select: [MENU.general, "server.port", ACTION.set, MENU.general, "server.port", ACTION.set, MENU.done], input: ["8081", undefined] });
  await dismissed.run();
  const after = topMenus(dismissed.prompts);
  assert.equal(after.length, 3);
  assert.ok(after[1].title.startsWith("Last result: "), after[1].title);
  assert.equal(after[2].title, MENU_TITLE);
  dismissed.assertScriptsUsed();
});

test("configmenu bounds the carried text: a long refusal is notified in full and carried as at most a few lines ending in three dots", async (t) => {
  const unknown = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`bogusKey${String(index).padStart(2, "0")}`, index]));
  const s = session(t, { file: { server: { port: 8080, ...unknown } }, select: [MENU.general, "server.logLevel", ACTION.set, MENU.done], input: ["DEBUG"] });
  await s.run();
  const error = s.notes.find((note) => note.type === "error");
  assert.ok(error, JSON.stringify(s.notes));
  assert.ok(error.message.split("\n").length > CARRY_MAX_LINES || error.message.length > CARRY_MAX_CHARS, `the premise: ${error.message.length} characters`);
  assert.ok(error.message.includes("...and 10 more problems"), "the notice itself is not shortened");
  const tops = topMenus(s.prompts);
  assert.equal(tops.length, 2);
  const title = tops[1].title;
  assert.ok(title.split("\n").length <= CARRY_MAX_LINES + 2, `${title.split("\n").length} lines`);
  assert.ok(title.endsWith(`...\n\n${MENU_TITLE}`), title);
  assert.ok(title.length < CARRY_MAX_CHARS + 120, String(title.length));
  assert.equal(title.includes("more problems"), false, "the end of the long notice is cut from the title");
  s.assertScriptsUsed();
});

/** Two model keys that show the same text once cleaned and clipped: a shared 100-character prefix, and a control character. */
const LOOK_ALIKE_PATHS = [`/Users/x/models/${"a".repeat(100)}-one`, `/Users/x/models/${"a".repeat(100)}-two`];
const LOOK_ALIKE_CONTROL = ["ab\u0007c", "ab c"];
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

test("configmenu WR-02: the delete-entry confirm and notices give the entry's place in the list, so look-alike keys are told apart", async (t) => {
  for (const keys of [LOOK_ALIKE_PATHS, LOOK_ALIKE_CONTROL]) {
    const file = { models: Object.fromEntries(keys.map((key) => [key, {}])) };
    const titles: string[] = [];
    const notices: string[] = [];
    for (const index of [0, 1]) {
      const s = session(t, { file, confirm: true, select: [MENU.deleteEntry, index, MENU.done] });
      await s.run();
      assert.equal(s.confirms.length, 1, JSON.stringify(s.prompts));
      const { title, message } = s.confirms[0];
      assert.ok(title.includes(`${index + 1} of 2`), title);
      const deleted = s.notes.filter((note) => note.message.startsWith("Deleted model entry"));
      assert.equal(deleted.length, 1, JSON.stringify(s.notes));
      assert.ok(deleted[0].message.includes(`${index + 1} of 2`), deleted[0].message);
      assert.deepEqual(Object.keys((s.json() as { models: object }).models), [keys[1 - index]]);
      for (const text of [title, message, deleted[0].message]) assert.equal(CONTROL_CHARACTER.test(text), false, text);
      titles.push(title);
      notices.push(deleted[0].message);
      s.assertScriptsUsed();
    }
    assert.notEqual(titles[0], titles[1]);
    assert.notEqual(notices[0], notices[1]);
  }

  const declined = session(t, { file: { models: { careful: {} } }, confirm: false, select: [MENU.deleteEntry, "careful", MENU.done] });
  await declined.run();
  assert.equal(declined.notes.length, 1, JSON.stringify(declined.notes));
  assert.ok(declined.notes[0].message.startsWith("Nothing was deleted: model entry 1 of 1"), declined.notes[0].message);
  declined.assertScriptsUsed();
});

test("configmenu WR-02b: the delete-profile confirm and notices give the model entry's place, so the same profile name under look-alike model keys is told apart", async (t) => {
  for (const keys of [LOOK_ALIKE_PATHS, LOOK_ALIKE_CONTROL]) {
    const file = { models: Object.fromEntries(keys.map((key) => [key, { profiles: { fast: {}, slow: {} } }])) };
    const titles: string[] = [];
    const notices: string[] = [];
    for (const index of [0, 1]) {
      const s = session(t, { file, confirm: true, select: [MENU.profiles, index, "fast", PROFILE_ACTION.delete, MENU.done] });
      await s.run();
      assert.equal(s.confirms.length, 1, JSON.stringify(s.prompts));
      const { title, message } = s.confirms[0];
      assert.ok(title.includes(`${index + 1} of 2`), title);
      const deleted = s.notes.filter((note) => note.message.startsWith("Deleted profile"));
      assert.equal(deleted.length, 1, JSON.stringify(s.notes));
      assert.ok(deleted[0].message.includes(`${index + 1} of 2`), deleted[0].message);
      const models = (s.json() as { models: Record<string, { profiles: object }> }).models;
      assert.deepEqual(Object.keys(models[keys[index]].profiles), ["slow"]);
      assert.deepEqual(Object.keys(models[keys[1 - index]].profiles), ["fast", "slow"]);
      for (const text of [title, message, deleted[0].message]) assert.equal(CONTROL_CHARACTER.test(text), false, text);
      titles.push(title);
      notices.push(deleted[0].message);
      s.assertScriptsUsed();
    }
    assert.notEqual(titles[0], titles[1]);
    assert.notEqual(notices[0], notices[1]);
  }

  const declined = session(t, { file: { models: { qwen3_4b: { profiles: { fast: {} } } } }, confirm: false, select: [MENU.profiles, "qwen3_4b", "fast", PROFILE_ACTION.delete, MENU.done] });
  await declined.run();
  assert.equal(declined.notes.length, 1, JSON.stringify(declined.notes));
  assert.ok(declined.notes[0].message.startsWith("Nothing was deleted: profile fast of model entry 1 of 1"), declined.notes[0].message);
  declined.assertScriptsUsed();

  const withDefault = session(t, { file: { models: { qwen3_4b: { defaultProfile: "fast", profiles: { fast: {}, slow: {} } } } }, confirm: true, select: [MENU.profiles, "qwen3_4b", "fast", PROFILE_ACTION.delete, MENU.done] });
  await withDefault.run();
  const cleared = withDefault.notes.find((note) => note.message.startsWith("Deleted profile"));
  assert.ok(cleared, JSON.stringify(withDefault.notes));
  assert.ok(cleared.message.startsWith("Deleted profile fast of model entry 1 of 1"), cleared.message);
  assert.match(cleared.message, /defaultProfile was cleared too/);
  withDefault.assertScriptsUsed();
});

test("configmenu WR-02c: a notice that names a model adds the entry's place only when another key looks the same", async (t) => {
  const cases: Array<[string[], number]> = [
    [LOOK_ALIKE_PATHS, 1],
    [LOOK_ALIKE_CONTROL, 0],
  ];
  for (const [keys, index] of cases) {
    const file = { models: Object.fromEntries(keys.map((key) => [key, {}])) };
    const s = session(t, { file, select: [MENU.modelEntry, index, "numDraftTokens", ACTION.set, MENU.done], input: ["2"] });
    await s.run();
    const saved = s.notes.filter((note) => note.message.startsWith("Saved numDraftTokens of model "));
    assert.equal(saved.length, 1, JSON.stringify(s.notes));
    assert.ok(saved[0].message.includes(`(entry ${index + 1} of 2)`), saved[0].message);
    assert.equal(CONTROL_CHARACTER.test(saved[0].message), false, saved[0].message);
    assert.deepEqual(Object.keys((s.json() as { models: Record<string, object> }).models), keys);
    assert.deepEqual((s.json() as { models: Record<string, object> }).models[keys[index]], { numDraftTokens: 2 });
    s.assertScriptsUsed();
  }

  const unique = session(t, { file: { models: { qwen3_4b: {}, other: {} } }, select: [MENU.modelEntry, "qwen3_4b", "numDraftTokens", ACTION.set, MENU.done], input: ["2"] });
  await unique.run();
  assert.equal(unique.notes.length, 1, JSON.stringify(unique.notes));
  assert.equal(unique.notes[0].message, "Saved numDraftTokens of model qwen3_4b. The change takes effect on the next /mlx-start.");
  assert.equal(unique.notes[0].message.includes("(entry"), false);
  unique.assertScriptsUsed();
});

test("configmenu IN-04: deleting an entry whose value is not an object says so and removes it as it is", async (t) => {
  const s = session(t, { file: '{"models": {"five": 5, "ok": {}}}', confirm: true, select: [MENU.deleteEntry, "five", MENU.done] });
  await s.run();
  assert.equal(s.confirms.length, 1, JSON.stringify(s.prompts));
  assert.match(s.confirms[0].message, /not an object/);
  assert.match(s.confirms[0].message, /removed as it is/);
  assert.doesNotMatch(s.confirms[0].message, /holds nothing/);
  assert.deepEqual(s.json(), { models: { ok: {} } });
  s.assertScriptsUsed();
});

test("configmenu IN-01: the carried copy masks only the credential span of a URL and keeps the status word", () => {
  const masked = carriedCopy("Not saved: mlxLm.pipIndex https://alice:hunter2@pypi.example.org/simple is refused");
  assert.equal(masked, "Not saved: mlxLm.pipIndex https://***@pypi.example.org/simple is refused");
  assert.equal(masked.includes("alice") || masked.includes("hunter2"), false);

  assert.equal(carriedCopy("Saved defaultModel from https://bob:pa/ss@host/x done"), "Saved defaultModel from https://***@host/x done");

  assert.equal(
    carriedCopy("Not saved: first line\nthe index https://u:p@host/simple is refused\nthird line stays"),
    "Not saved: first line\nthe index https://***@host/simple is refused\nthird line stays",
  );

  const six = ["one", "two", "three", "four", "see https://carol:s3cret@host/x here", "six"].join("\n");
  assert.equal(carriedCopy(six), "one\ntwo\nthree\nfour\nsee https://***@host/x here\nsix");

  assert.equal(carriedCopy("http://tok@host"), "http://***@host");
});

test("configmenu IN-01: text with an at sign that is not a URL credential is carried untouched (@scope/pkg, model@rev, an email-like string)", () => {
  for (const text of [
    "Not saved: package @scope/pkg is not valid",
    "Pinned org/name@rev for this start",
    "Mail a@b.com or c@d.org about it",
    "Nothing was added: the model key ***@host was not confirmed.",
    "see https://host/x for @scope/pkg",
    "Saved server.port. The change takes effect on the next /mlx-start.",
  ]) {
    assert.equal(carriedCopy(text), text);
  }

  const seven = Array.from({ length: 7 }, (_, index) => `plain line ${index + 1}`).join("\n");
  const cutLines = carriedCopy(seven);
  assert.equal(cutLines.split("\n").length, CARRY_MAX_LINES);
  assert.ok(cutLines.endsWith("..."), cutLines);
  assert.equal(cutLines.includes("plain line 7"), false);

  const cutChars = carriedCopy("x".repeat(CARRY_MAX_CHARS + 50));
  assert.equal(cutChars.length, CARRY_MAX_CHARS + 3);
  assert.ok(cutChars.endsWith("..."));
});

test("configmenu 06 review IN-04: the notice of a new profile says it is already saved and stays if the user chooses Back", async (t) => {
  const created = session(t, { file: { models: { qwen3_4b: {} } }, select: [MENU.profiles, "qwen3_4b", NEW_PROFILE, PROFILE_ACTION.back, MENU.done], input: ["fast"] });
  await created.run();
  assert.equal(created.notes.length, 1, JSON.stringify(created.notes));
  assert.match(created.notes[0].message, /^Created profile fast of model qwen3_4b\. The change takes effect on the next \/mlx-start\./);
  assert.ok(created.notes[0].message.endsWith(" The profile is already saved and stays in the file if you choose Back."), created.notes[0].message);
  created.assertScriptsUsed();
});

test("configmenu IN-01: ctx.ui.notify receives the notice exactly as built, and the next title shows it with the status word kept and only the credential span masked", async (t) => {
  const created = session(t, {
    select: [MENU.profiles, NEW_ENTRY, NEW_PROFILE, PROFILE_ACTION.back, MENU.done],
    input: ["https://u:p@host/x", "fast"],
  });
  await created.run();
  assert.equal(created.notes.length, 1, JSON.stringify(created.notes));
  assert.ok(created.notes[0].message.startsWith("Created profile fast of model https://***@host/x. The change takes effect on the next /mlx-start."), created.notes[0].message);
  const submenu = created.prompts.find((prompt) => prompt.kind === "select" && prompt.options?.includes(PROFILE_ACTION.edit) === true);
  assert.ok(submenu, JSON.stringify(created.prompts));
  assert.ok(submenu.title.includes(created.notes[0].message), submenu.title);
  assert.ok(submenu.title.startsWith("Last result: Created profile"), submenu.title);
  assert.equal(submenu.title.includes("u:p"), false, submenu.title);
  created.assertScriptsUsed();

  const declined = session(t, { confirm: false, select: [MENU.profiles, NEW_ENTRY, MENU.done], input: ["user:secret@host"] });
  await declined.run();
  assert.equal(declined.notes.length, 1, JSON.stringify(declined.notes));
  assert.equal(declined.notes[0].message, "Nothing was added: the model key ***@host was not confirmed.");
  const tops = topMenus(declined.prompts);
  assert.equal(tops.length, 2);
  assert.ok(tops[1].title.includes(declined.notes[0].message), tops[1].title);
  assert.equal(tops[1].title.includes("secret"), false, tops[1].title);
  declined.assertScriptsUsed();
});

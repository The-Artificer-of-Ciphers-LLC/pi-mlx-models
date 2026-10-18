import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConfigScope,
  type ConfigTree,
  confirmationFor,
  convertInput,
  editConfig,
  editableKeys,
  getAt,
  modelKeys,
  profileNames,
  segmentsFor,
  setAt,
  unsetAt,
  validateModelKey,
  validateProfileName,
} from "./configedit.js";
import { PROFILE_NAME_SHORT_RULE, SETTINGS, type SettingDef, prepareSettings, readLayerFile } from "./settings.js";

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

/** The table row for a dotted path; a missing row fails the test loudly. */
function rowOf(path: string): SettingDef {
  const row = SETTINGS.find((candidate) => candidate.path === path);
  assert.ok(row, `no SETTINGS row ${path}`);
  return row;
}

/** Spelled out here, not imported, so changing the sentence is a deliberate edit of both places. */
const SAFE_CHOICE_NOTE = "Yes allows this. No or Esc cancels. Check which option is highlighted before pressing Enter.";

const SCOPES: readonly ConfigScope[] = ["global", "modelBlock", "modelEntry", "profile"];
const LIMITS = "model.limits.";

const pathsOf = (scope: ConfigScope): string[] => editableKeys(scope).map((key) => key.path);

test("editableKeys global: exactly the rows that are not per-model, taken from the table", () => {
  assert.deepEqual(
    pathsOf("global"),
    SETTINGS.filter((row) => row.perModel !== true).map((row) => row.path),
  );
  for (const wanted of ["server.port", "server.host", "baseUrl", "defaultModel", "mlxLm.pipIndex", "provider.listAllModels", "autoStart"]) {
    assert.ok(pathsOf("global").includes(wanted), wanted);
  }
  assert.equal(pathsOf("global").some((path) => path.startsWith("model.")), false);
});

test("editableKeys model scopes: the per-model rows except the limits rows; a profile adds the limits rows", () => {
  const perModel = SETTINGS.filter((row) => row.perModel === true);
  const withoutLimits = perModel.filter((row) => !row.path.startsWith(LIMITS)).map((row) => row.path);
  assert.deepEqual(pathsOf("modelBlock"), withoutLimits);
  assert.deepEqual(pathsOf("modelEntry"), withoutLimits);
  assert.deepEqual(
    pathsOf("profile"),
    perModel.map((row) => row.path),
  );
  assert.deepEqual(
    pathsOf("profile").filter((path) => path.startsWith(LIMITS)),
    ["model.limits.contextWindow", "model.limits.maxTokens", "model.limits.reasoning", "model.limits.input"],
  );
  assert.equal(pathsOf("modelBlock").includes("model.limits.contextWindow"), false);
  assert.equal(pathsOf("modelEntry").includes("model.limits.contextWindow"), false);
  assert.equal(pathsOf("profile").includes("model.limits.contextWindow"), true);
  assert.equal(pathsOf("profile").includes("server.port"), false);
});

test("editableKeys covers the table: every row is in some scope and no scope lists a row twice", () => {
  const offered = new Set(SCOPES.flatMap(pathsOf));
  for (const row of SETTINGS) assert.ok(offered.has(row.path), `${row.path} is not editable anywhere`);
  for (const scope of SCOPES) {
    const paths = pathsOf(scope);
    assert.equal(new Set(paths).size, paths.length, scope);
  }
});

test("editableKeys labels: the row path where the file has it, the name inside the entry or profile otherwise", () => {
  const label = (scope: ConfigScope, path: string) => editableKeys(scope).find((key) => key.path === path)?.label;
  assert.equal(label("global", "server.port"), "server.port");
  assert.equal(label("modelBlock", "model.sampling.temperature"), "model.sampling.temperature");
  assert.equal(label("modelEntry", "model.sampling.temperature"), "sampling.temperature");
  assert.equal(label("profile", "model.limits.contextWindow"), "limits.contextWindow");
});

/** A text each kind of row accepts somewhere in the table; the first one a row takes is its sample. */
const SAMPLES = ["5", "0.5", "true", "INFO", "latest", "localhost", "http://localhost:8080/v1", "https://pypi.org/simple", '{"a":1}', "text,image", "a,b", "###", "/tmp/example.json", "org/model"];

test("editableKeys offers only keys the file reader accepts: a sample value for every key of every scope passes the whole-file validation", (t) => {
  const dir = tempDir(t);
  for (const scope of SCOPES) {
    for (const key of editableKeys(scope)) {
      const value = SAMPLES.map((text) => convertInput(key.row, text)).find((result) => result.ok);
      assert.ok(value?.ok, `no sample text for ${key.path}; add one to SAMPLES`);
      const path = join(dir, `${scope}-${key.path}.json`);
      const segments = segmentsFor(scope, key.row, { model: "org/model", profile: "fast" });
      const outcome = editConfig(path, (draft) => setAt(draft, segments, value.value));
      assert.deepEqual(outcome, { ok: true, created: true, changed: true }, `${scope} ${key.path}: ${JSON.stringify(outcome)}`);
    }
  }
});

test("segmentsFor: where each scope writes a row", () => {
  const target = { model: "org/model", profile: "fast" };
  const temperature = rowOf("model.sampling.temperature");
  assert.deepEqual(segmentsFor("modelBlock", temperature), ["model", "sampling", "temperature"]);
  assert.deepEqual(segmentsFor("modelEntry", temperature, target), ["models", "org/model", "sampling", "temperature"]);
  assert.deepEqual(segmentsFor("profile", temperature, target), ["models", "org/model", "profiles", "fast", "sampling", "temperature"]);
  assert.deepEqual(segmentsFor("profile", rowOf("model.limits.contextWindow"), target), ["models", "org/model", "profiles", "fast", "limits", "contextWindow"]);
  assert.deepEqual(segmentsFor("global", rowOf("server.port")), ["server", "port"]);
  assert.deepEqual(segmentsFor("global", rowOf("autoStart")), ["autoStart"]);
  assert.deepEqual(segmentsFor("modelEntry", rowOf("model.adapterPath"), target), ["models", "org/model", "adapterPath"]);
  assert.deepEqual(segmentsFor("modelBlock", rowOf("model.adapterPath")), ["model", "adapterPath"]);
});

/** The converted value of a text the row accepts. */
function converted(path: string, text: string): unknown {
  const result = convertInput(rowOf(path), text);
  assert.ok(result.ok, `${path} ${JSON.stringify(text)}: ${result.ok ? "" : result.message}`);
  return result.value;
}

const rejected = (path: string, text: string): string => {
  const result = convertInput(rowOf(path), text);
  assert.equal(result.ok, false, `${path} ${JSON.stringify(text)} should be refused`);
  return result.ok ? "" : result.message;
};

test("convertInput integer and number: plain digits and plain numbers only", () => {
  assert.equal(converted("server.port", "8081"), 8081);
  assert.equal(converted("server.port", " 12 "), 12);
  assert.equal(converted("model.sampling.seed", "-7"), -7);
  rejected("server.port", "8081.5");
  rejected("server.port", "abc");
  rejected("server.port", "");
  assert.equal(converted("model.sampling.temperature", "0.7"), 0.7);
  assert.equal(converted("model.sampling.temperature", ".5"), 0.5);
  rejected("model.sampling.temperature", "NaN");
  rejected("model.sampling.temperature", "0x10");
  rejected("model.sampling.temperature", "");
});

test("convertInput bool, string, path and enum: exact booleans, trimmed non-empty text", () => {
  assert.equal(converted("server.trustRemoteCode", "true"), true);
  assert.equal(converted("server.trustRemoteCode", " false "), false);
  rejected("server.trustRemoteCode", "yes");
  rejected("server.trustRemoteCode", "True");
  assert.equal(converted("defaultModel", "  org/model  "), "org/model");
  assert.equal(converted("model.adapterPath", " /tmp/adapter "), "/tmp/adapter");
  assert.equal(converted("server.logLevel", "DEBUG"), "DEBUG");
  rejected("defaultModel", "   ");
  rejected("server.logLevel", "loud");
});

test("convertInput list: comma entries or a JSON array, and a single string for stop sequences", () => {
  assert.deepEqual(converted("server.allowedOrigins", "http://a,http://b"), ["http://a", "http://b"]);
  assert.deepEqual(converted("server.allowedOrigins", " http://a , http://b "), ["http://a", "http://b"]);
  assert.deepEqual(converted("server.allowedOrigins", '["http://a"]'), ["http://a"]);
  rejected("server.allowedOrigins", "http://a,,http://b");
  rejected("server.allowedOrigins", "http://a,");
  rejected("server.allowedOrigins", "[not json");
  assert.equal(converted("model.sampling.stop", "###"), "###");
  assert.deepEqual(converted("model.sampling.stop", '["a","b"]'), ["a", "b"]);
  assert.deepEqual(converted("model.limits.input", "text,image"), ["text", "image"]);
  rejected("model.limits.input", "image");
});

test("convertInput jsonObject: a JSON object converts, anything else is refused", () => {
  assert.deepEqual(converted("model.chatTemplateArgs", '{"enable_thinking":false}'), { enable_thinking: false });
  rejected("model.chatTemplateArgs", "[1]");
  rejected("model.chatTemplateArgs", "{broken");
  rejected("model.chatTemplateArgs", "5");
  rejected("model.chatTemplateArgs", '{"__proto__":{"x":1}}');
});

test("convertInput failure: the message is built from the row path and its expected text, and echoes nothing typed", () => {
  const port = rowOf("server.port");
  const message = rejected("server.port", "70000");
  assert.equal(message, `server.port must be ${port.expected}`);
  assert.equal(rejected("model.sampling.topP", "2"), `model.sampling.topP must be ${rowOf("model.sampling.topP").expected}`);
  const typed = rejected("server.port", "\u001b[31msecret-token");
  assert.equal(typed.includes("secret-token"), false);
  assert.equal(typed.includes("\u001b"), false);
});

test("confirmationFor: the settings that run code, open the network, choose an install source or start a model are marked", () => {
  const marked: Array<[string, unknown]> = [
    ["server.trustRemoteCode", true],
    ["server.host", "0.0.0.0"],
    ["server.host", "192.168.1.5"],
    ["server.allowedOrigins", ["http://example.com"]],
    ["baseUrl", "http://10.0.0.5:8080/v1"],
    ["baseUrl", "not a url"],
    ["mlxLm.pipIndex", "https://pypi.example.org/simple"],
    ["autoStart", true],
  ];
  for (const [path, value] of marked) {
    const confirmation = confirmationFor(rowOf(path), value);
    assert.ok(confirmation, `${path} ${JSON.stringify(value)}`);
    assert.ok(confirmation.title.length > 0);
    assert.ok(confirmation.message.endsWith(SAFE_CHOICE_NOTE), confirmation.message);
    assert.ok(confirmation.message.includes("No or Esc cancels"));
  }
  const unmarked: Array<[string, unknown]> = [
    ["server.trustRemoteCode", false],
    ["server.host", "127.0.0.1"],
    ["server.host", "localhost"],
    ["server.host", "[::1]"],
    ["baseUrl", "http://127.0.0.1:8080/v1"],
    ["baseUrl", "http://[::1]:8080/v1"],
    ["autoStart", false],
    ["server.port", 8081],
    ["defaultModel", "org/model"],
  ];
  for (const [path, value] of unmarked) assert.equal(confirmationFor(rowOf(path), value), undefined, `${path} ${JSON.stringify(value)}`);
  assert.equal(confirmationFor(rowOf("server.allowedOrigins"), undefined), undefined);
});

test("confirmationFor hides the credentials of a pip index and cleans and clips what it shows", () => {
  const credentials = confirmationFor(rowOf("mlxLm.pipIndex"), "https://alice:hunter2@pypi.example.org/simple");
  assert.ok(credentials);
  assert.equal(credentials.message.includes("hunter2"), false);
  assert.equal(credentials.message.includes("alice"), false);
  assert.ok(credentials.message.includes("***"));
  const hostile = confirmationFor(rowOf("server.host"), `10.0.0.5\u001b[2J${"x".repeat(1000)}`);
  assert.ok(hostile);
  assert.equal(hostile.message.includes("\u001b"), false);
  assert.ok(hostile.message.length < 700, String(hostile.message.length));
});

test("modelKeys and profileNames: sorted own keys, empty for a missing or non-object value", () => {
  const tree: ConfigTree = { models: { "b/model": { profiles: { zeta: {}, alpha: {} } }, "a/model": {}, "c/model": { profiles: 5 } } };
  assert.deepEqual(modelKeys(tree), ["a/model", "b/model", "c/model"]);
  assert.deepEqual(profileNames(tree, "b/model"), ["alpha", "zeta"]);
  assert.deepEqual(profileNames(tree, "a/model"), []);
  assert.deepEqual(profileNames(tree, "c/model"), []);
  assert.deepEqual(profileNames(tree, "missing"), []);
  assert.deepEqual(profileNames(tree, "toString"), []);
  assert.deepEqual(modelKeys({}), []);
  assert.deepEqual(modelKeys({ models: [1, 2] }), []);
  assert.deepEqual(modelKeys({ models: "x" }), []);
});

test("validateModelKey: one line, not empty, at most 4096 characters, no control characters, no leading dash", () => {
  assert.deepEqual(validateModelKey("  org/model  "), { ok: true, value: "org/model" });
  assert.deepEqual(validateModelKey("__proto__"), { ok: true, value: "__proto__" });
  for (const bad of ["", "   ", "a".repeat(4097), "a\nb", "a\u001bb", "a\u0085b", "-flag", "  --flag"]) {
    const result = validateModelKey(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  assert.equal(validateModelKey("a".repeat(4096)).ok, true);
});

test("validateProfileName follows the profile rule and quotes it when it refuses", () => {
  assert.deepEqual(validateProfileName(" fast-1.b_c "), { ok: true, value: "fast-1.b_c" });
  for (const bad of ["", "-x", "a b", "a/b", "x".repeat(65), "a\nb"]) {
    const result = validateProfileName(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    if (!result.ok) assert.ok(result.message.includes(PROFILE_NAME_SHORT_RULE), result.message);
  }
  assert.equal(validateProfileName("x".repeat(64)).ok, true);
});

for (const hostile of ["__proto__", "constructor", "toString"]) {
  test(`prototype safety: a model key ${hostile} is a plain key that is written, read back and pollutes nothing`, (t) => {
    const before = Object.keys(Object.prototype);
    const dir = tempDir(t);
    const path = join(dir, "config.json");
    const sampling = ["models", hostile, "profiles", "fast", "sampling", "temperature"];
    const draftText = JSON.stringify(setAt({}, sampling, 0.5));
    assert.ok(draftText.includes(`"${hostile}"`), draftText);
    const outcome = editConfig(path, (draft) => setAt(setAt(draft, sampling, 0.5), ["models", hostile, "defaultProfile"], "fast"));
    assert.deepEqual(outcome, { ok: true, created: true, changed: true });
    assert.ok(readFileSync(path, "utf8").includes(`"${hostile}"`));
    const result = resolved(path);
    assert.equal(result.ok, true);
    if (result.ok) {
      const entry = result.prepared.modelSettings.layers[0].models.get(hostile);
      assert.ok(entry, "the model entry is present");
      assert.equal(entry.defaultProfile, "fast");
      assert.equal(entry.profiles.get("fast")?.get("model.sampling.temperature"), 0.5);
    }
    assert.deepEqual(modelKeys(readLayerFileData(path)), [hostile]);
    assert.deepEqual(profileNames(readLayerFileData(path), hostile), ["fast"]);
    assert.equal(({} as Record<string, unknown>).temperature, undefined);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(setAt({}, sampling, 1).models), null);
    assert.deepEqual(Object.keys(Object.prototype), before);
  });
}

/** The data of a file that is known to be readable. */
function readLayerFileData(path: string): ConfigTree {
  const file = readLayerFile(path);
  assert.equal(file.state, "ok");
  return file.state === "ok" ? file.data : {};
}

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_ID } from "./config.js";
import {
  PI_FLAGS,
  SETTINGS,
  buildLaunch,
  cliFlagSpecs,
  describeFlags,
  formatConfigErrors,
  formatProjectRefusal,
  prepareSettings,
  readLayerFile,
  toLaunchSpec,
  trustRisks,
  type LayerFile,
  type PrepareInput,
  type Prepared,
  type SettingDef,
} from "./settings.js";

const ok = (data: Record<string, unknown>): LayerFile => ({ state: "ok", data });
const absent: LayerFile = { state: "absent" };

/** Run the resolver on synthetic layers: no filesystem, no process environment. */
function resolve(input: Partial<PrepareInput> = {}) {
  return prepareSettings({ global: absent, env: {}, ...input });
}

/** Resolve and require success. */
function resolved(input: Partial<PrepareInput> = {}): { prepared: Prepared; warnings: string[] } {
  const result = resolve(input);
  assert.ok(result.ok, `expected a usable configuration, got ${JSON.stringify(result)}`);
  return { prepared: result.prepared, warnings: result.warnings };
}

function flagsLine(input: Partial<PrepareInput>): string {
  const { prepared } = resolved(input);
  const built = buildLaunch(prepared, { modelId: "org/model" });
  assert.ok(built.ok);
  return describeFlags(built.launch);
}

// ---- defaults ----

test("with no file layers and an empty environment the built-in defaults apply", () => {
  const { prepared, warnings } = resolved();
  assert.deepEqual(prepared.address, { host: "127.0.0.1", port: 8080 });
  assert.equal(prepared.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(prepared.defaultModel, DEFAULT_MODEL_ID);
  assert.deepEqual(prepared.flags, []);
  assert.deepEqual(warnings, []);
});

// ---- the precedence ladder, one test per adjacent pair ----

test("server.port: the global file beats the built-in default", () => {
  const { prepared } = resolved({ global: ok({ server: { port: 9001 } }) });
  assert.equal(prepared.address.port, 9001);
  assert.equal(prepared.baseUrl, "http://127.0.0.1:9001/v1");
});

test("server.port: the project file beats the global file", () => {
  const { prepared } = resolved({
    global: ok({ server: { port: 9001 } }),
    project: ok({ server: { port: 9002 } }),
  });
  assert.equal(prepared.address.port, 9002);
});

test("server.port: the environment beats the project file", () => {
  const { prepared, warnings } = resolved({
    global: ok({ server: { port: 9001 } }),
    project: ok({ server: { port: 9002 } }),
    env: { PI_MLX_MODELS_PORT: "9003" },
  });
  assert.equal(prepared.address.port, 9003);
  assert.deepEqual(warnings, []);
});

test("server.logLevel: the project file beats the global file", () => {
  const { prepared } = resolved({
    global: ok({ server: { logLevel: "INFO" } }),
    project: ok({ server: { logLevel: "DEBUG" } }),
  });
  assert.deepEqual(
    prepared.flags.map((flag) => flag.args),
    [["--log-level=DEBUG"]],
  );
});

test("server.host: the global file, the project file and the environment win in that order", () => {
  const global = ok({ server: { host: "localhost" } });
  const project = ok({ server: { host: "127.0.0.2" } });
  assert.equal(resolved({ global }).prepared.address.host, "localhost");
  assert.equal(resolved({ global, project }).prepared.address.host, "127.0.0.2");
  assert.equal(resolved({ global, project, env: { PI_MLX_MODELS_HOST: "127.0.0.3" } }).prepared.address.host, "127.0.0.3");
});

test("baseUrl: the global file, the project file and the environment win in that order", () => {
  const global = ok({ baseUrl: "http://localhost:8080/v1" });
  const project = ok({ baseUrl: "http://127.0.0.1:8080/v1/" });
  const env = { PI_MLX_MODELS_BASE_URL: "http://[::1]:8080/v1" };
  assert.equal(resolved({ global }).prepared.baseUrl, "http://localhost:8080/v1");
  assert.equal(resolved({ global, project }).prepared.baseUrl, "http://127.0.0.1:8080/v1");
  const top = resolved({ global, project, env });
  assert.equal(top.prepared.baseUrl, "http://[::1]:8080/v1");
  assert.deepEqual(top.warnings, [], "loopback aliases of the launch address do not warn");
});

test("defaultModel: the global file, the project file and the environment win in that order", () => {
  const global = ok({ defaultModel: "org/global" });
  const project = ok({ defaultModel: "org/project" });
  assert.equal(resolved({ global }).prepared.defaultModel, "org/global");
  assert.equal(resolved({ global, project }).prepared.defaultModel, "org/project");
  assert.equal(
    resolved({ global, project, env: { PI_MLX_MODELS_DEFAULT_MODEL: "org/env" } }).prepared.defaultModel,
    "org/env",
  );
});

// ---- merging ----

test("nested objects merge key by key: a higher layer sets one key and the rest comes from below", () => {
  const { prepared } = resolved({
    global: ok({ server: { host: "localhost", port: 9001, logLevel: "INFO" } }),
    project: ok({ server: { port: 9002 } }),
  });
  assert.deepEqual(prepared.address, { host: "localhost", port: 9002 });
  assert.deepEqual(
    prepared.flags.map((flag) => [flag.flag, flag.label]),
    [
      ["--host", "global file"],
      ["--port", "project file"],
      ["--log-level", "global file"],
    ],
  );
});

test("a lower layer's value never leaks when a higher layer sets the same key", () => {
  const { prepared } = resolved({
    global: ok({ server: { logLevel: "ERROR" } }),
    project: ok({ server: { logLevel: "DEBUG" } }),
  });
  const joined = prepared.flags.flatMap((flag) => flag.args).join(" ");
  assert.ok(joined.includes("DEBUG"));
  assert.ok(!joined.includes("ERROR"));
});

// ---- layer states ----

test("an absent file layer contributes nothing and is not an error", () => {
  const result = resolve({ global: absent, project: absent });
  assert.ok(result.ok);
  assert.deepEqual(result.warnings, []);
});

test("an unusable project file makes the result not ok and names the project file", () => {
  const result = resolve({ project: { state: "unusable", reason: "is not valid JSON: boom" } });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some((line) => line.includes("project .pi/pi-mlx-models.json")));
});

test("an unusable global file makes the result not ok and names the global file", () => {
  const result = resolve({ global: { state: "unusable", reason: "must contain a JSON object at the top level" } });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some((line) => line.includes("global config.json")));
});

// ---- provenance ----

test("the flag for a global file value is labelled 'global file'", () => {
  const { prepared } = resolved({ global: ok({ server: { port: 9100 } }) });
  assert.equal(prepared.flags[0].label, "global file");
});

test("the flag for a project file value is labelled 'project file'", () => {
  const { prepared } = resolved({
    global: ok({ server: { port: 9100 } }),
    project: ok({ server: { port: 9101 } }),
  });
  assert.equal(prepared.flags[0].label, "project file");
});

test("the flag for an environment value is labelled with the variable", () => {
  const { prepared } = resolved({ env: { PI_MLX_MODELS_PORT: "9102" } });
  assert.equal(prepared.flags[0].label, "env PI_MLX_MODELS_PORT");
});

// ---- the Phase 1 environment matrix (CFG-05) ----

test("PI_MLX_MODELS_PORT overrides the default port and the derived base URL", () => {
  const { prepared, warnings } = resolved({ env: { PI_MLX_MODELS_PORT: "9123" } });
  assert.equal(prepared.address.port, 9123);
  assert.equal(prepared.baseUrl, "http://127.0.0.1:9123/v1");
  assert.deepEqual(warnings, []);
});

test("an invalid PI_MLX_MODELS_PORT falls back to 8080 with exactly one warning that quotes the value", () => {
  const { prepared, warnings } = resolved({ env: { PI_MLX_MODELS_PORT: "abc" } });
  assert.equal(prepared.address.port, 8080);
  assert.equal(prepared.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PI_MLX_MODELS_PORT/);
  assert.ok(warnings[0].includes(JSON.stringify("abc")));
  assert.match(warnings[0], /is not a port number from 1 to 65535; ignoring it\./);
});

for (const raw of ["0", "65536", "-1", "80.5", "", "   ", "1e3", "0x50"]) {
  test(`PI_MLX_MODELS_PORT=${JSON.stringify(raw)} warns once and falls back to the default`, () => {
    const { prepared, warnings } = resolved({ env: { PI_MLX_MODELS_PORT: raw } });
    assert.equal(prepared.address.port, 8080);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /PI_MLX_MODELS_PORT/);
    assert.ok(warnings[0].includes(JSON.stringify(raw)));
  });
}

test("a padded PI_MLX_MODELS_PORT is accepted without a warning", () => {
  const { prepared, warnings } = resolved({ env: { PI_MLX_MODELS_PORT: " 9123 " } });
  assert.equal(prepared.address.port, 9123);
  assert.deepEqual(warnings, []);
});

test("the range boundaries 1 and 65535 are valid ports", () => {
  assert.equal(resolved({ env: { PI_MLX_MODELS_PORT: "1" } }).prepared.address.port, 1);
  assert.equal(resolved({ env: { PI_MLX_MODELS_PORT: "65535" } }).prepared.address.port, 65535);
});

for (const name of ["PI_MLX_MODELS_HOST", "PI_MLX_MODELS_BASE_URL", "PI_MLX_MODELS_DEFAULT_MODEL"]) {
  test(`a blank ${name} is treated as unset, without a warning`, () => {
    for (const raw of ["", "   "]) {
      const { prepared, warnings } = resolved({ env: { [name]: raw } });
      assert.deepEqual(prepared.address, { host: "127.0.0.1", port: 8080 }, JSON.stringify(raw));
      assert.equal(prepared.baseUrl, "http://127.0.0.1:8080/v1");
      assert.equal(prepared.defaultModel, DEFAULT_MODEL_ID);
      assert.deepEqual(prepared.flags, []);
      assert.deepEqual(warnings, []);
    }
  });
}

test("surrounding whitespace is trimmed from the host, the base URL and the default model", () => {
  const { prepared, warnings } = resolved({
    env: {
      PI_MLX_MODELS_HOST: " 127.0.0.1 ",
      PI_MLX_MODELS_BASE_URL: " http://127.0.0.1:8080/v1 ",
      PI_MLX_MODELS_DEFAULT_MODEL: " org/model ",
    },
  });
  assert.equal(prepared.address.host, "127.0.0.1");
  assert.equal(prepared.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(prepared.defaultModel, "org/model");
  assert.deepEqual(warnings, []);
});

test("an IPv6 launch host is bracketed in the derived base URL, with no warning", () => {
  const { prepared, warnings } = resolved({ env: { PI_MLX_MODELS_HOST: "::1" } });
  assert.equal(prepared.address.host, "::1");
  assert.equal(prepared.baseUrl, "http://[::1]:8080/v1");
  assert.deepEqual(warnings, []);
});

test("trailing slashes are stripped from the base URL and it still matches the launch address", () => {
  const { prepared, warnings } = resolved({ env: { PI_MLX_MODELS_BASE_URL: "http://127.0.0.1:8080/v1//" } });
  assert.equal(prepared.baseUrl, "http://127.0.0.1:8080/v1");
  assert.deepEqual(warnings, []);
});

test("trailing slashes are stripped from a base URL set in a file as well", () => {
  const { prepared } = resolved({ global: ok({ baseUrl: "http://127.0.0.1:8080/v1///" }) });
  assert.equal(prepared.baseUrl, "http://127.0.0.1:8080/v1");
});

// ---- falling through after an ignored environment value (D-06) ----

test("an invalid environment port falls through to the global file, not the built-in default", () => {
  const { prepared, warnings } = resolved({
    global: ok({ server: { port: 9100 } }),
    env: { PI_MLX_MODELS_PORT: "abc" },
  });
  assert.equal(prepared.address.port, 9100);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PI_MLX_MODELS_PORT/);
});

test("an invalid environment port falls through to the project file ahead of the global file", () => {
  const { prepared, warnings } = resolved({
    global: ok({ server: { port: 9100 } }),
    project: ok({ server: { port: 9101 } }),
    env: { PI_MLX_MODELS_PORT: "abc" },
  });
  assert.equal(prepared.address.port, 9101);
  assert.equal(warnings.length, 1);
});

for (const raw of ["-x", "a b", "host;rm", "x".repeat(254)]) {
  test(`an invalid PI_MLX_MODELS_HOST ${JSON.stringify(raw.slice(0, 20))} warns and is never passed on (T-02-05)`, () => {
    const { prepared, warnings } = resolved({ env: { PI_MLX_MODELS_HOST: raw } });
    assert.equal(prepared.address.host, "127.0.0.1");
    assert.deepEqual(prepared.flags, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /PI_MLX_MODELS_HOST/);
  });
}

for (const raw of ["not a url", "ftp://x", "/v1"]) {
  test(`an invalid PI_MLX_MODELS_BASE_URL ${JSON.stringify(raw)} warns and the URL is derived from host and port`, () => {
    const { prepared, warnings } = resolved({ env: { PI_MLX_MODELS_BASE_URL: raw, PI_MLX_MODELS_PORT: "9200" } });
    assert.equal(prepared.baseUrl, "http://127.0.0.1:9200/v1");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /PI_MLX_MODELS_BASE_URL/);
  });
}

// ---- the base URL versus launch address warning, on the merged result (D-03) ----

test("a global-file base URL on another port warns once, naming the global file and both addresses", () => {
  const { warnings } = resolved({ global: ok({ baseUrl: "http://127.0.0.1:9999/v1" }) });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("global config.json"), warnings[0]);
  assert.ok(warnings[0].includes("9999"));
  assert.ok(warnings[0].includes("8080"));
  assert.match(warnings[0], /polling and registration/);
});

test("a project-file base URL on another port warns once, naming the project file", () => {
  const { warnings } = resolved({ project: ok({ baseUrl: "http://127.0.0.1:9999/v1" }) });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("project .pi/pi-mlx-models.json"), warnings[0]);
});

test("an environment base URL on another port warns once, naming the variable", () => {
  const { warnings } = resolved({ env: { PI_MLX_MODELS_BASE_URL: "http://127.0.0.1:9999/v1" } });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("PI_MLX_MODELS_BASE_URL"), warnings[0]);
  assert.match(warnings[0], /polling and registration/);
});

test("the mismatch is computed on the merged result: a port from another layer can cure or cause it", () => {
  const baseUrl = ok({ baseUrl: "http://127.0.0.1:9999/v1" });
  assert.deepEqual(resolved({ global: baseUrl, env: { PI_MLX_MODELS_PORT: "9999" } }).warnings, []);
  const caused = resolved({ global: ok({ baseUrl: "http://127.0.0.1:8080/v1" }), project: ok({ server: { port: 9999 } }) });
  assert.equal(caused.warnings.length, 1);
  assert.ok(caused.warnings[0].includes("global config.json"), "names the layer that set the base URL");
});

test("loopback aliases and wildcard launch hosts against a loopback URL do not warn", () => {
  for (const baseUrl of ["http://localhost:8080/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1"]) {
    for (const host of ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]) {
      const { warnings } = resolved({ env: { PI_MLX_MODELS_BASE_URL: baseUrl, PI_MLX_MODELS_HOST: host } });
      assert.deepEqual(warnings, [], `${baseUrl} vs ${host}`);
    }
  }
});

test("a base URL on another machine warns", () => {
  const { warnings } = resolved({ env: { PI_MLX_MODELS_BASE_URL: "http://example.test:8080/v1" } });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("example.test"));
});

// ---- file strictness (D-07): nothing is coerced ----

const BAD_FILE_VALUES: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["server.port", { server: { port: "8080" } }],
  ["server.port", { server: { port: 8080.5 } }],
  ["server.port", { server: { port: 0 } }],
  ["server.port", { server: { port: 65536 } }],
  ["server.port", { server: { port: true } }],
  ["server.host", { server: { host: "a b" } }],
  ["server.host", { server: { host: "-x" } }],
  ["server.host", { server: { host: 5 } }],
  ["server.logLevel", { server: { logLevel: "debug" } }],
  ["baseUrl", { baseUrl: "ftp://x" }],
  ["baseUrl", { baseUrl: 5 }],
  ["defaultModel", { defaultModel: "" }],
  ["defaultModel", { defaultModel: 5 }],
];

for (const [path, data] of BAD_FILE_VALUES) {
  test(`a global file with ${JSON.stringify(data)} refuses the start and names ${path}`, () => {
    const result = resolve({ global: ok(data) });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].startsWith(`${path} (global config.json): `), result.errors[0]);
  });
}

test("the same bad value in the project file names the project file", () => {
  const result = resolve({ project: ok({ server: { port: "8080" } }) });
  assert.ok(!result.ok);
  assert.ok(result.errors[0].startsWith("server.port (project .pi/pi-mlx-models.json): "), result.errors[0]);
});

test("an unknown key and a non-object server block are refused", () => {
  const unknown = resolve({ global: ok({ nonsense: 1 }) });
  assert.ok(!unknown.ok && unknown.errors.some((line) => line.includes("unknown key")));
  const shape = resolve({ global: ok({ server: 5 }) });
  assert.ok(!shape.ok && shape.errors.some((line) => line.startsWith("server (global config.json): ")));
});

test("a file error does not hide an otherwise valid environment", () => {
  const result = resolve({ global: ok({ server: { port: "x" } }), env: { PI_MLX_MODELS_PORT: "9123" } });
  assert.equal(result.ok, false);
});

// ---- the flags line ----

test("describeFlags lists a set value that differs from its default, with its layer", () => {
  assert.equal(flagsLine({ global: ok({ server: { port: 9100 } }) }), "flags: --port 9100 (global file)");
});

test("describeFlags omits a file value equal to the default", () => {
  assert.equal(flagsLine({ global: ok({ server: { port: 8080 } }) }), "");
});

test("describeFlags returns an empty string when nothing is set", () => {
  assert.equal(flagsLine({}), "");
});

test("describeFlags lists several flags in schema order with each layer", () => {
  const line = flagsLine({
    global: ok({ server: { host: "localhost", logLevel: "INFO" } }),
    env: { PI_MLX_MODELS_PORT: "9100" },
  });
  assert.equal(line, "flags: --host localhost (global file), --port 9100 (env PI_MLX_MODELS_PORT), --log-level INFO (global file)");
});

test("describeFlags clips a very long valid host to the display bound", () => {
  const host = "h".repeat(200);
  const line = flagsLine({ global: ok({ server: { host } }) });
  assert.ok(line.includes(`--host ${"h".repeat(60)} (global file)`), line);
  assert.ok(!line.includes("h".repeat(61)));
});

test("toLaunchSpec carries the address and base URL, and only the optional flags as extra argv", () => {
  const { prepared } = resolved({ global: ok({ server: { host: "localhost", port: 9100, logLevel: "WARNING" } }) });
  const built = buildLaunch(prepared, { modelId: "org/model" });
  assert.ok(built.ok);
  assert.deepEqual(toLaunchSpec(built.launch), {
    address: { host: "localhost", port: 9100 },
    baseUrl: "http://localhost:9100/v1",
    extraArgs: ["--log-level=WARNING"],
  });
});

// ---- reading a config file (D-06, T-02-07, T-02-09): real files, never a throw ----

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** A fresh temporary directory, removed when the test ends. */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mlx-layer-"));
  t.after(() => {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function unusableReason(path: string): string {
  const file = readLayerFile(path);
  assert.equal(file.state, "unusable", JSON.stringify(file));
  assert.ok(file.state === "unusable");
  return file.reason;
}

test("a file that does not exist is absent and nothing is created at that path", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  assert.deepEqual(readLayerFile(path), { state: "absent" });
  assert.equal(existsSync(path), false);
  assert.deepEqual(readLayerFile(join(dir, "missing-dir", "config.json")), { state: "absent" });
  assert.equal(existsSync(join(dir, "missing-dir")), false);
});

test("a path under a parent that is a regular file is absent (ENOTDIR) and nothing is created", (t) => {
  const dir = tempDir(t);
  const parent = join(dir, "not-a-directory");
  writeFileSync(parent, "{}");
  assert.deepEqual(readLayerFile(join(parent, "config.json")), { state: "absent" });
  assert.equal(existsSync(join(parent, "config.json")), false);
});

test("a directory at the path is unusable: it is not a regular file", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  mkdirSync(path);
  assert.equal(unusableReason(path), "is not a regular file");
});

test("a file larger than 256 KiB is unusable and is not parsed", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  // Valid JSON, one byte over the cap: only the size can be the reason it is refused.
  const head = '{"defaultModel":"';
  const tail = '"}';
  writeFileSync(path, head + "x".repeat(256 * 1024 + 1 - head.length - tail.length) + tail);
  assert.equal(unusableReason(path), "is larger than 256 KiB");
});

test("a file of exactly 256 KiB is still read", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  const head = '{"defaultModel":"';
  const tail = '"}';
  writeFileSync(path, head + "x".repeat(256 * 1024 - head.length - tail.length) + tail);
  assert.equal(readLayerFile(path).state, "ok");
});

for (const [name, content] of [
  ["an empty file", ""],
  ["a whitespace-only file", " \n\t \r\n"],
  ["a file holding only a byte order mark", "\uFEFF"],
] as const) {
  test(`${name} is unusable: it is empty`, (t) => {
    const path = join(tempDir(t), "config.json");
    writeFileSync(path, content);
    assert.equal(unusableReason(path), "is empty");
  });
}

test("a UTF-8 byte order mark before valid JSON is ignored", (t) => {
  const path = join(tempDir(t), "config.json");
  writeFileSync(path, '\uFEFF{"server":{"port":9000}}');
  assert.deepEqual(readLayerFile(path), { state: "ok", data: { server: { port: 9000 } } });
});

test("a valid file is returned unchanged", (t) => {
  const path = join(tempDir(t), "config.json");
  const data = { server: { host: "localhost", port: 9000, logLevel: "INFO" }, baseUrl: "http://localhost:9000/v1", extra: [1, null] };
  writeFileSync(path, JSON.stringify(data, null, 2));
  assert.deepEqual(readLayerFile(path), { state: "ok", data });
});

test("a symbolic link to a regular file is followed", { skip: process.platform === "win32" ? "symbolic links need privileges on win32" : false }, (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "real.json"), '{"server":{"port":9001}}');
  symlinkSync(join(dir, "real.json"), join(dir, "config.json"));
  assert.deepEqual(readLayerFile(join(dir, "config.json")), { state: "ok", data: { server: { port: 9001 } } });
});

test("invalid JSON is unusable with a bounded, cleaned parser message", (t) => {
  const path = join(tempDir(t), "config.json");
  writeFileSync(path, "{ nope");
  const reason = unusableReason(path);
  assert.ok(reason.startsWith("is not valid JSON ("), reason);
  assert.ok(reason.endsWith(")"), reason);
  assert.ok(!reason.includes(path), "the reason never contains the file path");
});

test("a very long parser message is clipped to 120 characters and holds no control characters", (t) => {
  const path = join(tempDir(t), "config.json");
  // The parser echoes part of the text it choked on; make that text long and hostile.
  writeFileSync(path, `{"a": "\u001b[31m${"y".repeat(500)}\u009b\n`);
  const reason = unusableReason(path);
  assert.ok(reason.startsWith("is not valid JSON ("), reason);
  assert.ok(reason.length <= "is not valid JSON ()".length + 120, `reason is ${reason.length} characters`);
  assert.ok(!CONTROL_CHARACTERS.test(reason), JSON.stringify(reason));
});

for (const [name, content] of [
  ["an array", "[]"],
  ["null", "null"],
  ["a number", "42"],
  ["a string", '"text"'],
  ["a boolean", "true"],
] as const) {
  test(`a top level that is ${name} is unusable`, (t) => {
    const path = join(tempDir(t), "config.json");
    writeFileSync(path, content);
    assert.equal(unusableReason(path), "must contain a JSON object at the top level");
  });
}

const cannotRead =
  process.platform === "win32"
    ? "file modes are not enforced on win32"
    : process.getuid?.() === 0
      ? "running as root: mode 000 does not stop root from reading"
      : false;

test("an unreadable file is unusable and the reason names the error code", { skip: cannotRead }, (t) => {
  const path = join(tempDir(t), "config.json");
  writeFileSync(path, "{}");
  chmodSync(path, 0o000);
  const reason = unusableReason(path);
  assert.ok(reason.startsWith("cannot be read ("), reason);
  assert.ok(reason.includes("EACCES"), reason);
  assert.ok(!CONTROL_CHARACTERS.test(reason));
});

test("an unreadable parent directory is unusable, not absent", { skip: cannotRead }, (t) => {
  const dir = tempDir(t);
  const sub = join(dir, "locked");
  mkdirSync(sub);
  writeFileSync(join(sub, "config.json"), "{}");
  chmodSync(sub, 0o000);
  try {
    const reason = unusableReason(join(sub, "config.json"));
    assert.ok(reason.startsWith("cannot be read ("), reason);
  } finally {
    chmodSync(sub, 0o700); // so the temporary directory can be removed
  }
});

// ---- the report: every problem in every layer, one line each (D-24, D-07, CFG-03) ----

const PROJECT = "project .pi/pi-mlx-models.json";
const GLOBAL = "global config.json";

/** The errors of a resolution that must have been refused. */
function refused(input: Partial<PrepareInput>): string[] {
  const result = resolve(input);
  assert.equal(result.ok, false, "expected the configuration to be refused");
  assert.ok(!result.ok);
  return result.errors;
}

test("the approved example: two layers, a range error, a typo and an enum error in one report", () => {
  const errors = refused({
    project: ok({ server: { port: 99999, hots: "x" } }),
    global: ok({ server: { logLevel: "debug" } }),
  });
  assert.equal(
    formatConfigErrors(errors),
    [
      "invalid configuration",
      `  server.port (${PROJECT}): 99999 is not an integer from 1 to 65535 (flag --port)`,
      `  server.hots (${PROJECT}): unknown key (did you mean server.host?)`,
      `  server.logLevel (${GLOBAL}): "debug" must be one of DEBUG, INFO, WARNING, ERROR, CRITICAL (flag --log-level)`,
    ].join("\n"),
  );
});

test("problems from two layers and an unusable file are all reported, highest precedence first", () => {
  const errors = refused({
    global: ok({ server: { port: "x" } }),
    project: { state: "unusable", reason: "is empty" },
  });
  assert.deepEqual(errors, [
    `${PROJECT}: is empty`,
    `server.port (${GLOBAL}): "x" is not an integer from 1 to 65535 (flag --port)`,
  ]);
});

test("a clean layer adds nothing to the report", () => {
  const errors = refused({ global: ok({ server: { port: 9000 } }), project: ok({ baseUrl: "ftp://x" }) });
  assert.deepEqual(errors, [`baseUrl (${PROJECT}): "ftp://x" must be an http or https URL`]);
});

test("within a file the lines follow the order of the keys as written", () => {
  const errors = refused({ global: ok({ server: { logLevel: "x", port: 0, host: 5 } }) });
  assert.deepEqual(
    errors.map((line) => line.split(" ")[0]),
    ["server.logLevel", "server.port", "server.host"],
  );
});

test("an environment problem is a warning, not part of the refusal report", () => {
  const result = resolve({ global: ok({ server: { port: "x" } }), env: { PI_MLX_MODELS_PORT: "abc" } });
  assert.ok(!result.ok);
  assert.equal(result.errors.length, 1);
  assert.equal(result.warnings.length, 1);
});

const PROBLEM_PHRASES: ReadonlyArray<[string, Record<string, unknown>, string]> = [
  ["server.host", { server: { host: 5 } }, "5 is not a valid host name or address (flag --host)"],
  ["server.port", { server: { port: "8080" } }, '"8080" is not an integer from 1 to 65535 (flag --port)'],
  ["server.port", { server: { port: 1.5 } }, "1.5 is not an integer from 1 to 65535 (flag --port)"],
  ["server.logLevel", { server: { logLevel: "debug" } }, '"debug" must be one of DEBUG, INFO, WARNING, ERROR, CRITICAL (flag --log-level)'],
  ["baseUrl", { baseUrl: "ftp://x" }, '"ftp://x" must be an http or https URL'],
  ["defaultModel", { defaultModel: "" }, '"" must be a non-empty string'],
  ["defaultModel", { defaultModel: null }, "null must be a non-empty string"],
];

for (const [path, data, phrase] of PROBLEM_PHRASES) {
  test(`${path} with ${JSON.stringify(data)} reports: ${phrase}`, () => {
    assert.deepEqual(refused({ global: ok(data) }), [`${path} (${GLOBAL}): ${phrase}`]);
  });
}

for (const [name, block] of [
  ["a number", 5],
  ["an empty array", []],
  ["null", null],
  ["a string", "x"],
] as const) {
  test(`a server block that is ${name} is one line and is not descended into`, () => {
    assert.deepEqual(refused({ global: ok({ server: block }) }), [`server (${GLOBAL}): ${JSON.stringify(block)} must be a JSON object`]);
  });
}

test("fully valid layers, an empty object and an empty server block are accepted", () => {
  for (const data of [{}, { server: {} }, { server: { host: "localhost", port: 9000, logLevel: "INFO" }, baseUrl: "http://localhost:9000/v1", defaultModel: "org/m" }]) {
    assert.ok(resolve({ global: ok(data) }).ok, JSON.stringify(data));
    assert.ok(resolve({ project: ok(data) }).ok, JSON.stringify(data));
  }
});

// ---- unknown keys and did-you-mean (D-24) ----

/** The single unknown-key line for a file holding exactly `data`. */
function unknownLine(data: Record<string, unknown>): string {
  const errors = refused({ global: ok(data) });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  return errors[0];
}

const SUGGESTIONS: ReadonlyArray<[string, Record<string, unknown>, string, string | undefined]> = [
  // [label, file, key as shown, suggested path]
  ["a one-edit typo", { server: { hots: "x" } }, "server.hots", "server.host"],
  ["a missing letter", { server: { loglevl: "INFO" } }, "server.loglevl", "server.logLevel"],
  ["kebab-case", { server: { "log-level": "INFO" } }, "server.log-level", "server.logLevel"],
  ["snake_case", { server: { log_level: "INFO" } }, "server.log_level", "server.logLevel"],
  ["different case", { server: { LogLevel: "INFO" } }, "server.LogLevel", "server.logLevel"],
  ["all lowercase", { server: { loglevel: "INFO" } }, "server.loglevel", "server.logLevel"],
  ["a tie goes to the earlier row", { server: { hort: 1 } }, "server.hort", "server.host"],
  ["a top-level key that belongs in server: host", { host: "localhost" }, "host", "server.host"],
  ["a top-level key that belongs in server: port", { port: 9000 }, "port", "server.port"],
  ["a top-level key that belongs in server: logLevel", { logLevel: "INFO" }, "logLevel", "server.logLevel"],
  ["a typo of a block name", { sever: {} }, "sever", "server"],
  ["a top-level key in another case", { baseurl: "http://x" }, "baseurl", "baseUrl"],
  ["a top-level key that is a typo of a server key", { hots: "x" }, "hots", "server.host"],
  ["a top-level row written inside server", { server: { baseUrl: "http://x" } }, "server.baseUrl", "baseUrl"],
  ["nothing close", { server: { zzzzzzzz: 1 } }, "server.zzzzzzzz", undefined],
  ["nothing close at the top level", { zzzzzzzz: 1 }, "zzzzzzzz", undefined],
  ["an editor schema key", { $schema: "https://example.test/schema.json" }, "$schema", undefined],
  ["a key too short for the distance rule", { server: { ho: 1 } }, "server.ho", undefined],
];

for (const [label, data, key, suggestion] of SUGGESTIONS) {
  test(`unknown key, ${label}: ${suggestion ? `did you mean ${suggestion}` : "no hint"}`, () => {
    const hint = suggestion ? ` (did you mean ${suggestion}?)` : "";
    assert.equal(unknownLine(data), `${key} (${GLOBAL}): unknown key${hint}`);
  });
}

test("an unknown key carries the layer that set it", () => {
  assert.deepEqual(refused({ project: ok({ server: { hots: 1 } }) }), [`server.hots (${PROJECT}): unknown key (did you mean server.host?)`]);
});

// ---- hostile JSON keys (T-02-08) ----

for (const key of ["__proto__", "constructor", "prototype"]) {
  test(`a parsed ${key} key is an unknown key, the rest still validates, and no prototype is touched`, () => {
    const data = JSON.parse(`{"${key}": {"polluted": true}, "server": {"port": 70000}}`);
    const errors = refused({ global: ok(data) });
    assert.equal(errors.length, 2, JSON.stringify(errors));
    assert.equal(errors[0], `${key} (${GLOBAL}): unknown key`);
    assert.ok(errors[1].startsWith(`server.port (${GLOBAL}): 70000 is not an integer`), errors[1]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
  });

  test(`a parsed ${key} key inside the server block is an unknown key`, () => {
    const data = JSON.parse(`{"server": {"${key}": {"polluted": true}, "port": 9000}}`);
    const errors = refused({ global: ok(data) });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].startsWith(`server.${key} (${GLOBAL}): unknown key`), errors[0]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
}

test("a valid server value is still used when a hostile key is present only at a layer that is refused", () => {
  const data = JSON.parse('{"__proto__": {"polluted": true}}');
  assert.equal(resolve({ global: ok(data) }).ok, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

// ---- sanitizing and bounds (T-02-09) ----

const NOISE = "a\u001b[31mb\u0085c\nd\te\u007ff";

test("keys and values with control characters are echoed without them, on a single line", () => {
  const errors = refused({
    global: ok({ [NOISE]: 1, server: { [NOISE]: 2, logLevel: NOISE, host: NOISE } }),
  });
  assert.equal(errors.length, 4);
  for (const line of errors) {
    assert.ok(!CONTROL_CHARACTERS.test(line), JSON.stringify(line));
  }
});

test("a long value is clipped to 60 characters", () => {
  const [line] = refused({ global: ok({ server: { logLevel: "x".repeat(500) } }) });
  assert.ok(line.includes(`"${"x".repeat(59)} must be one of`), line);
  assert.ok(!line.includes("x".repeat(60)), line);
});

test("a long key is clipped to 80 characters", () => {
  const [line] = refused({ global: ok({ ["k".repeat(500)]: 1 }) });
  const shown = line.slice(0, line.indexOf(" ("));
  assert.equal(shown.length, 80, line);
});

test("a long nested key is clipped to 80 characters including the block name", () => {
  const [line] = refused({ global: ok({ server: { ["k".repeat(500)]: 1 } }) });
  assert.equal(line.slice(0, line.indexOf(" (")).length, 80, line);
});

test("an unusable reason from a hostile source is cleaned and bounded", () => {
  const [line] = refused({ global: { state: "unusable", reason: `is not valid JSON (${NOISE}${"z".repeat(500)})` } });
  assert.ok(!CONTROL_CHARACTERS.test(line), JSON.stringify(line));
  assert.ok(line.length <= `${GLOBAL}: `.length + 200, `${line.length}`);
});

test("the report is capped at 20 problem lines with a count of the rest", () => {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < 25; i += 1) data[`unknownkey${String(i).padStart(2, "0")}`] = i;
  const errors = refused({ global: ok(data) });
  assert.equal(errors.length, 25);
  const lines = formatConfigErrors(errors).split("\n");
  assert.equal(lines.length, 22, "header, 20 problems and the tail");
  assert.equal(lines[0], "invalid configuration");
  assert.equal(lines[20], `  ${errors[19]}`);
  assert.equal(lines[21], "  ...and 5 more problems");
});

test("exactly 20 problems are all shown with no tail", () => {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < 20; i += 1) data[`unknownkey${String(i).padStart(2, "0")}`] = i;
  const lines = formatConfigErrors(refused({ global: ok(data) })).split("\n");
  assert.equal(lines.length, 21);
  assert.ok(!lines.at(-1)!.includes("more problem"));
});

test("a single problem over the cap is described in the singular", () => {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < 21; i += 1) data[`unknownkey${String(i).padStart(2, "0")}`] = i;
  const lines = formatConfigErrors(refused({ global: ok(data) })).split("\n");
  assert.equal(lines.at(-1), "  ...and 1 more problem");
});

// ---- command-line flags and pi flags (plan 02-04) ----

test("cliFlagSpecs lists the flags /mlx-start accepts, in schema order, each with a value", () => {
  assert.deepEqual(cliFlagSpecs(), [
    { flag: "--host", path: "server.host", takesValue: true },
    { flag: "--port", path: "server.port", takesValue: true },
    { flag: "--allowed-origins", path: "server.allowedOrigins", takesValue: true },
    { flag: "--log-level", path: "server.logLevel", takesValue: true },
  ]);
});

test("cliFlagSpecs is derived from the table: a row with a cli name appears and one without does not", () => {
  const extra: SettingDef = {
    path: "server.example",
    kind: "string",
    expected: "anything",
    check: (value) => ({ ok: true, value: String(value) }),
    problem: (shown) => shown,
    parseText: (raw) => ({ ok: true, value: raw }),
    cli: "--example",
    emit: () => [],
  };
  const table = SETTINGS as SettingDef[];
  table.push(extra);
  try {
    assert.deepEqual(cliFlagSpecs().at(-1), { flag: "--example", path: "server.example", takesValue: true });
  } finally {
    table.pop();
  }
  assert.ok(!cliFlagSpecs().some((spec) => spec.flag === "--example"));
  assert.ok(!cliFlagSpecs().some((spec) => spec.path === "baseUrl" || spec.path === "defaultModel"));
});

test("PI_FLAGS lists the four pi flags with descriptions; three of them map to settings", () => {
  assert.deepEqual(
    PI_FLAGS.map((flag) => [flag.name, flag.path]),
    [
      ["mlx-model", undefined],
      ["mlx-port", "server.port"],
      ["mlx-host", "server.host"],
      ["mlx-log-level", "server.logLevel"],
    ],
  );
  for (const flag of PI_FLAGS) assert.ok(flag.description.length > 10, flag.name);
  for (const flag of PI_FLAGS) {
    if (flag.path === undefined) continue;
    assert.equal(SETTINGS.find((row) => row.path === flag.path)?.piFlag, flag.name, `${flag.name} must be the row's pi flag`);
  }
});

test("server.port: a command-line flag beats a pi flag", () => {
  const { prepared } = resolved({ args: { "server.port": "9000" }, piFlags: { "mlx-port": "9100" } });
  assert.equal(prepared.address.port, 9000);
  assert.equal(prepared.baseUrl, "http://127.0.0.1:9000/v1");
  assert.deepEqual(
    prepared.flags.map((flag) => [flag.flag, flag.display, flag.label]),
    [["--port", "9000", "/mlx-start"]],
  );
});

test("server.port: a pi flag beats the environment", () => {
  const { prepared } = resolved({ piFlags: { "mlx-port": "9100" }, env: { PI_MLX_MODELS_PORT: "9200" } });
  assert.equal(prepared.address.port, 9100);
  assert.equal(prepared.flags[0].label, "pi flag --mlx-port");
});

test("server.port: the whole ladder, one layer removed at a time", () => {
  const input: Partial<PrepareInput> = {
    args: { "server.port": "9000" },
    piFlags: { "mlx-port": "9100" },
    env: { PI_MLX_MODELS_PORT: "9200" },
    project: ok({ server: { port: 9300 } }),
    global: ok({ server: { port: 9400 } }),
  };
  const portAndLabel = (i: Partial<PrepareInput>) => {
    const { prepared } = resolved(i);
    return [prepared.address.port, prepared.flags[0]?.label];
  };
  assert.deepEqual(portAndLabel(input), [9000, "/mlx-start"]);
  assert.deepEqual(portAndLabel({ ...input, args: undefined }), [9100, "pi flag --mlx-port"]);
  assert.deepEqual(portAndLabel({ ...input, args: undefined, piFlags: undefined }), [9200, "env PI_MLX_MODELS_PORT"]);
  assert.deepEqual(portAndLabel({ ...input, args: undefined, piFlags: undefined, env: {} }), [9300, "project file"]);
  assert.deepEqual(portAndLabel({ global: input.global }), [9400, "global file"]);
  assert.deepEqual(portAndLabel({}), [8080, undefined]);
});

test("server.logLevel: a command-line flag beats a pi flag, which beats the project file", () => {
  const project = ok({ server: { logLevel: "WARNING" } });
  const piFlags = { "mlx-log-level": "ERROR" };
  const withArgs = resolved({ args: { "server.logLevel": "DEBUG" }, piFlags, project });
  assert.deepEqual(
    withArgs.prepared.flags.map((flag) => [flag.args, flag.label]),
    [[["--log-level=DEBUG"], "/mlx-start"]],
  );
  const withPi = resolved({ piFlags, project });
  assert.deepEqual(
    withPi.prepared.flags.map((flag) => [flag.args, flag.label]),
    [[["--log-level=ERROR"], "pi flag --mlx-log-level"]],
  );
});

test("server.host: a command-line flag beats a pi flag, which beats the environment", () => {
  const env = { PI_MLX_MODELS_HOST: "127.0.0.3" };
  const piFlags = { "mlx-host": "127.0.0.2" };
  assert.equal(resolved({ args: { "server.host": "localhost" }, piFlags, env }).prepared.address.host, "localhost");
  assert.equal(resolved({ piFlags, env }).prepared.address.host, "127.0.0.2");
  assert.equal(resolved({ env }).prepared.address.host, "127.0.0.3");
});

test("the flags line shows every non-default flag with the layer that set it", () => {
  assert.equal(
    flagsLine({ args: { "server.port": "9000" }, piFlags: { "mlx-log-level": "DEBUG" } }),
    "flags: --port 9000 (/mlx-start), --log-level DEBUG (pi flag --mlx-log-level)",
  );
});

test("text from a flag is trimmed like text from the environment", () => {
  const { prepared } = resolved({ args: { "server.port": " 9000 " }, piFlags: { "mlx-log-level": " DEBUG " } });
  assert.equal(prepared.address.port, 9000);
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, ["--log-level=DEBUG"]);
});

function buildOk(prepared: Prepared) {
  const built = buildLaunch(prepared, { modelId: "org/model" });
  assert.ok(built.ok);
  return built.launch;
}

test("a blank pi flag value is ignored", () => {
  const { prepared } = resolved({
    piFlags: { "mlx-port": "   ", "mlx-host": "", "mlx-log-level": undefined },
    global: ok({ server: { port: 9400 } }),
  });
  assert.equal(prepared.address.port, 9400);
  assert.equal(prepared.address.host, "127.0.0.1");
});

test("command-line values for a path with no row, or a row with no flag, never reach the server", () => {
  const { prepared } = resolved({ args: { "server.nonsense": "1", baseUrl: "http://evil.test/v1", defaultModel: "x/y", "--port": "1" } });
  assert.deepEqual(prepared.flags, []);
  assert.equal(prepared.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(prepared.address.port, 8080);
});

test("an invalid command-line value is an error labelled with the flag that carried it", () => {
  assert.deepEqual(refused({ args: { "server.port": "abc" } }), [
    'server.port (/mlx-start --port): "abc" is not an integer from 1 to 65535',
  ]);
  assert.deepEqual(refused({ args: { "server.logLevel": "loud" } }), [
    'server.logLevel (/mlx-start --log-level): "loud" must be one of DEBUG, INFO, WARNING, ERROR, CRITICAL',
  ]);
});

test("an invalid pi flag value is an error labelled with the pi flag", () => {
  assert.deepEqual(refused({ piFlags: { "mlx-port": "70000" } }), [
    'server.port (pi flag --mlx-port): "70000" is not an integer from 1 to 65535',
  ]);
  assert.deepEqual(refused({ piFlags: { "mlx-host": "-bad" } }), [
    'server.host (pi flag --mlx-host): "-bad" is not a valid host name or address',
  ]);
});

test("a bad value is an error even when a lower layer would have supplied a good one", () => {
  const lines = refused({ args: { "server.port": "abc" }, env: { PI_MLX_MODELS_PORT: "9200" }, global: ok({ server: { port: 9400 } }) });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("server.port (/mlx-start --port)"));
});

test("a flag given without its value is an error naming the flag", () => {
  assert.deepEqual(refused({ args: { "server.port": true } }), [
    "server.port (/mlx-start --port): needs a value (a port number from 1 to 65535)",
  ]);
});

test("problems are listed command line first, then pi flags, then the project file, then the global file", () => {
  const lines = refused({
    global: ok({ server: { logLevel: "nope" } }),
    project: ok({ server: { host: "bad host" } }),
    piFlags: { "mlx-port": "70000" },
    args: { "server.logLevel": "loud" },
  });
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith("server.logLevel (/mlx-start --log-level)"), lines[0]);
  assert.ok(lines[1].startsWith("server.port (pi flag --mlx-port)"), lines[1]);
  assert.ok(lines[2].startsWith("server.host (project .pi/pi-mlx-models.json)"), lines[2]);
  assert.ok(lines[3].startsWith(`server.logLevel (${GLOBAL})`), lines[3]);
});

test("an echoed flag value is cleaned of control characters and clipped", () => {
  const [line] = refused({ args: { "server.port": `\u001b[31m${"9".repeat(300)}` } });
  assert.ok(!CONTROL_CHARACTERS.test(line), JSON.stringify(line));
  assert.ok(line.length < 200, `${line.length}`);
});

test("server.allowedOrigins: a list in a file and a comma list as text give the same flag", () => {
  const fromFile = resolved({ global: ok({ server: { allowedOrigins: ["http://a.test", "http://b.test"] } }) });
  assert.deepEqual(
    fromFile.prepared.flags.map((flag) => [flag.flag, flag.args, flag.display, flag.label]),
    [["--allowed-origins", ["--allowed-origins=http://a.test,http://b.test"], "http://a.test,http://b.test", "global file"]],
  );
  const fromText = resolved({ args: { "server.allowedOrigins": "http://a.test,http://b.test" } });
  assert.deepEqual(
    fromText.prepared.flags.map((flag) => flag.args),
    [["--allowed-origins=http://a.test,http://b.test"]],
  );
});

test("server.allowedOrigins accepts a single entry and the wildcard", () => {
  assert.deepEqual(
    resolved({ args: { "server.allowedOrigins": "*" } }).prepared.flags.map((flag) => flag.args),
    [["--allowed-origins=*"]],
  );
  assert.deepEqual(
    resolved({ global: ok({ server: { allowedOrigins: ["*"] } }) }).prepared.flags.map((flag) => flag.args),
    [["--allowed-origins=*"]],
  );
});

test("server.allowedOrigins: the extra argument is a single element and sits between port and log level", () => {
  const { prepared } = resolved({
    args: { "server.logLevel": "DEBUG", "server.allowedOrigins": "http://a.test", "server.port": "9000" },
  });
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, ["--allowed-origins=http://a.test", "--log-level=DEBUG"]);
});

test("server.allowedOrigins: lists that are empty, malformed or the wrong type are errors", () => {
  const phrase = "must be a list of non-empty strings without commas or spaces";
  const cases: unknown[] = [[], [""], ["a,b"], ["a b"], ["a\tb"], [1], ["ok", null], "http://a.test", 7, {}];
  for (const value of cases) {
    const lines = refused({ global: ok({ server: { allowedOrigins: value } }) });
    assert.equal(lines.length, 1, JSON.stringify(value));
    assert.ok(lines[0].includes(phrase), lines[0]);
    assert.ok(lines[0].startsWith(`server.allowedOrigins (${GLOBAL}):`), lines[0]);
  }
});

test("server.allowedOrigins: comma text with an empty or spaced entry is an error", () => {
  const phrase = "must be a list of non-empty strings without commas or spaces";
  for (const text of ["a,,b", "a,b,", ",a", "", "a, b", "a b"]) {
    const lines = refused({ args: { "server.allowedOrigins": text } });
    assert.equal(lines.length, 1, JSON.stringify(text));
    assert.ok(lines[0].startsWith("server.allowedOrigins (/mlx-start --allowed-origins):"), lines[0]);
    assert.ok(lines[0].includes(phrase), lines[0]);
  }
});

test("server.allowedOrigins is a known key: it is not reported as unknown and no default is emitted", () => {
  assert.deepEqual(resolved({ global: ok({ server: {} }) }).prepared.flags, []);
  const lines = refused({ global: ok({ server: { allowedOrigin: ["http://a.test"] } }) });
  assert.ok(lines[0].includes("did you mean server.allowedOrigins?"), lines[0]);
});

// ---- server.trustRemoteCode: a bare boolean flag (D-08, D-01) ----

const TRUST_FLAG = "--trust-remote-code";

test("server.trustRemoteCode: true in a file is emitted as the bare flag, false is never emitted", () => {
  const on = resolved({ global: ok({ server: { trustRemoteCode: true } }) });
  assert.deepEqual(
    on.prepared.flags.map((flag) => [flag.path, flag.flag, flag.args, flag.display, flag.label]),
    [["server.trustRemoteCode", TRUST_FLAG, [TRUST_FLAG], "", "global file"]],
  );
  assert.deepEqual(toLaunchSpec(buildOk(on.prepared)).extraArgs, [TRUST_FLAG]);
  const off = resolved({ global: ok({ server: { trustRemoteCode: false } }) });
  assert.deepEqual(off.prepared.flags, []);
  assert.deepEqual(toLaunchSpec(buildOk(off.prepared)).extraArgs, []);
  assert.equal(describeFlags(buildOk(off.prepared)), "");
});

test("server.trustRemoteCode: anything but a JSON boolean in a file is an error", () => {
  for (const value of ["true", "false", 1, 0, null, [], {}]) {
    const lines = refused({ global: ok({ server: { trustRemoteCode: value } }) });
    assert.equal(lines.length, 1, JSON.stringify(value));
    assert.ok(lines[0].startsWith(`server.trustRemoteCode (${GLOBAL}):`), lines[0]);
    assert.ok(lines[0].includes("must be true or false"), lines[0]);
    assert.ok(lines[0].endsWith(`(flag ${TRUST_FLAG})`), lines[0]);
  }
});

test("server.trustRemoteCode is accepted on /mlx-start as a flag that takes no value", () => {
  const specs = cliFlagSpecs();
  assert.deepEqual(
    specs.find((spec) => spec.flag === TRUST_FLAG),
    { flag: TRUST_FLAG, path: "server.trustRemoteCode", takesValue: false },
  );
  for (const spec of specs) if (spec.flag !== TRUST_FLAG) assert.equal(spec.takesValue, true, spec.flag);
});

test("server.trustRemoteCode: the bare flag typed on /mlx-start turns it on and is labelled with the command", () => {
  const { prepared } = resolved({ args: { "server.trustRemoteCode": true } });
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, [TRUST_FLAG]);
  assert.equal(describeFlags(buildOk(prepared)), `flags: ${TRUST_FLAG} (/mlx-start)`);
});

test("server.trustRemoteCode: text other than true is an error labelled with the flag", () => {
  assert.deepEqual(refused({ args: { "server.trustRemoteCode": "yes" } }), [
    `server.trustRemoteCode (/mlx-start ${TRUST_FLAG}): "yes" must be true or false`,
  ]);
  assert.deepEqual(toLaunchSpec(buildOk(resolved({ args: { "server.trustRemoteCode": "true" } }).prepared)).extraArgs, [TRUST_FLAG]);
});

test("server.trustRemoteCode has no environment variable and no pi flag: nothing but a file or the command turns it on", () => {
  const row = SETTINGS.find((setting) => setting.path === "server.trustRemoteCode");
  assert.ok(row);
  assert.equal(row.env, undefined);
  assert.equal(row.piFlag, undefined);
  const { prepared } = resolved({ env: { PI_MLX_MODELS_TRUST_REMOTE_CODE: "true" }, piFlags: { "mlx-trust-remote-code": "true" } });
  assert.deepEqual(prepared.flags, []);
});

test("server.trustRemoteCode: the flag sits after the log level in the launch arguments", () => {
  const { prepared } = resolved({ global: ok({ server: { trustRemoteCode: true, logLevel: "DEBUG" } }) });
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, ["--log-level=DEBUG", TRUST_FLAG]);
});

test("server.trustRemoteCode: a project file value beats the global file and a command-line flag beats both", () => {
  const global = ok({ server: { trustRemoteCode: true } });
  const project = ok({ server: { trustRemoteCode: false } });
  assert.deepEqual(resolved({ global, project }).prepared.flags, []);
  assert.equal(resolved({ global, project, args: { "server.trustRemoteCode": true } }).prepared.flags[0].label, "/mlx-start");
});

// ---- the project file may never enable code execution or network exposure (D-16, CFG-06) ----

const violationsOf = (project: LayerFile, extra: Partial<PrepareInput> = {}) => resolved({ project, ...extra }).prepared.projectViolations;

test("a project file with server.trustRemoteCode true is a violation; false and absence are not", () => {
  assert.deepEqual(violationsOf(ok({ server: { trustRemoteCode: true } })), [
    { path: "server.trustRemoteCode", shown: "", reason: "lets the model repository run Python code" },
  ]);
  assert.deepEqual(violationsOf(ok({ server: { trustRemoteCode: false } })), []);
  assert.deepEqual(violationsOf(ok({ server: {} })), []);
  assert.deepEqual(resolved().prepared.projectViolations, []);
});

test("a project file host is a violation unless it is one of the loopback spellings", () => {
  for (const host of ["0.0.0.0", "::", "[::]", "::0", "example.test", "192.168.1.5", "127.0.0.2", "::ffff:127.0.0.1"]) {
    assert.deepEqual(
      violationsOf(ok({ server: { host } })),
      [{ path: "server.host", shown: host, reason: "listens on a non-loopback address" }],
      host,
    );
  }
  for (const host of ["127.0.0.1", "localhost", "LocalHost", "::1", "[::1]"]) {
    assert.deepEqual(violationsOf(ok({ server: { host } })), [], host);
  }
});

test("a project file baseUrl is a violation unless its host is loopback", () => {
  for (const baseUrl of ["http://example.test:8080/v1", "https://example.test/v1", "http://0.0.0.0:8080/v1", "http://192.168.1.5:8080/v1"]) {
    assert.deepEqual(
      violationsOf(ok({ baseUrl })),
      [{ path: "baseUrl", shown: baseUrl, reason: "sends prompts to a non-loopback address" }],
      baseUrl,
    );
  }
  for (const baseUrl of ["http://localhost:9999/v1", "http://[::1]:9000/v1", "http://127.0.0.1:8080/v1", "http://LOCALHOST:1/v1"]) {
    assert.deepEqual(violationsOf(ok({ baseUrl })), [], baseUrl);
  }
});

test("the project check is on the file's own content: a higher layer overriding the value does not launder it", () => {
  const project = ok({ server: { host: "0.0.0.0", trustRemoteCode: true } });
  const viaEnv = resolved({ project, env: { PI_MLX_MODELS_HOST: "127.0.0.1" } });
  assert.equal(viaEnv.prepared.address.host, "127.0.0.1");
  assert.deepEqual(
    viaEnv.prepared.projectViolations.map((violation) => violation.path),
    ["server.trustRemoteCode", "server.host"],
  );
  const viaArgs = resolved({ project, args: { "server.host": "localhost" }, piFlags: { "mlx-host": "localhost" } });
  assert.equal(viaArgs.prepared.projectViolations.length, 2);
});

test("violations are listed in the order trustRemoteCode, host, baseUrl", () => {
  const project = ok({ baseUrl: "http://example.test/v1", server: { host: "0.0.0.0", trustRemoteCode: true } });
  assert.deepEqual(
    violationsOf(project).map((violation) => violation.path),
    ["server.trustRemoteCode", "server.host", "baseUrl"],
  );
});

test("risky values in the global file are never project violations", () => {
  const global = ok({ baseUrl: "http://example.test/v1", server: { host: "0.0.0.0", trustRemoteCode: true } });
  assert.deepEqual(resolved({ global }).prepared.projectViolations, []);
});

test("a project file that fails validation is an error, not a violation", () => {
  const lines = refused({ project: ok({ server: { host: "0.0.0.0", trustRemoteCode: "yes" } }) });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(`server.trustRemoteCode (${PROJECT}):`), lines[0]);
});

test("a violation's echoed value is cleaned of control characters and clipped", () => {
  const baseUrl = `http://example.test/${"a".repeat(300)}\u001b[31m`;
  const [violation] = violationsOf(ok({ baseUrl }));
  assert.ok(violation, "the remote base URL must be a violation");
  assert.ok(!CONTROL_CHARACTERS.test(violation.shown), JSON.stringify(violation.shown));
  assert.ok(violation.shown.length <= 60, `${violation.shown.length}`);
});

// ---- trust risks: what needs a confirm on every start (D-13, D-14, D-17) ----

const kindsOf = (input: Partial<PrepareInput>) => trustRisks(resolved(input).prepared).map((risk) => risk.kind);

test("trustRemoteCode from the global file or the command line is a risk with the right source label", () => {
  const [fromGlobal] = trustRisks(resolved({ global: ok({ server: { trustRemoteCode: true } }) }).prepared);
  assert.deepEqual(fromGlobal, {
    kind: "trustRemoteCode",
    phrase: "--trust-remote-code",
    title: "Allow remote code from the model repository?",
    message:
      "--trust-remote-code (from global file) lets the model repository run Python code on this machine. Only continue for repositories you trust.",
  });
  const [fromArgs] = trustRisks(resolved({ args: { "server.trustRemoteCode": true } }).prepared);
  assert.ok(fromArgs.message.startsWith("--trust-remote-code (from /mlx-start) lets the model repository"), fromArgs.message);
  assert.deepEqual(kindsOf({ global: ok({ server: { trustRemoteCode: false } }) }), []);
});

test("a non-loopback host is a risk whichever layer except the project file supplied it", () => {
  const message = (source: string, host = "0.0.0.0", port = 8080) =>
    `The MLX server will listen on ${host}:${port} (from ${source}), reachable from your network. mlx_lm.server has no authentication.`;
  const env = trustRisks(resolved({ env: { PI_MLX_MODELS_HOST: "0.0.0.0" } }).prepared);
  assert.deepEqual(env, [
    { kind: "host", phrase: "listening on 0.0.0.0", title: "Listen on a non-loopback address?", message: message("env PI_MLX_MODELS_HOST") },
  ]);
  assert.ok(trustRisks(resolved({ piFlags: { "mlx-host": "::" } }).prepared)[0].message.includes("(from pi flag --mlx-host)"));
  assert.equal(
    trustRisks(resolved({ args: { "server.host": "0.0.0.0", "server.port": "9000" } }).prepared)[0].message,
    message("/mlx-start", "0.0.0.0", 9000),
  );
  assert.equal(
    trustRisks(resolved({ global: ok({ server: { host: "example.test" } }) }).prepared)[0].message,
    message("global file", "example.test"),
  );
});

test("an IPv6 wildcard host is shown bracketed in front of the port", () => {
  const [risk] = trustRisks(resolved({ env: { PI_MLX_MODELS_HOST: "::" } }).prepared);
  assert.ok(risk.message.startsWith("The MLX server will listen on [::]:8080 (from env PI_MLX_MODELS_HOST)"), risk.message);
  assert.equal(risk.phrase, "listening on ::");
});

test("a non-loopback base URL from the global file or the environment is a risk", () => {
  const [fromGlobal] = trustRisks(resolved({ global: ok({ baseUrl: "http://example.test/v1" }) }).prepared);
  assert.deepEqual(fromGlobal, {
    kind: "baseUrl",
    phrase: "sending prompts to http://example.test/v1",
    title: "Send prompts to a non-loopback address?",
    message: "pi will send your conversation to http://example.test/v1 (from global file), which is not on this machine.",
  });
  const [fromEnv] = trustRisks(resolved({ env: { PI_MLX_MODELS_BASE_URL: "https://example.test:9000/v1" } }).prepared);
  assert.ok(fromEnv.message.includes("(from env PI_MLX_MODELS_BASE_URL)"), fromEnv.message);
});

test("only the effective value counts: a loopback project value over a risky global one is no risk", () => {
  assert.deepEqual(kindsOf({ global: ok({ server: { host: "0.0.0.0" } }), project: ok({ server: { host: "127.0.0.1" } }) }), []);
  assert.deepEqual(
    kindsOf({ global: ok({ baseUrl: "http://example.test/v1" }), project: ok({ baseUrl: "http://localhost:8080/v1" }) }),
    [],
  );
  assert.deepEqual(
    kindsOf({ global: ok({ server: { trustRemoteCode: true } }), project: ok({ server: { trustRemoteCode: false } }) }),
    [],
  );
});

test("a value that comes from the project file is not a trust risk (the project check refuses it instead)", () => {
  const project = ok({ baseUrl: "http://example.test/v1", server: { host: "0.0.0.0", trustRemoteCode: true } });
  assert.deepEqual(kindsOf({ project }), []);
});

test("a risky value in a higher layer than a risky project value is a risk and the project still violates", () => {
  const project = ok({ server: { host: "0.0.0.0" } });
  const { prepared } = resolved({ project, env: { PI_MLX_MODELS_HOST: "::" } });
  assert.deepEqual(
    trustRisks(prepared).map((risk) => risk.kind),
    ["host"],
  );
  assert.equal(prepared.projectViolations.length, 1);
});

test("defaults and loopback values everywhere produce no risk", () => {
  assert.deepEqual(kindsOf({}), []);
  assert.deepEqual(
    kindsOf({
      env: { PI_MLX_MODELS_HOST: "127.0.0.1", PI_MLX_MODELS_BASE_URL: "http://localhost:8080/v1" },
      global: ok({ server: { host: "::1" } }),
      args: { "server.port": "9000" },
    }),
    [],
  );
});

test("a wildcard host without an explicit base URL is a host risk only: the derived URL is not a setting", () => {
  assert.deepEqual(kindsOf({ env: { PI_MLX_MODELS_HOST: "0.0.0.0" } }), ["host"]);
});

test("several risks come in the order trustRemoteCode, host, baseUrl", () => {
  assert.deepEqual(
    kindsOf({
      global: ok({ baseUrl: "http://example.test/v1", server: { trustRemoteCode: true } }),
      env: { PI_MLX_MODELS_HOST: "0.0.0.0" },
    }),
    ["trustRemoteCode", "host", "baseUrl"],
  );
});

test("risk texts contain no control characters even for a base URL that carries them", () => {
  const baseUrl = "http://example.test/v1\u001b[31m\u0007";
  const risks = trustRisks(resolved({ global: ok({ baseUrl }) }).prepared);
  assert.equal(risks.length, 1);
  for (const text of [risks[0].message, risks[0].phrase, risks[0].title]) assert.ok(!CONTROL_CHARACTERS.test(text), JSON.stringify(text));
});

test("a long base URL is shown in full up to 300 characters so its host cannot be hidden by clipping", () => {
  const baseUrl = `http://localhost.${"a".repeat(100)}.example.test/v1`;
  const [risk] = trustRisks(resolved({ global: ok({ baseUrl }) }).prepared);
  assert.ok(risk, "a look-alike host is not loopback");
  assert.ok(risk.message.includes(baseUrl), risk.message);
});

test("formatProjectRefusal lists every violation with its key and ends with the move-to-global line", () => {
  const project = ok({ baseUrl: "http://example.test/v1", server: { host: "0.0.0.0", trustRemoteCode: true } });
  const text = formatProjectRefusal(violationsOf(project), "/home/u/.pi/agent/pi-mlx-models/config.json");
  assert.equal(
    text,
    [
      ".pi/pi-mlx-models.json cannot enable settings that run code or open the network:",
      "  server.trustRemoteCode: lets the model repository run Python code",
      "  server.host (0.0.0.0): listens on a non-loopback address",
      "  baseUrl (http://example.test/v1): sends prompts to a non-loopback address",
      "Move them to /home/u/.pi/agent/pi-mlx-models/config.json; starting then asks for confirmation.",
    ].join("\n"),
  );
});

test("formatProjectRefusal strips control characters from echoed values and from the path", () => {
  const text = formatProjectRefusal(
    [{ path: "server.host", shown: "bad\u001b[31m\nhost", reason: "listens on a non-loopback address" }],
    "/tmp/\u001b[0mconfig.json",
  );
  assert.ok(!CONTROL_CHARACTERS.test(text.replace(/\n/g, "")), JSON.stringify(text));
  assert.equal(text.split("\n").length, 3);
});

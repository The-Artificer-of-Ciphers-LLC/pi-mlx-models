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
  kvNotices,
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

/** The home directory and working directory every launch in these tests is built with. */
const LAUNCH_CTX = { home: "/home/u", cwd: "/work/project" };

function flagsLine(input: Partial<PrepareInput>): string {
  const { prepared } = resolved(input);
  const built = buildLaunch(prepared, { modelId: "org/model" }, LAUNCH_CTX);
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
  const built = buildLaunch(prepared, { modelId: "org/model" }, LAUNCH_CTX);
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

// A key written in a block it does not belong to says where it lives (GAP-01): a hint that repeats the
// name the user typed reads as "you typed it right" and never says the key leaves the block.
const WRONG_PLACE: ReadonlyArray<[string, Record<string, unknown>, string, string]> = [
  // [label, file, key as shown, text after "unknown key"]
  ["baseUrl inside server", { server: { baseUrl: "http://x" } }, "server.baseUrl", ' (baseUrl is a top-level key, not part of "server")'],
  ["defaultModel inside server", { server: { defaultModel: "org/m" } }, "server.defaultModel", ' (defaultModel is a top-level key, not part of "server")'],
  ["baseUrl in another case inside server", { server: { baseurl: "http://x" } }, "server.baseurl", ' (baseUrl is a top-level key, not part of "server")'],
  ["baseUrl in snake_case inside server", { server: { base_url: "http://x" } }, "server.base_url", ' (baseUrl is a top-level key, not part of "server")'],
  ["defaultModel in another case inside server", { server: { defaultmodel: "org/m" } }, "server.defaultmodel", ' (defaultModel is a top-level key, not part of "server")'],
  ["a typo of baseUrl inside server", { server: { baseUri: "http://x" } }, "server.baseUri", ' (did you mean baseUrl? It is a top-level key, not part of "server")'],
  ["a block name inside server", { server: { model: {} } }, "server.model", ' (model is a top-level key, not part of "server")'],
  ["a server key inside model", { model: { host: "x" } }, "model.host", ' (host is a "server" key, not part of "model")'],
  ["a model key inside server", { server: { adapterPath: "/tmp/a" } }, "server.adapterPath", ' (adapterPath is a "model" key, not part of "server")'],
  ["a typo of a model key inside server", { server: { drafmodel: "x" } }, "server.drafmodel", ' (did you mean model.draftModel? It is a "model" key, not part of "server")'],
  ["a server key inside a models entry: host", { models: { qwen3_4b: { host: "0.0.0.0" } } }, 'models["qwen3_4b"].host', ' (host is a "server" key, not part of a "models" entry)'],
  [
    "a server key inside a models entry: trustRemoteCode",
    { models: { qwen3_4b: { trustRemoteCode: true } } },
    'models["qwen3_4b"].trustRemoteCode',
    ' (trustRemoteCode is a "server" key, not part of a "models" entry)',
  ],
  ["a top-level key inside a models entry", { models: { qwen3_4b: { baseUrl: "http://x" } } }, 'models["qwen3_4b"].baseUrl', ' (baseUrl is a top-level key, not part of a "models" entry)'],
];

for (const [label, data, key, hint] of WRONG_PLACE) {
  test(`unknown key in the wrong place, ${label}: the hint says where it lives`, () => {
    assert.equal(unknownLine(data), `${key} (${GLOBAL}): unknown key${hint}`);
  });
}

test("a key written in the wrong place says where it lives in the project layer too", () => {
  assert.deepEqual(refused({ project: ok({ server: { baseUrl: "http://example.com:8080/v1" } }) }), [
    `server.baseUrl (${PROJECT}): unknown key (baseUrl is a top-level key, not part of "server")`,
  ]);
});

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

test("cliFlagSpecs lists the flags /mlx-start accepts, in schema order; only the bare flags take no value", () => {
  assert.deepEqual(cliFlagSpecs(), [
    { flag: "--host", path: "server.host", takesValue: true },
    { flag: "--port", path: "server.port", takesValue: true },
    { flag: "--allowed-origins", path: "server.allowedOrigins", takesValue: true },
    { flag: "--log-level", path: "server.logLevel", takesValue: true },
    { flag: "--trust-remote-code", path: "server.trustRemoteCode", takesValue: false },
    { flag: "--decode-concurrency", path: "server.decodeConcurrency", takesValue: true },
    { flag: "--prompt-concurrency", path: "server.promptConcurrency", takesValue: true },
    { flag: "--prefill-step-size", path: "server.prefillStepSize", takesValue: true },
    { flag: "--prompt-cache-size", path: "server.promptCacheSize", takesValue: true },
    { flag: "--prompt-cache-bytes", path: "server.promptCacheBytes", takesValue: true },
    { flag: "--kv-bits", path: "server.kvBits", takesValue: true },
    { flag: "--adapter-path", path: "model.adapterPath", takesValue: true },
    { flag: "--draft-model", path: "model.draftModel", takesValue: true },
    { flag: "--num-draft-tokens", path: "model.numDraftTokens", takesValue: true },
    { flag: "--chat-template", path: "model.chatTemplate", takesValue: true },
    { flag: "--use-default-chat-template", path: "model.useDefaultChatTemplate", takesValue: false },
    { flag: "--chat-template-args", path: "model.chatTemplateArgs", takesValue: true },
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
  const built = buildLaunch(prepared, { modelId: "org/model" }, LAUNCH_CTX);
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
  for (const spec of specs) if (spec.flag !== TRUST_FLAG && spec.flag !== "--use-default-chat-template") assert.equal(spec.takesValue, true, spec.flag);
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
      // A bracketed host is stored, and so shown, without its brackets.
      [{ path: "server.host", shown: host.replace(/^\[(.*)\]$/, "$1"), reason: "listens on a non-loopback address" }],
      host,
    );
  }
  for (const host of ["127.0.0.1", "localhost", "LocalHost", "::1", "[::1]"]) {
    assert.deepEqual(violationsOf(ok({ server: { host } })), [], host);
  }
});

test("a bracketed IPv6 host is stored without its brackets so the server can bind it, and unbracketed forms are unchanged", () => {
  assert.equal(resolved({ global: ok({ server: { host: "[::1]" } }) }).prepared.address.host, "::1");
  assert.equal(resolved({ args: { "server.host": "[::1]" } }).prepared.address.host, "::1");
  assert.equal(resolved({ global: ok({ server: { host: "::1" } }) }).prepared.address.host, "::1");
  assert.equal(resolved({ global: ok({ server: { host: "localhost" } }) }).prepared.address.host, "localhost");
  assert.equal(resolved({ global: ok({ server: { host: "[::1]" } }) }).prepared.baseUrl, "http://[::1]:8080/v1");
  for (const host of ["[]", "[localhost]", "[::1", "::1]", "[[::1]]", "a[b]"]) {
    assert.equal(resolve({ global: ok({ server: { host } }) }).ok, false, host);
  }
});

test("a project file with allowed origins is a violation, whatever the origins are", () => {
  for (const allowedOrigins of [["*"], ["http://localhost:3000"], ["http://a.test", "http://b.test"]]) {
    const [violation, ...rest] = violationsOf(ok({ server: { allowedOrigins } }));
    assert.equal(rest.length, 0);
    assert.equal(violation.path, "server.allowedOrigins");
    assert.equal(violation.reason, "lets web pages call the local server");
  }
  // The same setting in the global file is the user's own choice and is not a violation.
  assert.deepEqual(resolved({ global: ok({ server: { allowedOrigins: ["*"] } }) }).prepared.projectViolations, []);
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

// ---- model options and the per-model block (plan 02-06: SRV-02, D-01, D-02, D-12, D-21, D-22, D-23) ----

type ModelIdentity = { modelId: string; presetKey?: string };
const QWEN: ModelIdentity = { modelId: "mlx-community/Qwen3-4B-Instruct-2507-4bit", presetKey: "qwen3_4b" };
const LLAMA: ModelIdentity = { modelId: "mlx-community/Llama-3.2-3B-Instruct-4bit", presetKey: "llama3_2_3b" };

/** Build the launch of `model` and require success. */
function launchOf(input: Partial<PrepareInput>, model: ModelIdentity = QWEN, context = LAUNCH_CTX) {
  const built = buildLaunch(resolved(input).prepared, model, context);
  assert.ok(built.ok, `expected a launch, got ${JSON.stringify(built)}`);
  return built.launch;
}

/** The optional argv of the launch: what the server gets after the connection flags. */
function extraOf(input: Partial<PrepareInput>, model: ModelIdentity = QWEN, context = LAUNCH_CTX): readonly string[] {
  return toLaunchSpec(launchOf(input, model, context)).extraArgs;
}

/** The report of a launch that must be refused at the second stage (the first stage accepted the layers). */
function launchErrors(input: Partial<PrepareInput>, model: ModelIdentity = QWEN, context = LAUNCH_CTX): string[] {
  const built = buildLaunch(resolved(input).prepared, model, context);
  assert.equal(built.ok, false, "expected the launch to be refused");
  assert.ok(!built.ok);
  return built.errors;
}

/** A template file in a fresh temporary directory. */
function writeTemplate(t: { after(fn: () => void): void }, content: string | Buffer, name = "template.jinja"): { dir: string; path: string } {
  const dir = tempDir(t);
  const path = join(dir, name);
  writeFileSync(path, content);
  return { dir, path };
}

const MODEL_FLAGS: Readonly<Record<string, string>> = {
  adapterPath: "--adapter-path",
  draftModel: "--draft-model",
  numDraftTokens: "--num-draft-tokens",
  chatTemplate: "--chat-template",
  useDefaultChatTemplate: "--use-default-chat-template",
  chatTemplateArgs: "--chat-template-args",
};

// -- the rows --

const MODEL_BAD_VALUES: ReadonlyArray<[string, readonly unknown[], string]> = [
  ["adapterPath", ["", "   ", 5, null, true, [], {}, "a\u0000b"], "must be a non-empty path"],
  ["draftModel", ["", "  ", 5, null, [], "a\u0001b"], "must be a non-empty string"],
  ["numDraftTokens", [0, 1.5, "4", -1, null, true, 1e21], "is not an integer of at least 1"],
  ["chatTemplate", ["", "  ", 5, null, ["x"], "a\u0000b"], "must be a non-empty path"],
  ["useDefaultChatTemplate", ["true", "false", 1, 0, null, []], "must be true or false"],
  ["chatTemplateArgs", [[], null, "x", "{}", 5, true], "must be a JSON object"],
];

for (const [key, values, phrase] of MODEL_BAD_VALUES) {
  for (const value of values) {
    test(`model.${key} with ${JSON.stringify(value)} in a file reports: ${phrase}`, () => {
      const lines = refused({ global: ok({ model: { [key]: value } }) });
      assert.equal(lines.length, 1, JSON.stringify(lines));
      assert.ok(lines[0].startsWith(`model.${key} (${GLOBAL}): `), lines[0]);
      assert.ok(lines[0].includes(phrase), lines[0]);
      assert.ok(lines[0].endsWith(`(flag ${MODEL_FLAGS[key]})`), lines[0]);
    });
  }
}

test("valid values of every model row are accepted in a file", () => {
  const model = {
    adapterPath: "/tmp/adapters/x",
    draftModel: "mlx-community/draft",
    numDraftTokens: 4,
    chatTemplate: "/tmp/t.jinja",
    useDefaultChatTemplate: false,
    chatTemplateArgs: { enable_thinking: false, nested: { list: [1, "a", null, true] } },
  };
  assert.ok(resolve({ global: ok({ model }) }).ok);
  assert.ok(resolve({ project: ok({ model }) }).ok);
  assert.ok(resolve({ global: ok({ model: {} }) }).ok);
});

test("a model block that is not an object is one line and is not descended into", () => {
  for (const block of [5, [], null, "x"]) {
    assert.deepEqual(refused({ global: ok({ model: block }) }), [`model (${GLOBAL}): ${JSON.stringify(block)} must be a JSON object`]);
  }
});

test("model.numDraftTokens on /mlx-start: digits only, at least 1, labelled with the flag", () => {
  const { prepared } = resolved({ args: { "model.numDraftTokens": " 6 " } });
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, ["--num-draft-tokens=6"]);
  for (const text of ["0", "1.5", "-1", "x", "", "4x", "99999999999999999999"]) {
    assert.deepEqual(refused({ args: { "model.numDraftTokens": text } }), [
      `model.numDraftTokens (/mlx-start --num-draft-tokens): ${JSON.stringify(text)} is not an integer of at least 1`,
    ]);
  }
});

test("model.draftModel, adapterPath and chatTemplate on /mlx-start are checked like file values", () => {
  for (const [path, flag] of [
    ["model.draftModel", "--draft-model"],
    ["model.adapterPath", "--adapter-path"],
    ["model.chatTemplate", "--chat-template"],
  ] as const) {
    const lines = refused({ args: { [path]: "   " } });
    assert.equal(lines.length, 1, path);
    assert.ok(lines[0].startsWith(`${path} (/mlx-start ${flag}): `), lines[0]);
  }
});

test("model.useDefaultChatTemplate on /mlx-start is a bare flag; text other than true is an error", () => {
  assert.deepEqual(toLaunchSpec(buildOk(resolved({ args: { "model.useDefaultChatTemplate": true } }).prepared)).extraArgs, [
    "--use-default-chat-template",
  ]);
  assert.deepEqual(toLaunchSpec(buildOk(resolved({ args: { "model.useDefaultChatTemplate": "true" } }).prepared)).extraArgs, [
    "--use-default-chat-template",
  ]);
  assert.deepEqual(refused({ args: { "model.useDefaultChatTemplate": "yes" } }), [
    `model.useDefaultChatTemplate (/mlx-start --use-default-chat-template): "yes" must be true or false`,
  ]);
});

test("model.chatTemplateArgs on /mlx-start is mlx-lm's own form: a JSON string of an object", () => {
  const { prepared } = resolved({ args: { "model.chatTemplateArgs": ' {"enable_thinking": false} ' } });
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, ['--chat-template-args={"enable_thinking":false}']);
  assert.deepEqual(refused({ args: { "model.chatTemplateArgs": "{bad" } }), [
    `model.chatTemplateArgs (/mlx-start --chat-template-args): "{bad" is not valid JSON; give a JSON object`,
  ]);
  for (const text of ["[1]", "5", "null", '"x"', "true"]) {
    assert.deepEqual(refused({ args: { "model.chatTemplateArgs": text } }), [
      `model.chatTemplateArgs (/mlx-start --chat-template-args): ${JSON.stringify(text)} must be a JSON object`,
    ]);
  }
});

test("model options have no environment variable and no pi flag", () => {
  for (const row of SETTINGS.filter((setting) => setting.path.startsWith("model."))) {
    assert.equal(row.env, undefined, row.path);
    assert.equal(row.piFlag, undefined, row.path);
  }
  const env = { PI_MLX_MODELS_ADAPTER_PATH: "/x", PI_MLX_MODELS_DRAFT_MODEL: "x" };
  assert.deepEqual(extraOf({ env, piFlags: { "mlx-draft-model": "x" } }), []);
});

test("the six model rows come after the server rows, in the order of the flags", () => {
  const paths = SETTINGS.map((row) => row.path);
  assert.ok(paths.indexOf("model.adapterPath") > paths.indexOf("server.trustRemoteCode"));
  assert.deepEqual(paths.slice(paths.indexOf("model.adapterPath"), paths.indexOf("model.adapterPath") + 6), [
    "model.adapterPath",
    "model.draftModel",
    "model.numDraftTokens",
    "model.chatTemplate",
    "model.useDefaultChatTemplate",
    "model.chatTemplateArgs",
  ]);
});

// -- chatTemplateArgs: hostile keys, size, depth (T-02-20, T-02-21) --

for (const key of ["__proto__", "constructor", "prototype"]) {
  test(`chatTemplateArgs rejects a ${key} key at the top, nested and inside an array, from a file and from the command line`, () => {
    const texts = [`{"${key}": {"polluted": true}}`, `{"a": {"b": {"${key}": 1}}}`, `{"a": [{"${key}": {"polluted": true}}]}`];
    for (const text of texts) {
      const fromFile = refused({ global: ok({ model: { chatTemplateArgs: JSON.parse(text) } }) });
      assert.equal(fromFile.length, 1, text);
      assert.ok(fromFile[0].startsWith(`model.chatTemplateArgs (${GLOBAL}): `), fromFile[0]);
      assert.ok(fromFile[0].includes(`contains the key ${key}, which is not allowed`), fromFile[0]);
      const fromEntry = refused({ project: ok({ models: { qwen3_4b: { chatTemplateArgs: JSON.parse(text) } } }) });
      assert.ok(fromEntry[0].startsWith(`models["qwen3_4b"].chatTemplateArgs (${PROJECT}): `), fromEntry[0]);
      assert.ok(fromEntry[0].includes(`contains the key ${key}, which is not allowed`), fromEntry[0]);
      const fromArgs = refused({ args: { "model.chatTemplateArgs": text } });
      assert.ok(fromArgs[0].includes(`contains the key ${key}, which is not allowed`), fromArgs[0]);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
  });
}

test("chatTemplateArgs larger than 16 KiB is an error, whether it comes from a file or from text", () => {
  const big = { text: "x".repeat(20000) };
  const fromFile = refused({ global: ok({ model: { chatTemplateArgs: big } }) });
  assert.equal(fromFile.length, 1);
  assert.ok(fromFile[0].includes("is larger than 16 KiB"), fromFile[0]);
  const fromArgs = refused({ args: { "model.chatTemplateArgs": JSON.stringify(big) } });
  assert.ok(fromArgs[0].includes("is larger than 16 KiB"), fromArgs[0]);
  assert.ok(fromArgs[0].length < 300, "the echoed value is clipped");
  const small = { text: "x".repeat(16000) };
  assert.ok(resolve({ global: ok({ model: { chatTemplateArgs: small } }) }).ok);
});

test("chatTemplateArgs whose merge across layers exceeds 16 KiB is refused when the launch is built", () => {
  const input = {
    global: ok({ model: { chatTemplateArgs: { a: "x".repeat(9000) } } }),
    project: ok({ model: { chatTemplateArgs: { b: "y".repeat(9000) } } }),
  };
  assert.deepEqual(launchErrors(input), [`model.chatTemplateArgs (${PROJECT}): the merged value is larger than 16 KiB`]);
});

test("chatTemplateArgs nested deeper than the limit is an error, never a crash", () => {
  let deep: unknown = 1;
  for (let i = 0; i < 100; i += 1) deep = { a: deep };
  const lines = refused({ global: ok({ model: { chatTemplateArgs: deep } }) });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("is nested too deeply"), lines[0]);
});

test("an absurdly deep value from a parsed file is reported, not thrown", () => {
  const depth = 50000;
  const data = JSON.parse(`{"model": {"chatTemplateArgs": ${'{"a":'.repeat(depth)}1${"}".repeat(depth)}}}`);
  const lines = refused({ global: ok(data) });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(`model.chatTemplateArgs (${GLOBAL}): `), lines[0].slice(0, 100));
});

// -- the models map: shape and validation (D-21) --

test("models that is not an object is one line; so is an entry that is not an object", () => {
  for (const value of [5, [], null, "x"]) {
    assert.deepEqual(refused({ global: ok({ models: value }) }), [`models (${GLOBAL}): ${JSON.stringify(value)} must be a JSON object`]);
  }
  for (const entry of [5, [], null, "x"]) {
    assert.deepEqual(refused({ global: ok({ models: { qwen3_4b: entry } }) }), [
      `models["qwen3_4b"] (${GLOBAL}): ${JSON.stringify(entry)} must be a JSON object`,
    ]);
  }
});

test("empty models and empty entries are accepted", () => {
  assert.ok(resolve({ global: ok({ models: {} }) }).ok);
  assert.ok(resolve({ global: ok({ models: { qwen3_4b: {} } }) }).ok);
});

test("an unknown key in an entry names the entry and suggests among the model keys", () => {
  assert.deepEqual(refused({ global: ok({ models: { qwen3_4b: { draftmodel: "x" } } }) }), [
    `models["qwen3_4b"].draftmodel (${GLOBAL}): unknown key (did you mean model.draftModel?)`,
  ]);
  assert.deepEqual(refused({ project: ok({ models: { "org/m": { numDraftToken: 4 } } }) }), [
    `models["org/m"].numDraftToken (${PROJECT}): unknown key (did you mean model.numDraftTokens?)`,
  ]);
  assert.deepEqual(refused({ global: ok({ models: { qwen3_4b: { zzzzzzzz: 1 } } }) }), [
    `models["qwen3_4b"].zzzzzzzz (${GLOBAL}): unknown key`,
  ]);
});

test("server keys inside an entry are unknown keys that say they belong to the server block", () => {
  assert.deepEqual(refused({ global: ok({ models: { qwen3_4b: { trustRemoteCode: true } } }) }), [
    `models["qwen3_4b"].trustRemoteCode (${GLOBAL}): unknown key (trustRemoteCode is a "server" key, not part of a "models" entry)`,
  ]);
  assert.deepEqual(refused({ global: ok({ models: { qwen3_4b: { host: "0.0.0.0" } } }) }), [
    `models["qwen3_4b"].host (${GLOBAL}): unknown key (host is a "server" key, not part of a "models" entry)`,
  ]);
});

test("a trustRemoteCode key inside a project models entry is an unknown key, not a violation and not an enabled setting", () => {
  const result = resolve({ project: ok({ models: { qwen3_4b: { trustRemoteCode: true } } }) });
  assert.ok(!result.ok);
  assert.equal(result.errors.length, 1);
});

test("an unknown key in the model block suggests a model key", () => {
  assert.deepEqual(refused({ global: ok({ model: { draftmodel: "x" } }) }), [
    `model.draftmodel (${GLOBAL}): unknown key (did you mean model.draftModel?)`,
  ]);
  assert.deepEqual(refused({ global: ok({ model: { host: "x" } }) }), [
    `model.host (${GLOBAL}): unknown key (host is a "server" key, not part of "model")`,
  ]);
});

test("top-level typos of the new blocks are suggested", () => {
  assert.equal(unknownLine({ modles: {} }), `modles (${GLOBAL}): unknown key (did you mean models?)`);
  assert.equal(unknownLine({ modle: {} }), `modle (${GLOBAL}): unknown key (did you mean model?)`);
});

test("a bad value in an entry for a model that is not being launched is still an error: the whole file is validated", () => {
  assert.deepEqual(refused({ global: ok({ models: { llama3_2_3b: { numDraftTokens: 0 } } }) }), [
    `models["llama3_2_3b"].numDraftTokens (${GLOBAL}): 0 is not an integer of at least 1 (flag --num-draft-tokens)`,
  ]);
});

test("entry problems and block problems of one file are all in the one report, in file order", () => {
  const lines = refused({
    global: ok({
      models: { a: { numDraftTokens: 0 }, b: { draftmodel: "x" } },
      server: { port: 0 },
      model: { adapterPath: "" },
    }),
  });
  assert.deepEqual(
    lines.map((line) => line.split(" ")[0]),
    ['models["a"].numDraftTokens', 'models["b"].draftmodel', "server.port", "model.adapterPath"],
  );
});

test("an entry id is cleaned of control characters and clipped in the error path", () => {
  const id = `${"i".repeat(200)}\u001b[31m`;
  const lines = refused({ global: ok({ models: { [id]: { numDraftTokens: 0 }, "a\u0007b\u001b[0m": { numDraftTokens: 0 } } }) });
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(!CONTROL_CHARACTERS.test(line), JSON.stringify(line));
  assert.ok(lines[0].startsWith(`models["${"i".repeat(80)}"].numDraftTokens `), lines[0]);
  assert.ok(!lines[0].includes("i".repeat(81)));
});

test("an entry named like a prototype key is just a model id and pollutes nothing", () => {
  const data = JSON.parse('{"models": {"__proto__": {"draftModel": "polluted"}, "constructor": {"draftModel": "also"}}}');
  const { prepared } = resolved({ global: ok(data) });
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, []);
  assert.equal(({} as Record<string, unknown>).draftModel, undefined);
  assert.deepEqual(extraOf({ global: ok(data) }, { modelId: "__proto__" }), ["--draft-model=polluted"]);
  assert.deepEqual(extraOf({ global: ok(data) }, { modelId: "constructor" }), ["--draft-model=also"]);
});

test("model keys do not touch prepared.flags and are no project violation: they are decided per model", () => {
  const model = { draftModel: "x", numDraftTokens: 3, useDefaultChatTemplate: true };
  const { prepared } = resolved({ project: ok({ model, models: { qwen3_4b: { adapterPath: "/a" } } }) });
  assert.deepEqual(prepared.flags, []);
  assert.deepEqual(prepared.projectViolations, []);
});

// -- emission, in schema order --

test("every model option reaches the argv as specified, in schema order, whatever order the file lists them", (t) => {
  const { path } = writeTemplate(t, "{{ messages }}\n");
  const model = {
    chatTemplateArgs: { enable_thinking: false },
    useDefaultChatTemplate: true,
    chatTemplate: path,
    numDraftTokens: 4,
    draftModel: "mlx-community/draft",
    adapterPath: "~/adapters/x",
  };
  assert.deepEqual(extraOf({ global: ok({ model }) }), [
    "--adapter-path=/home/u/adapters/x",
    "--draft-model=mlx-community/draft",
    "--num-draft-tokens=4",
    "--chat-template={{ messages }}\n",
    "--use-default-chat-template",
    '--chat-template-args={"enable_thinking":false}',
  ]);
});

test("model flags come after the server flags; each valued flag is one element", () => {
  const global = ok({
    model: { draftModel: "d", numDraftTokens: 2 },
    server: { logLevel: "DEBUG", allowedOrigins: ["http://a.test"], trustRemoteCode: true },
  });
  assert.deepEqual(extraOf({ global }), [
    "--allowed-origins=http://a.test",
    "--log-level=DEBUG",
    "--trust-remote-code",
    "--draft-model=d",
    "--num-draft-tokens=2",
  ]);
});

test("a false useDefaultChatTemplate is never emitted or listed, and a higher layer can switch it off", () => {
  assert.deepEqual(extraOf({ global: ok({ model: { useDefaultChatTemplate: false } }) }), []);
  assert.equal(describeFlags(launchOf({ global: ok({ model: { useDefaultChatTemplate: false } }) })), "");
  const layers = { global: ok({ model: { useDefaultChatTemplate: true } }), project: ok({ model: { useDefaultChatTemplate: false } }) };
  assert.deepEqual(extraOf(layers), []);
  assert.deepEqual(extraOf({ ...layers, args: { "model.useDefaultChatTemplate": true } }), ["--use-default-chat-template"]);
});

test("a value that contains an equals sign or starts with a dash stays one element", () => {
  assert.deepEqual(extraOf({ global: ok({ model: { draftModel: "org/a=b", adapterPath: "-weird" } }) }), [
    "--adapter-path=/work/project/-weird",
    "--draft-model=org/a=b",
  ]);
});

test("the launch keeps the model identity and the connection of the prepared settings", () => {
  const launch = launchOf({ global: ok({ server: { port: 9100 }, model: { draftModel: "d" } }) });
  assert.deepEqual(launch.model, QWEN);
  assert.deepEqual(launch.address, { host: "127.0.0.1", port: 9100 });
  assert.equal(launch.baseUrl, "http://127.0.0.1:9100/v1");
});

// -- paths (D-23, assumption A8) --

test("adapterPath: ~ is the home directory, a relative path is under the working directory, an absolute path is unchanged", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["~/adapters/x", "/home/u/adapters/x"],
    ["~", "/home/u"],
    ["rel/path", "/work/project/rel/path"],
    ["./a", "/work/project/a"],
    ["../b", "/work/b"],
    ["~user/x", "/work/project/~user/x"],
    ["/abs/p", "/abs/p"],
  ];
  for (const [value, expected] of cases) {
    assert.deepEqual(extraOf({ global: ok({ model: { adapterPath: value } }) }), [`--adapter-path=${expected}`], value);
  }
});

test("adapterPath resolves against the project directory for every layer, including the global file and a typed flag", () => {
  const context = { home: "/home/u", cwd: "/work/other" };
  for (const input of [
    { global: ok({ model: { adapterPath: "ad" } }) },
    { project: ok({ model: { adapterPath: "ad" } }) },
    { args: { "model.adapterPath": "ad" } },
    { global: ok({ models: { qwen3_4b: { adapterPath: "ad" } } }) },
  ] as Partial<PrepareInput>[]) {
    assert.deepEqual(extraOf(input, QWEN, context), ["--adapter-path=/work/other/ad"], JSON.stringify(input));
  }
});

test("the existence of the adapter directory is not checked", () => {
  assert.deepEqual(extraOf({ global: ok({ model: { adapterPath: "/definitely/not/there" } }) }), ["--adapter-path=/definitely/not/there"]);
});

// -- the chat template file (D-23, T-02-19, T-02-21) --

test("chatTemplate is read at launch time and its text, newlines included, is the value", (t) => {
  const text = "{% for m in messages %}\n{{ m.content }}\n{% endfor %}\né中";
  const { path } = writeTemplate(t, text);
  const input = { global: ok({ model: { chatTemplate: path } }) };
  assert.doesNotThrow(() => resolved(input), "preparing never reads the file");
  assert.deepEqual(extraOf(input), [`--chat-template=${text}`]);
});

test("preparing settings never reads the template: a missing path only fails the launch of the model that uses it", () => {
  const input = { global: ok({ model: { chatTemplate: "/definitely/missing.jinja" } }) };
  assert.ok(resolve(input).ok);
  assert.equal(buildLaunch(resolved(input).prepared, QWEN, LAUNCH_CTX).ok, false);
});

test("chatTemplate: a relative path resolves against the project directory, ~ against the home directory", (t) => {
  const { dir } = writeTemplate(t, "{{ a }}", "rel.jinja");
  assert.deepEqual(extraOf({ project: ok({ model: { chatTemplate: "rel.jinja" } }) }, QWEN, { home: "/nowhere", cwd: dir }), [
    "--chat-template={{ a }}",
  ]);
  assert.deepEqual(extraOf({ global: ok({ model: { chatTemplate: "rel.jinja" } }) }, QWEN, { home: "/nowhere", cwd: dir }), [
    "--chat-template={{ a }}",
  ]);
  assert.deepEqual(extraOf({ global: ok({ model: { chatTemplate: "~/rel.jinja" } }) }, QWEN, { home: dir, cwd: "/nowhere" }), [
    "--chat-template={{ a }}",
  ]);
});

test("chatTemplate: a file of exactly 64 KiB is accepted", (t) => {
  const text = "a".repeat(64 * 1024);
  const { path } = writeTemplate(t, text);
  assert.deepEqual(extraOf({ global: ok({ model: { chatTemplate: path } }) }), [`--chat-template=${text}`]);
});

/** Make the broken template of one case; returns the path the configuration points at. */
const TEMPLATE_FAILURES: ReadonlyArray<[string, (dir: string, path: string) => string, string]> = [
  ["a missing file", (_dir, path) => path, "cannot be read (ENOENT)"],
  ["a directory", (dir) => dir, "is not a regular file"],
  [
    "an empty file",
    (_dir, path) => {
      writeFileSync(path, "");
      return path;
    },
    "is empty",
  ],
  [
    "a file of only whitespace",
    (_dir, path) => {
      writeFileSync(path, " \n\t\n");
      return path;
    },
    "is empty",
  ],
  [
    "a file over 64 KiB",
    (_dir, path) => {
      writeFileSync(path, "a".repeat(64 * 1024 + 1));
      return path;
    },
    "is larger than 64 KiB",
  ],
  [
    "a file that is not UTF-8",
    (_dir, path) => {
      writeFileSync(path, Buffer.from([0x41, 0xff, 0xfe, 0x42]));
      return path;
    },
    "is not valid UTF-8 text",
  ],
  [
    "a file with a NUL byte",
    (_dir, path) => {
      writeFileSync(path, "secret\u0000text");
      return path;
    },
    "is not text (contains a NUL character)",
  ],
];

for (const [name, make, reason] of TEMPLATE_FAILURES) {
  test(`chatTemplate: ${name} fails the launch with one line, ${reason}`, (t) => {
    const dir = tempDir(t);
    const target = make(dir, join(dir, "t.jinja"));
    const expected = [`model.chatTemplate (${GLOBAL}): cannot read ${target}: ${reason}`];
    assert.deepEqual(launchErrors({ global: ok({ model: { chatTemplate: target } }) }), expected);
    assert.ok(!expected[0].includes("secret"), "the file content is never echoed");
  });
}

test("a template error is labelled with the layer that supplied the path", (t) => {
  const dir = tempDir(t);
  const missing = join(dir, "missing.jinja");
  const line = (label: string) => `model.chatTemplate (${label}): cannot read ${missing}: cannot be read (ENOENT)`;
  assert.deepEqual(launchErrors({ project: ok({ model: { chatTemplate: missing } }) }, QWEN, { home: "/nowhere", cwd: dir }), [line(PROJECT)]);
  assert.deepEqual(launchErrors({ global: ok({ models: { qwen3_4b: { chatTemplate: missing } } }) }), [line(GLOBAL)]);
  assert.deepEqual(launchErrors({ args: { "model.chatTemplate": missing } }), [line("/mlx-start --chat-template")]);
});

test("a project file's chatTemplate must stay inside the project directory; the other layers may point anywhere", (t) => {
  const project = writeTemplate(t, "{{ project }}");
  const elsewhere = writeTemplate(t, "{{ elsewhere }}");
  const context = { home: "/nowhere", cwd: project.dir };
  const outside = (path: string) => [`model.chatTemplate (${PROJECT}): ${path} is outside the project directory`];
  const projectModel = (chatTemplate: string) => ({ project: ok({ model: { chatTemplate } }) });
  // Inside: relative and absolute spellings are both fine.
  assert.deepEqual(extraOf(projectModel("template.jinja"), QWEN, context), ["--chat-template={{ project }}"]);
  assert.deepEqual(extraOf(projectModel(project.path), QWEN, context), ["--chat-template={{ project }}"]);
  // Outside: an absolute path, a ".." escape and the home directory are refused, and the file is never read.
  assert.deepEqual(launchErrors(projectModel(elsewhere.path), QWEN, context), outside(elsewhere.path));
  const escape = launchErrors(projectModel("../x.jinja"), QWEN, context);
  assert.equal(escape.length, 1);
  assert.ok(escape[0].startsWith(`model.chatTemplate (${PROJECT}): `) && escape[0].endsWith("x.jinja is outside the project directory"), escape[0]);
  assert.equal(launchErrors({ project: ok({ model: { chatTemplate: "~/x.jinja" } }) }, QWEN, { home: elsewhere.dir, cwd: project.dir }).length, 1);
  // An entry in the project file is judged the same way.
  assert.deepEqual(
    launchErrors({ project: ok({ models: { qwen3_4b: { chatTemplate: elsewhere.path } } }) }, QWEN, context),
    outside(elsewhere.path),
  );
  // The global file, the command line and a project path that loses to a higher layer are not restricted.
  assert.deepEqual(extraOf({ global: ok({ model: { chatTemplate: elsewhere.path } }) }, QWEN, context), ["--chat-template={{ elsewhere }}"]);
  assert.deepEqual(extraOf({ args: { "model.chatTemplate": elsewhere.path } }, QWEN, context), ["--chat-template={{ elsewhere }}"]);
  assert.deepEqual(
    extraOf({ global: ok({ model: { chatTemplate: elsewhere.path } }), args: { "model.chatTemplate": elsewhere.path }, ...projectModel(elsewhere.path) }, QWEN, context),
    ["--chat-template={{ elsewhere }}"],
  );
});

test("a symlink in the project directory that points outside it is refused for a project file", (t) => {
  const project = tempDir(t);
  const elsewhere = writeTemplate(t, "{{ secret }}");
  symlinkSync(elsewhere.path, join(project, "link.jinja"));
  const errors = launchErrors({ project: ok({ model: { chatTemplate: "link.jinja" } }) }, QWEN, { home: "/nowhere", cwd: project });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].endsWith("is outside the project directory"), errors[0]);
});

test("a broken template path in an entry for another model does not fail this launch, and does fail that model's", (t) => {
  const dir = tempDir(t);
  const missing = join(dir, "missing.jinja");
  const input = { global: ok({ models: { llama3_2_3b: { chatTemplate: missing } } }) };
  assert.deepEqual(extraOf(input, QWEN), []);
  assert.equal(launchErrors(input, LLAMA).length, 1);
});

test("only the winning template path is read: a broken path in a lower layer is never touched", (t) => {
  const { path } = writeTemplate(t, "{{ ok }}");
  const input = {
    global: ok({ model: { chatTemplate: "/definitely/missing.jinja" } }),
    args: { "model.chatTemplate": path },
  };
  assert.deepEqual(extraOf(input), ["--chat-template={{ ok }}"]);
});

// -- the override per model (D-21) --

test("the top-level model block applies to every model, with or without a preset", () => {
  const input = { global: ok({ model: { draftModel: "base" } }) };
  for (const model of [QWEN, LLAMA, { modelId: "org/custom" }]) assert.deepEqual(extraOf(input, model), ["--draft-model=base"]);
});

test("models[preset key] merges over the model block; an entry for another model changes nothing", () => {
  const input = {
    global: ok({
      model: { draftModel: "base", numDraftTokens: 2 },
      models: { qwen3_4b: { numDraftTokens: 4 }, llama3_2_3b: { draftModel: "other" } },
    }),
  };
  assert.deepEqual(extraOf(input, QWEN), ["--draft-model=base", "--num-draft-tokens=4"]);
  assert.deepEqual(extraOf(input, LLAMA), ["--draft-model=other", "--num-draft-tokens=2"]);
  assert.deepEqual(extraOf(input, { modelId: "org/custom" }), ["--draft-model=base", "--num-draft-tokens=2"]);
});

test("models[model id] matches the resolved id and beats models[preset key]", () => {
  const input = {
    global: ok({ models: { qwen3_4b: { draftModel: "by-key", numDraftTokens: 3 }, [QWEN.modelId]: { draftModel: "by-id" } } }),
  };
  assert.deepEqual(extraOf(input, QWEN), ["--draft-model=by-id", "--num-draft-tokens=3"]);
  assert.deepEqual(extraOf({ global: ok({ models: { "org/custom": { draftModel: "c" } } }) }, { modelId: "org/custom" }), ["--draft-model=c"]);
});

test("a launch that carries no preset key does not match a key entry; the id entry still matches", () => {
  const input = { global: ok({ models: { qwen3_4b: { draftModel: "by-key" }, [QWEN.modelId]: { numDraftTokens: 5 } } }) };
  assert.deepEqual(extraOf(input, { modelId: QWEN.modelId }), ["--num-draft-tokens=5"]);
});

test("a project model block beats a global models entry (assumption A4)", () => {
  const input = {
    global: ok({ models: { qwen3_4b: { draftModel: "g", numDraftTokens: 3 } } }),
    project: ok({ model: { draftModel: "p" } }),
  };
  assert.deepEqual(extraOf(input), ["--draft-model=p", "--num-draft-tokens=3"]);
  assert.deepEqual(
    launchOf(input).flags.map((flag) => [flag.flag, flag.label]),
    [
      ["--draft-model", "project file"],
      ["--num-draft-tokens", "global file"],
    ],
  );
});

test("a project key entry beats a global id entry, and a project id entry beats a project key entry", () => {
  const global = ok({ models: { [QWEN.modelId]: { draftModel: "g-id" } } });
  assert.deepEqual(extraOf({ global, project: ok({ models: { qwen3_4b: { draftModel: "p-key" } } }) }), ["--draft-model=p-key"]);
  const project = ok({ models: { qwen3_4b: { draftModel: "p-key" }, [QWEN.modelId]: { draftModel: "p-id" } } });
  assert.deepEqual(extraOf({ global, project }), ["--draft-model=p-id"]);
});

test("a /mlx-start flag beats the project and global layers and their entries", () => {
  const input = {
    global: ok({ models: { qwen3_4b: { draftModel: "g" } } }),
    project: ok({ model: { draftModel: "p" }, models: { qwen3_4b: { draftModel: "pe" } } }),
    args: { "model.draftModel": "typed" },
  };
  assert.deepEqual(extraOf(input), ["--draft-model=typed"]);
  assert.deepEqual(launchOf(input).flags.map((flag) => flag.label), ["/mlx-start"]);
});

test("arrays and scalars replace across layers and entries", () => {
  const input = {
    global: ok({ model: { chatTemplateArgs: { list: [1, 2], s: "a", keep: 1 } } }),
    project: ok({ models: { qwen3_4b: { chatTemplateArgs: { list: [3], s: "b" } } } }),
  };
  assert.deepEqual(extraOf(input), ['--chat-template-args={"list":[3],"s":"b","keep":1}']);
});

test("chatTemplateArgs objects merge key by key across layers, entries and the command line", () => {
  const input = {
    global: ok({ model: { chatTemplateArgs: { enable_thinking: false, x: 1, nested: { a: 1 } } } }),
    project: ok({ models: { qwen3_4b: { chatTemplateArgs: { x: 2, nested: { b: 2 }, y: 3 } } } }),
  };
  assert.deepEqual(extraOf(input), ['--chat-template-args={"enable_thinking":false,"x":2,"nested":{"a":1,"b":2},"y":3}']);
  assert.deepEqual(extraOf({ ...input, args: { "model.chatTemplateArgs": '{"y": 9, "z": {"q": 1}}' } }), [
    '--chat-template-args={"enable_thinking":false,"x":2,"nested":{"a":1,"b":2},"y":9,"z":{"q":1}}',
  ]);
  // the entry is for qwen3_4b only
  assert.deepEqual(extraOf(input, LLAMA), ['--chat-template-args={"enable_thinking":false,"x":1,"nested":{"a":1}}']);
});

test("merging never changes the parsed layer data or anything shared, and a launch can be built twice with the same result", () => {
  const globalData = { model: { chatTemplateArgs: { x: 1, nested: { a: 1 } } } };
  const projectData = { models: { qwen3_4b: { chatTemplateArgs: { x: 2, nested: { b: 2 } } } } };
  const before = JSON.stringify([globalData, projectData]);
  const { prepared } = resolved({ global: ok(globalData), project: ok(projectData) });
  const first = toLaunchSpec(buildOk2(prepared)).extraArgs;
  const second = toLaunchSpec(buildOk2(prepared)).extraArgs;
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify([globalData, projectData]), before);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).includes("nested"), false);
});

function buildOk2(prepared: Prepared) {
  const built = buildLaunch(prepared, QWEN, LAUNCH_CTX);
  assert.ok(built.ok);
  return built.launch;
}

// -- provenance and the flags line (D-11) --

test("describeFlags shows model options with their layer; the template is shown as a path, never as text", (t) => {
  const { path } = writeTemplate(t, "SECRET TEMPLATE TEXT");
  const line = describeFlags(
    launchOf({
      global: ok({ model: { numDraftTokens: 4, useDefaultChatTemplate: true, chatTemplateArgs: { a: 1 } } }),
      args: { "model.chatTemplate": path },
    }),
  );
  assert.equal(
    line,
    `flags: --num-draft-tokens 4 (global file), --chat-template ${path} (/mlx-start), --use-default-chat-template (global file), --chat-template-args {"a":1} (global file)`,
  );
  assert.ok(!line.includes("SECRET"));
});

test("a value from a models entry carries the label of the layer that holds the entry; a typed value is labelled /mlx-start", () => {
  const input = {
    global: ok({ models: { qwen3_4b: { draftModel: "g" } } }),
    project: ok({ models: { qwen3_4b: { numDraftTokens: 2 } } }),
    args: { "model.adapterPath": "/a" },
  };
  assert.equal(
    describeFlags(launchOf(input)),
    "flags: --adapter-path /a (/mlx-start), --draft-model g (global file), --num-draft-tokens 2 (project file)",
  );
});

test("a long adapter path is shown with up to 200 characters, cleaned of control characters", () => {
  const path = `/${"d".repeat(150)}/adapter`;
  const line = describeFlags(launchOf({ global: ok({ model: { adapterPath: path } }) }));
  assert.ok(line.includes(path), line);
  assert.ok(!CONTROL_CHARACTERS.test(line));
});

test("the flags merged from models entries differ per model in the flags line", () => {
  const input = { global: ok({ model: { draftModel: "d" }, models: { qwen3_4b: { numDraftTokens: 4 } } }) };
  assert.equal(describeFlags(launchOf(input, QWEN)), "flags: --draft-model d (global file), --num-draft-tokens 4 (global file)");
  assert.equal(describeFlags(launchOf(input, LLAMA)), "flags: --draft-model d (global file)");
});

// -- roadmap success criterion 1 --

test("every connection and model key in the global file produces exactly those flags, in schema order", (t) => {
  const { path } = writeTemplate(t, "{{ messages }}\n");
  const global = ok({
    server: { host: "localhost", port: 9100, allowedOrigins: ["http://a.test", "http://b.test"], logLevel: "DEBUG" },
    model: {
      adapterPath: "/tmp/adapters/x",
      draftModel: "mlx-community/draft",
      numDraftTokens: 4,
      chatTemplate: path,
      useDefaultChatTemplate: true,
      chatTemplateArgs: { enable_thinking: false },
    },
  });
  const spec = toLaunchSpec(launchOf({ global }));
  assert.deepEqual(spec.address, { host: "localhost", port: 9100 });
  assert.deepEqual(spec.extraArgs, [
    "--allowed-origins=http://a.test,http://b.test",
    "--log-level=DEBUG",
    "--adapter-path=/tmp/adapters/x",
    "--draft-model=mlx-community/draft",
    "--num-draft-tokens=4",
    "--chat-template={{ messages }}\n",
    "--use-default-chat-template",
    '--chat-template-args={"enable_thinking":false}',
  ]);
});

// ---- skipped flags (plan 02-07: SRV-06, D-19) ----

const ORIGINS_AND_LEVEL = { server: { allowedOrigins: ["http://a.test"], logLevel: "DEBUG" } };

test("describeFlags marks a skipped flag and leaves the rest alone", () => {
  const launch = launchOf({ global: ok(ORIGINS_AND_LEVEL) });
  assert.equal(
    describeFlags(launch, new Set(["--allowed-origins"])),
    "flags: --allowed-origins http://a.test (global file, skipped), --log-level DEBUG (global file)",
  );
});

test("toLaunchSpec leaves skipped flags out of extraArgs, keeping the order of the others", () => {
  const launch = launchOf({ global: ok(ORIGINS_AND_LEVEL) });
  assert.deepEqual(toLaunchSpec(launch, new Set(["--allowed-origins"])).extraArgs, ["--log-level=DEBUG"]);
  assert.deepEqual(toLaunchSpec(launch, new Set(["--log-level"])).extraArgs, ["--allowed-origins=http://a.test"]);
  assert.deepEqual(toLaunchSpec(launch, new Set(["--allowed-origins", "--log-level"])).extraArgs, []);
});

test("an empty or absent skipped set changes nothing", () => {
  const launch = launchOf({ global: ok(ORIGINS_AND_LEVEL) });
  for (const skipped of [undefined, new Set<string>()]) {
    assert.deepEqual(toLaunchSpec(launch, skipped), toLaunchSpec(launch));
    assert.equal(describeFlags(launch, skipped), describeFlags(launch));
  }
});

test("a skipped bare flag is marked too, and a name that is not in the launch changes nothing", () => {
  const launch = launchOf({ global: ok({ server: { trustRemoteCode: true } }) });
  assert.equal(describeFlags(launch, new Set(["--trust-remote-code"])), "flags: --trust-remote-code (global file, skipped)");
  assert.deepEqual(toLaunchSpec(launch, new Set(["--no-such-flag"])).extraArgs, ["--trust-remote-code"]);
});

test("a model flag can be skipped as well", () => {
  const launch = launchOf({ global: ok({ model: { numDraftTokens: 4 } }) });
  assert.equal(describeFlags(launch, new Set(["--num-draft-tokens"])), "flags: --num-draft-tokens 4 (global file, skipped)");
  assert.deepEqual(toLaunchSpec(launch, new Set(["--num-draft-tokens"])).extraArgs, []);
});

// ---- performance flags (SRV-04) ----

test("server.decodeConcurrency: a global value becomes one --decode-concurrency=N element with its layer", () => {
  const { prepared } = resolved({ global: ok({ server: { decodeConcurrency: 4 } }) });
  assert.equal(prepared.flags.length, 1);
  const [flag] = prepared.flags;
  assert.equal(flag.flag, "--decode-concurrency");
  assert.deepEqual(flag.args, ["--decode-concurrency=4"]);
  assert.equal(flag.display, "4");
  assert.equal(flag.label, "global file");
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, ["--decode-concurrency=4"]);
});

const BAD_DECODE_CONCURRENCY: ReadonlyArray<[unknown, string]> = [
  [0, "0"],
  [-1, "-1"],
  [1.5, "1.5"],
  ["4", '"4"'],
  [true, "true"],
  [null, "null"],
];

for (const [value, shown] of BAD_DECODE_CONCURRENCY) {
  test(`server.decodeConcurrency: ${shown} in the global file is refused with one line`, () => {
    assert.deepEqual(refused({ global: ok({ server: { decodeConcurrency: value } }) }), [
      `server.decodeConcurrency (${GLOBAL}): ${shown} is not an integer of at least 1 (flag --decode-concurrency)`,
    ]);
  });
}

test("server.decodeConcurrency: a value typed on /mlx-start beats the global file and is labelled with the command", () => {
  const { prepared } = resolved({
    global: ok({ server: { decodeConcurrency: 4 } }),
    args: { "server.decodeConcurrency": "2" },
  });
  assert.equal(prepared.flags.length, 1);
  assert.deepEqual(prepared.flags[0].args, ["--decode-concurrency=2"]);
  assert.equal(prepared.flags[0].label, "/mlx-start");
});

test("server.decodeConcurrency: PI_MLX_MODELS_DECODE_CONCURRENCY has no effect and draws no warning", () => {
  const { prepared, warnings } = resolved({ env: { PI_MLX_MODELS_DECODE_CONCURRENCY: "4" } });
  assert.deepEqual(prepared.flags, []);
  assert.deepEqual(warnings, []);
});

// ---- the other four performance rows (SRV-04) ----

const PERFORMANCE_ROWS: ReadonlyArray<[key: string, flag: string]> = [
  ["promptConcurrency", "--prompt-concurrency"],
  ["prefillStepSize", "--prefill-step-size"],
  ["promptCacheSize", "--prompt-cache-size"],
  ["promptCacheBytes", "--prompt-cache-bytes"],
];

const BYTES_EXAMPLE = "an integer number of bytes of at least 1, for example 8589934592 for 8 GiB";

for (const [key, flag] of PERFORMANCE_ROWS) {
  test(`server.${key}: 1 and the largest safe integer are accepted and emitted as one ${flag}=N element`, () => {
    for (const value of [1, 9007199254740991]) {
      const { prepared } = resolved({ global: ok({ server: { [key]: value } }) });
      assert.deepEqual(prepared.flags.map((flag) => flag.args), [[`${flag}=${value}`]]);
      assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, [`${flag}=${value}`]);
    }
  });

  const cases: ReadonlyArray<[unknown, string]> = [
    [0, "0"],
    [-1, "-1"],
    [1.5, "1.5"],
    ["3", '"3"'],
    [true, "true"],
    [9007199254740992, "9007199254740992"],
  ];
  for (const [value, shown] of cases) {
    test(`server.${key}: ${shown} in the global file is refused with one line`, () => {
      const problem = key === "promptCacheBytes" ? `is not ${BYTES_EXAMPLE}` : "is not an integer of at least 1";
      assert.deepEqual(refused({ global: ok({ server: { [key]: value } }) }), [
        `server.${key} (${GLOBAL}): ${shown} ${problem} (flag ${flag})`,
      ]);
    });
  }
}

test("server.promptCacheBytes: the refusal of 0 reads exactly, with the 8 GiB example", () => {
  assert.deepEqual(refused({ global: ok({ server: { promptCacheBytes: 0 } }) }), [
    "server.promptCacheBytes (global config.json): 0 is not an integer number of bytes of at least 1, for example 8589934592 for 8 GiB (flag --prompt-cache-bytes)",
  ]);
});

const ALL_FIVE = {
  decodeConcurrency: 2,
  promptConcurrency: 4,
  prefillStepSize: 1024,
  promptCacheSize: 5,
  promptCacheBytes: 8589934592,
};

test("a global file that sets all five lists them in schema order with their layer, and passes them in that order", () => {
  const { prepared } = resolved({ global: ok({ server: ALL_FIVE }) });
  assert.equal(
    describeFlags(buildOk(prepared)),
    "flags: --decode-concurrency 2 (global file), --prompt-concurrency 4 (global file), --prefill-step-size 1024 (global file), --prompt-cache-size 5 (global file), --prompt-cache-bytes 8589934592 (global file)",
  );
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, [
    "--decode-concurrency=2",
    "--prompt-concurrency=4",
    "--prefill-step-size=1024",
    "--prompt-cache-size=5",
    "--prompt-cache-bytes=8589934592",
  ]);
});

test("the five performance rows follow server.trustRemoteCode in the order of the flags", () => {
  const paths = SETTINGS.map((row) => row.path);
  const start = paths.indexOf("server.trustRemoteCode") + 1;
  assert.deepEqual(paths.slice(start, start + 5), [
    "server.decodeConcurrency",
    "server.promptConcurrency",
    "server.prefillStepSize",
    "server.promptCacheSize",
    "server.promptCacheBytes",
  ]);
});

test("a value equal to the server's own default is still passed and shown", () => {
  const { prepared } = resolved({ global: ok({ server: { prefillStepSize: 2048 } }) });
  assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, ["--prefill-step-size=2048"]);
  assert.equal(describeFlags(buildOk(prepared)), "flags: --prefill-step-size 2048 (global file)");
});

test("the project file may set all five: no violation, and the layer is the project file", () => {
  const { prepared } = resolved({ project: ok({ server: ALL_FIVE }) });
  assert.deepEqual(prepared.projectViolations, []);
  assert.deepEqual(
    prepared.flags.map((flag) => flag.label),
    ["project file", "project file", "project file", "project file", "project file"],
  );
});

test("none of the five rows has an environment variable or a pi flag, and the pi flags stay the four of phase 2", () => {
  for (const key of ["decodeConcurrency", ...PERFORMANCE_ROWS.map(([name]) => name)]) {
    const row = SETTINGS.find((setting) => setting.path === `server.${key}`);
    assert.ok(row, key);
    assert.equal(row.env, undefined, key);
    assert.equal(row.piFlag, undefined, key);
    assert.equal(row.default, undefined, key);
    assert.equal(row.perModel, undefined, key);
  }
  assert.deepEqual(
    PI_FLAGS.map((flag) => flag.name),
    ["mlx-model", "mlx-port", "mlx-host", "mlx-log-level"],
  );
});

// ---- KV quantization (SRV-05) ----

const BATCHING = "Disables batching, so requests are served one at a time.";

for (const bits of [2, 8]) {
  test(`server.kvBits: ${bits} in the global file is accepted and emitted as --kv-bits=${bits}`, () => {
    const { prepared } = resolved({ global: ok({ server: { kvBits: bits } }) });
    assert.deepEqual(prepared.flags.map((flag) => flag.args), [[`--kv-bits=${bits}`]]);
    assert.deepEqual(toLaunchSpec(buildOk(prepared)).extraArgs, [`--kv-bits=${bits}`]);
  });
}

const BAD_KV_BITS: ReadonlyArray<[unknown, string]> = [
  [1, "1"],
  [9, "9"],
  [0, "0"],
  [4.5, "4.5"],
  ["4", '"4"'],
  [true, "true"],
  [null, "null"],
];

for (const [value, shown] of BAD_KV_BITS) {
  test(`server.kvBits: ${shown} in the global file is refused naming the range`, () => {
    assert.deepEqual(refused({ global: ok({ server: { kvBits: value } }) }), [
      `server.kvBits (${GLOBAL}): ${shown} is not an integer from 2 to 8 (flag --kv-bits)`,
    ]);
  });
}

test("server.kvBits: a value typed on /mlx-start is labelled with the command", () => {
  const { prepared } = resolved({ args: { "server.kvBits": "4" } });
  assert.deepEqual(prepared.flags.map((flag) => [flag.args, flag.label]), [[["--kv-bits=4"], "/mlx-start"]]);
});

test("kvNotices: kvBits from the global file gives mlx-lm's own batching sentence and no info note", () => {
  const notices = kvNotices(launchOf({ global: ok({ server: { kvBits: 4 } }) }));
  assert.deepEqual(notices, { warning: `KV quantization (--kv-bits 4, global file): ${BATCHING}` });
});

test("kvNotices: without kvBits there is neither a warning nor an info note", () => {
  assert.deepEqual(kvNotices(launchOf({})), {});
  assert.deepEqual(kvNotices(launchOf({ global: ok({ server: { logLevel: "DEBUG" } }) })), {});
});

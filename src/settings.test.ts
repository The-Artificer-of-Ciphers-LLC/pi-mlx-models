import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_ID } from "./config.js";
import {
  buildLaunch,
  describeFlags,
  prepareSettings,
  toLaunchSpec,
  type LayerFile,
  type PrepareInput,
  type Prepared,
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

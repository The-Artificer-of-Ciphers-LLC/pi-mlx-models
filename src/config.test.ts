import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, PROJECT_CONFIG_RELPATH, baseUrlWarning, deriveBaseUrl, isLoopbackHost, parsePort, resolveAgentDir } from "./config.js";

interface LoadedConfig {
  DATA_DIR: string;
  VENV_DIR: string;
  VENV_PYTHON: string;
  HF_HOME: string;
  GLOBAL_CONFIG_PATH: string;
  [name: string]: unknown;
}

// Load the compiled config.js in a child Node process with a fully controlled
// environment, so the developer's own PI_MLX_MODELS_* / PI_CODING_AGENT_DIR
// values cannot leak in and nothing binds a real port (D-02).
function loadConfig(overrides: Record<string, string> = {}): LoadedConfig {
  const configUrl = new URL("./config.js", import.meta.url).href;
  const script = `import(${JSON.stringify(configUrl)}).then((m) => { process.stdout.write(JSON.stringify(m)); });`;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...overrides };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as LoadedConfig;
}

test("the default port is 8080", () => {
  assert.equal(DEFAULT_PORT, 8080);
});

test("deriveBaseUrl ends in /v1 and brackets a bare IPv6 host", () => {
  assert.equal(deriveBaseUrl("127.0.0.1", 8080), "http://127.0.0.1:8080/v1");
  assert.equal(deriveBaseUrl("::1", 9123), "http://[::1]:9123/v1");
  assert.equal(deriveBaseUrl("[::1]", 9123), "http://[::1]:9123/v1");
});

// D-05: nothing user-editable is read when the module loads, so the settings that used to be
// import-time constants are not exported at all, whatever the environment says.
test("the module exports no import-time port, host, base URL, default model or warning list", () => {
  const cfg = loadConfig({
    PI_MLX_MODELS_PORT: "9123",
    PI_MLX_MODELS_HOST: "::1",
    PI_MLX_MODELS_BASE_URL: "http://127.0.0.1:9999/v1",
    PI_MLX_MODELS_DEFAULT_MODEL: "org/model",
  });
  for (const name of ["PORT", "HOST", "BASE_URL", "DEFAULT_MODEL", "CONFIG_WARNINGS"]) {
    assert.ok(!(name in cfg), `${name} must not be exported`);
  }
});

test("parsePort accepts undefined, plain and padded integers without a warning", () => {
  assert.deepEqual(parsePort(undefined), { port: 8080 });
  assert.deepEqual(parsePort("9123"), { port: 9123 });
  assert.deepEqual(parsePort(" 9123 "), { port: 9123 });
});

test("parsePort accepts the range boundaries 1 and 65535", () => {
  assert.deepEqual(parsePort("1"), { port: 1 });
  assert.deepEqual(parsePort("65535"), { port: 65535 });
});

test("parsePort rejects empty, text, zero, out-of-range, negative and fractional values", () => {
  for (const raw of ["", "abc", "0", "65536", "-1", "80.5"]) {
    const result = parsePort(raw);
    assert.equal(result.port, 8080, `fallback for ${JSON.stringify(raw)}`);
    assert.ok(result.warning, `warning for ${JSON.stringify(raw)}`);
    assert.match(result.warning, /PI_MLX_MODELS_PORT/);
    assert.ok(result.warning.includes(JSON.stringify(raw)), `warning names rejected value ${JSON.stringify(raw)}`);
  }
});

test("parsePort honours an explicit fallback", () => {
  assert.equal(parsePort("nope", 9000).port, 9000);
});

test("resolveAgentDir prefers an injected getAgentDir over env", () => {
  const dir = resolveAgentDir({ getAgentDir: () => "/from/pi", env: { PI_CODING_AGENT_DIR: "/from/env" }, home: "/home/u" });
  assert.equal(dir, "/from/pi");
});

test("resolveAgentDir reads PI_CODING_AGENT_DIR when getAgentDir is absent", () => {
  assert.equal(resolveAgentDir({ env: { PI_CODING_AGENT_DIR: "/x/y" }, home: "/home/u" }), "/x/y");
});

test("resolveAgentDir expands ~ and ~/ against home", () => {
  assert.equal(resolveAgentDir({ env: { PI_CODING_AGENT_DIR: "~" }, home: "/home/u" }), "/home/u");
  assert.equal(resolveAgentDir({ env: { PI_CODING_AGENT_DIR: "~/a" }, home: "/home/u" }), join("/home/u", "a"));
});

test("resolveAgentDir falls back to ~/.pi/agent with nothing configured", () => {
  assert.equal(resolveAgentDir({ env: {}, home: "/home/u" }), join("/home/u", ".pi", "agent"));
});

test("resolveAgentDir falls back to env/home rules when getAgentDir throws", () => {
  const boom = (): string => {
    throw new Error("boom");
  };
  assert.equal(resolveAgentDir({ getAgentDir: boom, env: { PI_CODING_AGENT_DIR: "/x/y" }, home: "/home/u" }), "/x/y");
  assert.equal(resolveAgentDir({ getAgentDir: boom, env: {}, home: "/home/u" }), join("/home/u", ".pi", "agent"));
});

test("PI_CODING_AGENT_DIR moves DATA_DIR, VENV_DIR, VENV_PYTHON and HF_HOME", (t) => {
  const agent = mkdtempSync(join(tmpdir(), "pi-mlx-agent-"));
  t.after(() => rmSync(agent, { recursive: true, force: true }));
  const cfg = loadConfig({ PI_CODING_AGENT_DIR: agent });
  const data = join(agent, "pi-mlx-models");
  assert.equal(cfg.DATA_DIR, data);
  assert.equal(cfg.VENV_DIR, join(data, "venv"));
  assert.equal(cfg.VENV_PYTHON, join(data, "venv", "bin", "python3"));
  assert.equal(cfg.HF_HOME, join(data, "models"));
});

test("with PI_CODING_AGENT_DIR unset DATA_DIR stays at HOME/.pi/agent/pi-mlx-models", (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-mlx-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cfg = loadConfig({ HOME: home });
  assert.equal(cfg.DATA_DIR, join(home, ".pi", "agent", "pi-mlx-models"));
});

test("PI_CODING_AGENT_DIR with a leading ~ expands against HOME", (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-mlx-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cfg = loadConfig({ HOME: home, PI_CODING_AGENT_DIR: "~/custom" });
  assert.equal(cfg.DATA_DIR, join(home, "custom", "pi-mlx-models"));
});

test("baseUrlWarning returns null when no explicit base URL is given", () => {
  assert.equal(baseUrlWarning({ baseUrl: undefined, host: "127.0.0.1", port: 8080 }), null);
});

test("baseUrlWarning returns null when host and port match the launch address", () => {
  assert.equal(baseUrlWarning({ baseUrl: "http://127.0.0.1:8080/v1", host: "127.0.0.1", port: 8080 }), null);
});

test("baseUrlWarning treats 127.0.0.1, localhost and ::1 as the same loopback host", () => {
  for (const baseUrl of ["http://localhost:8080/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1"]) {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      assert.equal(baseUrlWarning({ baseUrl, host, port: 8080 }), null, `${baseUrl} vs ${host}`);
    }
  }
});

test("baseUrlWarning lets a wildcard launch host match a loopback URL", () => {
  assert.equal(baseUrlWarning({ baseUrl: "http://127.0.0.1:8080/v1", host: "0.0.0.0", port: 8080 }), null);
  assert.equal(baseUrlWarning({ baseUrl: "http://localhost:8080/v1", host: "::", port: 8080 }), null);
});

test("baseUrlWarning warns on a different port and names both addresses", () => {
  const warning = baseUrlWarning({ baseUrl: "http://127.0.0.1:9999/v1", host: "127.0.0.1", port: 8080 });
  assert.ok(warning);
  assert.ok(warning.includes("9999"));
  assert.ok(warning.includes("8080"));
  assert.match(warning, /polling and registration/);
});

test("baseUrlWarning warns on a different machine", () => {
  const warning = baseUrlWarning({ baseUrl: "http://example.test:8080/v1", host: "127.0.0.1", port: 8080 });
  assert.ok(warning);
  assert.ok(warning.includes("example.test"));
});

test("baseUrlWarning warns when the base URL is not a valid URL", () => {
  const warning = baseUrlWarning({ baseUrl: "not a url", host: "127.0.0.1", port: 8080 });
  assert.ok(warning);
  assert.match(warning, /not a valid URL/);
});

test("baseUrlWarning reads an omitted port as 80 for http and 443 for https", () => {
  assert.equal(baseUrlWarning({ baseUrl: "http://127.0.0.1/v1", host: "127.0.0.1", port: 80 }), null);
  assert.equal(baseUrlWarning({ baseUrl: "https://127.0.0.1/v1", host: "127.0.0.1", port: 443 }), null);
  assert.ok(baseUrlWarning({ baseUrl: "http://127.0.0.1/v1", host: "127.0.0.1", port: 8080 }));
});

test("GLOBAL_CONFIG_PATH is config.json inside DATA_DIR", (t) => {
  const agent = mkdtempSync(join(tmpdir(), "pi-mlx-agent-"));
  t.after(() => rmSync(agent, { recursive: true, force: true }));
  const cfg = loadConfig({ PI_CODING_AGENT_DIR: agent });
  assert.equal(cfg.GLOBAL_CONFIG_PATH, join(agent, "pi-mlx-models", "config.json"));
});

test("isLoopbackHost accepts exactly the three loopback spellings, in any case and with IPv6 brackets", () => {
  for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "LocalHost", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
});

test("isLoopbackHost rejects wildcards, other loopback-looking addresses and names", () => {
  const hosts = [
    "0.0.0.0",
    "::",
    "[::]",
    "::0",
    "127.0.0.2",
    "127.1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:0:0:1",
    "example.test",
    "192.168.1.5",
    "localhost.example.test",
    "localhost.",
    " localhost",
    "",
  ];
  for (const host of hosts) assert.equal(isLoopbackHost(host), false, JSON.stringify(host));
});

test("the project config file is .pi/pi-mlx-models.json relative to the working directory", () => {
  assert.equal(PROJECT_CONFIG_RELPATH, join(".pi", "pi-mlx-models.json"));
});

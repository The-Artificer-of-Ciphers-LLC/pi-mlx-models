import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, parsePort, resolveAgentDir } from "./config.js";

interface LoadedConfig {
  PORT: number;
  HOST: string;
  BASE_URL: string;
  DATA_DIR: string;
  VENV_DIR: string;
  VENV_PYTHON: string;
  HF_HOME: string;
  CONFIG_WARNINGS: string[];
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

test("default port is 8080 and BASE_URL follows it when no env is set", () => {
  const cfg = loadConfig();
  assert.equal(DEFAULT_PORT, 8080);
  assert.equal(cfg.PORT, 8080);
  assert.equal(cfg.HOST, "127.0.0.1");
  assert.equal(cfg.BASE_URL, "http://127.0.0.1:8080/v1");
  assert.deepEqual(cfg.CONFIG_WARNINGS, []);
});

test("PI_MLX_MODELS_PORT overrides the default port and BASE_URL", () => {
  const cfg = loadConfig({ PI_MLX_MODELS_PORT: "9123" });
  assert.equal(cfg.PORT, 9123);
  assert.equal(cfg.BASE_URL, "http://127.0.0.1:9123/v1");
  assert.deepEqual(cfg.CONFIG_WARNINGS, []);
});

test("an invalid PI_MLX_MODELS_PORT falls back to 8080 with exactly one warning", () => {
  const cfg = loadConfig({ PI_MLX_MODELS_PORT: "abc" });
  assert.equal(cfg.PORT, 8080);
  assert.equal(cfg.BASE_URL, "http://127.0.0.1:8080/v1");
  assert.equal(cfg.CONFIG_WARNINGS.length, 1);
  assert.match(cfg.CONFIG_WARNINGS[0], /PI_MLX_MODELS_PORT/);
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

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENV_PYTHON } from "./config.js";
import {
  createFlagProbe,
  parseHelpFlags,
  partitionFlags,
  probeEnv,
  runProbeCommand,
  skippedNotice,
  type ProbeResult,
} from "./flagprobe.js";

/**
 * Provenance of the three `--help` fixtures in test/fixtures (plan 02-07, decision 3).
 *
 * - mlx-server-help-0.32.2.txt is raw captured stdout of `python -m mlx_lm.server --help` from a venv holding
 *   mlx-lm 0.32.2 (Python 3.13), run as `env -u FORCE_COLOR NO_COLOR=1 PYTHONSAFEPATH=1 python -m mlx_lm.server
 *   --help 2>/dev/null` from a neutral directory. It is unedited. Its first line is mlx-lm's own deprecation
 *   notice, which that version prints to stdout as well as to stderr; the parser ignores it because it is not an
 *   option line.
 * - mlx-server-help-0.28.1.txt and mlx-server-help-0.24.0.txt are SYNTHETIC (research assumption A1: the help
 *   layout of older versions was not run locally). They are the real 0.32.2 text with the usage tokens and the
 *   option entries (option line plus wrapped description lines) of every flag newer than that version removed,
 *   according to the "Added in" column of docs/research/mlx-config-gap-analysis.md section 1.1: 0.24.0 keeps the
 *   nine flags marked "old" plus --help, 0.28.1 adds the flags that arrived in 0.28.0. The usage block was
 *   re-wrapped to the same 17-column continuation layout. A real older wheel may lay out its help differently.
 */

const fixture = (name: string): string => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
const HELP_0_32_2 = fixture("mlx-server-help-0.32.2.txt");
const HELP_0_28_1 = fixture("mlx-server-help-0.28.1.txt");
const HELP_0_24_0 = fixture("mlx-server-help-0.24.0.txt");

const FLAGS_0_24_0 = [
  "--help",
  "--model",
  "--adapter-path",
  "--host",
  "--port",
  "--draft-model",
  "--trust-remote-code",
  "--log-level",
  "--chat-template",
  "--use-default-chat-template",
];
const FLAGS_0_28_1 = [
  ...FLAGS_0_24_0,
  "--num-draft-tokens",
  "--temp",
  "--top-p",
  "--top-k",
  "--min-p",
  "--max-tokens",
  "--chat-template-args",
];
const FLAGS_0_32_2 = [
  "--help",
  "--model",
  "--adapter-path",
  "--host",
  "--port",
  "--allowed-origins",
  "--draft-model",
  "--num-draft-tokens",
  "--trust-remote-code",
  "--log-level",
  "--chat-template",
  "--use-default-chat-template",
  "--temp",
  "--top-p",
  "--top-k",
  "--min-p",
  "--max-tokens",
  "--chat-template-args",
  "--decode-concurrency",
  "--prompt-concurrency",
  "--prefill-step-size",
  "--prompt-cache-size",
  "--prompt-cache-bytes",
  "--kv-bits",
  "--kv-group-size",
  "--quantized-kv-start",
  "--pipeline",
];

const sorted = (flags: Iterable<string>) => [...flags].sort();

// ---- the help parser ----

test("the real 0.32.2 help parses to exactly the 27 flags", () => {
  const flags = parseHelpFlags(HELP_0_32_2);
  assert.equal(flags.size, 27);
  assert.deepEqual(sorted(flags), sorted(FLAGS_0_32_2));
});

test("the 0.28.1 fixture lacks everything added in 0.31.0, 0.31.2 and 0.32.0", () => {
  const flags = parseHelpFlags(HELP_0_28_1);
  assert.deepEqual(sorted(flags), sorted(FLAGS_0_28_1));
  for (const gone of [
    "--allowed-origins",
    "--decode-concurrency",
    "--prompt-concurrency",
    "--prefill-step-size",
    "--prompt-cache-size",
    "--prompt-cache-bytes",
    "--kv-bits",
    "--kv-group-size",
    "--quantized-kv-start",
    "--pipeline",
  ]) {
    assert.equal(flags.has(gone), false, gone);
  }
});

test("the 0.24.0 fixture additionally lacks the 0.28.0 flags", () => {
  const flags = parseHelpFlags(HELP_0_24_0);
  assert.deepEqual(sorted(flags), sorted(FLAGS_0_24_0));
  for (const gone of ["--num-draft-tokens", "--temp", "--top-p", "--top-k", "--min-p", "--max-tokens", "--chat-template-args"]) {
    assert.equal(flags.has(gone), false, gone);
  }
});

test("an ANSI-coloured copy of the 0.32.2 help parses to the same set", () => {
  const esc = String.fromCharCode(27);
  const coloured = HELP_0_32_2.replace(/(^|[^\w-])(-{1,2}[a-z][a-z0-9-]*)/g, `$1${esc}[1;36m$2${esc}[0m`)
    .replace(/^usage:/m, `${esc}[1;35musage:${esc}[0m`)
    .replace(/^options:/m, `${esc}[1;35moptions:${esc}[0m`);
  assert.ok(coloured.includes(`${esc}[1;36m--model${esc}[0m`), "the copy is really coloured");
  assert.deepEqual(sorted(parseHelpFlags(coloured)), sorted(FLAGS_0_32_2));
});

test("a flag mentioned in a description, in the usage block or after a double space is not collected", () => {
  const help = [
    "usage: server.py [-h] [--model MODEL] [--secret-usage-flag]",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --model MODEL         Like --prose-flag but for the model",
    "                        see also --description-flag and --other",
    "  --alpha ALPHA  --after-double-space",
    "  --beta",
    "                        Use instead of --gamma",
  ].join("\n");
  assert.deepEqual(sorted(parseHelpFlags(help)), ["--alpha", "--beta", "--help", "--model"]);
});

test("-h, --help yields --help only, and a short option is never collected", () => {
  const flags = parseHelpFlags("options:\n  -h, --help            show this help message and exit\n  -v VERSION  something\n");
  assert.deepEqual(sorted(flags), ["--help"]);
});

test("a flag that appears in the usage block but not in the options section is ignored", () => {
  const help = ["usage: server.py [--only-in-usage] [--model MODEL]", "", "options:", "  --model MODEL         The model"].join("\n");
  assert.deepEqual(sorted(parseHelpFlags(help)), ["--model"]);
});

test("Windows line endings and empty text are handled", () => {
  assert.deepEqual(sorted(parseHelpFlags(HELP_0_32_2.replace(/\n/g, "\r\n"))), sorted(FLAGS_0_32_2));
  assert.equal(parseHelpFlags("").size, 0);
  assert.equal(parseHelpFlags("error: nothing useful here\nTraceback (most recent call last):\n").size, 0);
});

// ---- the probe environment ----

test("probeEnv forces safe path and no colour, removes FORCE_COLOR and leaves the rest alone", () => {
  const base = { PATH: "/bin", HOME: "/home/x", FORCE_COLOR: "1", NO_COLOR: "", PYTHONSAFEPATH: "" } as NodeJS.ProcessEnv;
  const env = probeEnv(base);
  assert.equal(env.PYTHONSAFEPATH, "1");
  assert.equal(env.NO_COLOR, "1");
  assert.equal("FORCE_COLOR" in env, false);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/x");
  assert.equal(base.FORCE_COLOR, "1", "the base environment is not modified");
});

// ---- the probe: version, help, cache ----

const VERSION_ARGS = ["-c", "import importlib.metadata as m; print(m.version('mlx-lm'))"];
const HELP_ARGS = ["-m", "mlx_lm.server", "--help"];

type RunResult = { code: number | null; stdout: string; timedOut: boolean; truncated: boolean };
const done = (stdout: string, extra: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout, timedOut: false, truncated: false, ...extra });

interface Script {
  version?: RunResult | Error | (() => RunResult | Error);
  help?: RunResult | Error | (() => RunResult | Error);
}

/** A fake runner: answers the version command and the help command from the script and records every call. */
function fakeRun(script: Script) {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number }> = [];
  const run = async (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number }) => {
    calls.push({ command, args: [...args], env: options.env, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
    const entry = args[0] === "-c" ? script.version : script.help;
    const value = typeof entry === "function" ? entry() : entry;
    if (value === undefined) throw new Error(`unscripted command ${args.join(" ")}`);
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    run: run as typeof runProbeCommand,
    calls,
    count: (first: string) => calls.filter((c) => c.args[0] === first).length,
  };
}

const probeWith = (script: Script, env: NodeJS.ProcessEnv = { PATH: "/bin", FORCE_COLOR: "1" }) => {
  const fake = fakeRun(script);
  return { ...fake, probe: createFlagProbe({ python: "/venv/bin/python3", run: fake.run, env }) };
};

test("a probe of 0.32.2 reports the version and all 27 flags, with the documented commands and environment", async () => {
  const p = probeWith({ version: done("0.32.2\n"), help: done(HELP_0_32_2) });

  const result = await p.probe.probe();

  assert.ok(result.ok);
  assert.equal(result.version, "0.32.2");
  assert.deepEqual(sorted(result.flags), sorted(FLAGS_0_32_2));
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[0].command, "/venv/bin/python3");
  assert.deepEqual(p.calls[0].args, VERSION_ARGS);
  assert.equal(p.calls[1].command, "/venv/bin/python3");
  assert.deepEqual(p.calls[1].args, HELP_ARGS);
  for (const call of p.calls) {
    assert.equal(call.env.PYTHONSAFEPATH, "1");
    assert.equal(call.env.NO_COLOR, "1");
    assert.equal("FORCE_COLOR" in call.env, false);
    assert.equal(call.timeoutMs, 15_000);
    assert.equal(call.maxBytes, 262_144);
  }
});

test("the help command runs once per version: the second probe of the same version reads the cache", async () => {
  const p = probeWith({ version: done("0.32.2\n"), help: done(HELP_0_32_2) });

  const first = await p.probe.probe();
  const second = await p.probe.probe();

  assert.ok(first.ok && second.ok);
  assert.deepEqual(sorted(second.flags), sorted(first.flags));
  assert.equal(p.count("-c"), 2, "the cheap version query runs on every probe, so an upgrade is noticed");
  assert.equal(p.count("-m"), 1);
});

test("a different installed version runs the help command again", async () => {
  let version = "0.32.2\n";
  let help = HELP_0_32_2;
  const p = probeWith({ version: () => done(version), help: () => done(help) });

  const before = await p.probe.probe();
  version = "0.24.0\n";
  help = HELP_0_24_0;
  const after = await p.probe.probe();

  assert.ok(before.ok && after.ok);
  assert.equal(before.flags.size, 27);
  assert.equal(after.version, "0.24.0");
  assert.deepEqual(sorted(after.flags), sorted(FLAGS_0_24_0));
  assert.equal(p.count("-m"), 2);
});

test("probes that overlap share one help run", async () => {
  const p = probeWith({ version: done("0.32.2\n"), help: done(HELP_0_32_2) });

  const [a, b] = await Promise.all([p.probe.probe(), p.probe.probe()]);

  assert.ok(a.ok && b.ok);
  assert.equal(p.count("-m"), 1);
});

test("the cache lives in the probe instance: a new probe asks again", async () => {
  const fake = fakeRun({ version: done("0.32.2\n"), help: done(HELP_0_32_2) });
  await createFlagProbe({ python: "py", run: fake.run, env: {} }).probe();
  await createFlagProbe({ python: "py", run: fake.run, env: {} }).probe();
  assert.equal(fake.count("-m"), 2);
});

const FAILURES: Array<{ name: string; script: Script; reason: RegExp }> = [
  { name: "the runner cannot start python (ENOENT)", script: { version: new Error("spawn /venv/bin/python3 ENOENT") }, reason: /ENOENT/ },
  { name: "the version command exits non-zero", script: { version: done("", { code: 1 }) }, reason: /version/i },
  { name: "the version command times out", script: { version: done("", { code: null, timedOut: true }) }, reason: /timed out/i },
  { name: "the version text contains an escape character", script: { version: done("0.32.2\u001b[31m\n") }, reason: /version/i },
  { name: "the version text contains a space", script: { version: done("0.32 2\n") }, reason: /version/i },
  { name: "the version text is empty", script: { version: done("\n") }, reason: /version/i },
  { name: "the version text is longer than 32 characters", script: { version: done(`${"1".repeat(33)}\n`) }, reason: /version/i },
  { name: "the help command exits non-zero", script: { version: done("0.32.2\n"), help: done("", { code: 2 }) }, reason: /exit/i },
  { name: "the help command times out", script: { version: done("0.32.2\n"), help: done("", { code: null, timedOut: true }) }, reason: /timed out/i },
  { name: "the help output exceeds the cap", script: { version: done("0.32.2\n"), help: done("x", { truncated: true }) }, reason: /too (much|long|large)|limit|larger/i },
  { name: "the help command cannot be run", script: { version: done("0.32.2\n"), help: new Error("spawn failed") }, reason: /spawn failed/ },
  { name: "the help text has no recognizable flags", script: { version: done("0.32.2\n"), help: done("Traceback: boom\n") }, reason: /no (recognizable )?flags/i },
  {
    name: "the help text lacks --model",
    script: { version: done("0.32.2\n"), help: done("options:\n  -h, --help  help\n  --port PORT  port\n") },
    reason: /--model/,
  },
];

for (const failure of FAILURES) {
  test(`a probe fails without throwing when ${failure.name}`, async () => {
    const p = probeWith(failure.script);

    const result = await p.probe.probe();

    assert.equal(result.ok, false);
    assert.ok(!result.ok && failure.reason.test(result.reason), `reason was: ${!result.ok && result.reason}`);
  });
}

test("a failed probe is not cached: the next probe runs the help command again", async () => {
  let attempt = 0;
  const p = probeWith({
    version: done("0.32.2\n"),
    help: () => {
      attempt += 1;
      return attempt === 1 ? done("", { code: 1 }) : done(HELP_0_32_2);
    },
  });

  const first = await p.probe.probe();
  const second = await p.probe.probe();

  assert.equal(first.ok, false);
  assert.ok(second.ok);
  assert.equal(p.count("-m"), 2);
});

test("a failure reason is cleaned of control characters and clipped", async () => {
  const esc = String.fromCharCode(27);
  const p = probeWith({ version: new Error(`${esc}[31mspawn ${"y".repeat(2000)}\u0007 ENOENT`) });

  const result = await p.probe.probe();

  assert.ok(!result.ok);
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(result.reason), false);
  assert.ok(result.reason.length <= 300, `reason has ${result.reason.length} characters`);
});

// ---- partition and notice ----

const FLAG_LIST = [
  { flag: "--host", core: true },
  { flag: "--port", core: true },
  { flag: "--allowed-origins", core: false },
  { flag: "--log-level", core: false },
  { flag: "--num-draft-tokens", core: false },
];
const okProbe = (version: string, flags: string[]): ProbeResult => ({ ok: true, version, flags: new Set(flags) });

test("partitionFlags skips optional flags the install does not list, keeps their order, and never skips host or port", () => {
  const { passed, skipped } = partitionFlags(FLAG_LIST, okProbe("0.24.0", ["--model", "--log-level"]));

  assert.deepEqual(
    passed.map((f) => f.flag),
    ["--host", "--port", "--log-level"],
  );
  assert.deepEqual(
    skipped.map((f) => f.flag),
    ["--allowed-origins", "--num-draft-tokens"],
  );
});

test("partitionFlags passes everything when the install lists every flag", () => {
  const { passed, skipped } = partitionFlags(FLAG_LIST, okProbe("0.32.2", FLAGS_0_32_2));
  assert.equal(passed.length, FLAG_LIST.length);
  assert.deepEqual(skipped, []);
});

test("partitionFlags skips nothing when the probe failed (D-20)", () => {
  const { passed, skipped } = partitionFlags(FLAG_LIST, { ok: false, reason: "boom" });
  assert.equal(passed.length, FLAG_LIST.length);
  assert.deepEqual(skipped, []);
});

test("skippedNotice names every flag and the version, with the fix", () => {
  assert.equal(
    skippedNotice(["--allowed-origins", "--num-draft-tokens"], "0.24.0"),
    "Skipped --allowed-origins, --num-draft-tokens: not supported by mlx-lm 0.24.0 (run /mlx-init to upgrade)",
  );
  assert.equal(skippedNotice(["--kv-bits"], "0.31.3"), "Skipped --kv-bits: not supported by mlx-lm 0.31.3 (run /mlx-init to upgrade)");
});

// ---- the real runner ----

const NODE = process.execPath;
const limits = { env: { ...process.env }, timeoutMs: 10_000, maxBytes: 100_000 };

test("runProbeCommand collects stdout and the exit code", async () => {
  const result = await runProbeCommand(NODE, ["-e", "process.stdout.write('hello'); process.exit(3)"], limits);
  assert.deepEqual(result, { code: 3, stdout: "hello", timedOut: false, truncated: false });
});

test("runProbeCommand rejects when the command cannot be started", async () => {
  await assert.rejects(runProbeCommand("/no/such/binary-for-pi-mlx", [], limits), /ENOENT/);
});

test("runProbeCommand passes exactly the environment it is given", async () => {
  const result = await runProbeCommand(NODE, ["-e", "process.stdout.write(String(process.env.PROBE_TEST_VALUE))"], {
    ...limits,
    env: { ...process.env, PROBE_TEST_VALUE: "seen" },
  });
  assert.equal(result.stdout, "seen");
});

test("runProbeCommand stops a child that exceeds the timeout", async () => {
  const started = Date.now();
  const result = await runProbeCommand(NODE, ["-e", "setTimeout(() => {}, 20000)"], { ...limits, timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 8000, "the child was killed, not waited for");
});

test("runProbeCommand caps collected stdout at the byte limit and says so", async () => {
  const result = await runProbeCommand(NODE, ["-e", "process.stdout.write('x'.repeat(500000))"], { ...limits, maxBytes: 1000 });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 1000, `collected ${result.stdout.length} bytes`);
  assert.ok(result.stdout.length > 0);
});

test("runProbeCommand drains and discards a large stderr instead of hanging", async () => {
  const result = await runProbeCommand(NODE, ["-e", "process.stderr.write('e'.repeat(400000)); process.stdout.write('ok')"], limits);
  assert.equal(result.stdout, "ok");
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
});

// ---- the project directory is never searched for modules (T-02-23) ----

function python311(): string | null {
  const s = spawnSync("python3", ["--version"], { encoding: "utf8" });
  const m = s.status === 0 ? `${s.stdout}${s.stderr}`.match(/Python\s+3\.(\d+)/) : null;
  return m && Number(m[1]) >= 11 ? "python3" : null;
}
const PYTHON = python311();

test(
  "the probe environment does not let python run a module from the working directory",
  { skip: PYTHON ? false : "python3 3.11 or newer is not on PATH (PYTHONSAFEPATH needs 3.11)" },
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mlx-shadow-"));
    mkdirSync(join(cwd, "pi_mlx_shadow_probe"));
    writeFileSync(join(cwd, "pi_mlx_shadow_probe", "__init__.py"), "print('SHADOW-RAN')\n");
    const args = ["-m", "pi_mlx_shadow_probe"];

    // Control: without the safe-path variable the module in the working directory does run, so this test can fail.
    const unsafe = await runProbeCommand(PYTHON!, args, { env: { ...process.env, PYTHONSAFEPATH: "" }, timeoutMs: 15_000, maxBytes: 10_000, cwd });
    assert.match(unsafe.stdout, /SHADOW-RAN/, "control: the shadow module is importable from the working directory");

    const safe = await runProbeCommand(PYTHON!, args, { env: probeEnv(process.env), timeoutMs: 15_000, maxBytes: 10_000, cwd });
    assert.doesNotMatch(safe.stdout, /SHADOW-RAN/);
    assert.notEqual(safe.code, 0);
  },
);

// ---- the installed venv (local only) ----

test(
  "the default probe against the installed venv lists --model, --host and --port",
  { timeout: 60_000, skip: existsSync(VENV_PYTHON) ? false : `no venv at ${VENV_PYTHON} (run /mlx-init)` },
  async () => {
    const result = await createFlagProbe({ python: VENV_PYTHON }).probe();

    assert.ok(result.ok, `probe failed: ${!result.ok && result.reason}`);
    assert.match(result.version, /^\d/);
    for (const flag of ["--model", "--host", "--port"]) assert.ok(result.flags.has(flag), flag);
  },
);

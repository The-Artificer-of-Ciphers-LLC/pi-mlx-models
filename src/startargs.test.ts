import test from "node:test";
import assert from "node:assert/strict";
import { parseStartArgs, tokenizeStartArgs, type CliFlagSpec } from "./startargs.js";

/** A small table of the shape settings.ts derives from SETTINGS; the parser takes it as a parameter. */
const SPECS: CliFlagSpec[] = [
  { flag: "--port", path: "server.port", takesValue: true },
  { flag: "--host", path: "server.host", takesValue: true },
  { flag: "--trust-remote-code", path: "model.trustRemoteCode", takesValue: false },
];

const tokens = (raw: string) => {
  const result = tokenizeStartArgs(raw);
  assert.ok("tokens" in result, `expected tokens, got ${JSON.stringify(result)}`);
  return result.tokens;
};

const failure = (raw: string, specs: CliFlagSpec[] = SPECS): string => {
  const result = parseStartArgs(raw, specs);
  assert.equal(result.ok, false, `expected an error for ${JSON.stringify(raw)}, got ${JSON.stringify(result)}`);
  return result.ok ? "" : result.error;
};

test("tokenizeStartArgs splits on runs of whitespace", () => {
  assert.deepEqual(tokens("a b  c"), ["a", "b", "c"]);
  assert.deepEqual(tokens("  a   b  "), ["a", "b"]);
  assert.deepEqual(tokens(""), []);
  assert.deepEqual(tokens("   "), []);
});

test("tokenizeStartArgs treats tabs and newlines as separators", () => {
  assert.deepEqual(tokens("a\tb\nc\r\nd"), ["a", "b", "c", "d"]);
});

test("single quotes are literal and keep whitespace and double quotes", () => {
  assert.deepEqual(tokens("'x y' z"), ["x y", "z"]);
  assert.deepEqual(tokens(`'say "hi" \\n'`), [`say "hi" \\n`]);
});

test("double quotes honor only a backslash-quote and a backslash-backslash", () => {
  assert.deepEqual(tokens(`"x \\"y\\" \\\\z"`), [`x "y" \\z`]);
  // Any other backslash stays as written.
  assert.deepEqual(tokens(`"a\\nb"`), ["a\\nb"]);
});

test("there are no escapes outside quotes", () => {
  assert.deepEqual(tokens("a\\ b"), ["a\\", "b"]);
});

test("a quoted segment joins the text next to it into one token", () => {
  assert.deepEqual(tokens(`--chat-template-args='{"a":1}'`), [`--chat-template-args={"a":1}`]);
  assert.deepEqual(tokens(`pre'mid dle'post "x y"z`), ["premid dlepost", "x yz"]);
});

test("an empty quoted string is an empty token", () => {
  assert.deepEqual(tokens("''"), [""]);
  assert.deepEqual(tokens(`a "" b`), ["a", "", "b"]);
});

test("an unterminated quote is an error", () => {
  for (const raw of ["'abc", `"abc`, `a "b \\"`, "x 'y z"]) {
    const result = tokenizeStartArgs(raw);
    assert.deepEqual(result, { error: "unterminated quote in the /mlx-start arguments" }, raw);
  }
});

test("input longer than 8192 characters is refused and exactly 8192 is accepted", () => {
  assert.deepEqual(tokenizeStartArgs("a".repeat(8193)), { error: "the /mlx-start arguments are longer than 8192 characters" });
  assert.deepEqual(tokens("a".repeat(8192)), ["a".repeat(8192)]);
});

test("parseStartArgs reads a model and a valued flag", () => {
  assert.deepEqual(parseStartArgs("qwen3_4b --port 9000", SPECS), {
    ok: true,
    model: "qwen3_4b",
    flags: [{ flag: "--port", path: "server.port", raw: "9000" }],
  });
});

test("--flag=value and --flag value are the same, and the model may come before or after", () => {
  const expected = { ok: true, model: "qwen3_4b", flags: [{ flag: "--port", path: "server.port", raw: "9000" }] };
  assert.deepEqual(parseStartArgs("--port=9000 qwen3_4b", SPECS), expected);
  assert.deepEqual(parseStartArgs("--port 9000 qwen3_4b", SPECS), expected);
  assert.deepEqual(parseStartArgs("qwen3_4b --port=9000", SPECS), expected);
});

test("a flag that takes no value has the value true", () => {
  assert.deepEqual(parseStartArgs("--trust-remote-code", SPECS), {
    ok: true,
    flags: [{ flag: "--trust-remote-code", path: "model.trustRemoteCode", raw: true }],
  });
});

test("an empty argument string gives no model and no flags", () => {
  assert.deepEqual(parseStartArgs("", SPECS), { ok: true, flags: [] });
  assert.deepEqual(parseStartArgs("   \t ", SPECS), { ok: true, flags: [] });
});

test("flags keep the order in which they were typed", () => {
  const result = parseStartArgs("--host h --trust-remote-code --port 1", SPECS);
  assert.ok(result.ok);
  assert.deepEqual(
    result.flags.map((f) => f.flag),
    ["--host", "--trust-remote-code", "--port"],
  );
});

test("a value that starts with a single dash is taken as the value", () => {
  assert.deepEqual(parseStartArgs("--port -1", SPECS), {
    ok: true,
    flags: [{ flag: "--port", path: "server.port", raw: "-1" }],
  });
});

test("a following token that starts with two dashes is not a value", () => {
  assert.equal(failure("--port --host x"), "--port needs a value");
});

test("the explicit = form can carry a value that starts with two dashes", () => {
  assert.deepEqual(parseStartArgs("--port=--host", SPECS), {
    ok: true,
    flags: [{ flag: "--port", path: "server.port", raw: "--host" }],
  });
});

test("a quoted value may hold spaces and an empty value is passed on as an empty string", () => {
  assert.deepEqual(parseStartArgs(`--host 'a b' --port ''`, SPECS), {
    ok: true,
    flags: [
      { flag: "--host", path: "server.host", raw: "a b" },
      { flag: "--port", path: "server.port", raw: "" },
    ],
  });
  assert.deepEqual(parseStartArgs("--port=", SPECS), { ok: true, flags: [{ flag: "--port", path: "server.port", raw: "" }] });
});

test("an unknown flag is an error that lists the valid flags", () => {
  assert.equal(failure("--bogus"), "unknown flag --bogus (valid flags: --port, --host, --trust-remote-code)");
  assert.equal(failure("--bogus=1 qwen3_4b"), "unknown flag --bogus (valid flags: --port, --host, --trust-remote-code)");
});

test("names that exist on Object.prototype are unknown flags", () => {
  assert.match(failure("--constructor"), /^unknown flag --constructor /);
  assert.match(failure("--__proto__=1"), /^unknown flag --__proto__ /);
});

test("a bare -- is an unknown flag", () => {
  assert.match(failure("--"), /^unknown flag -- \(valid flags:/);
});

test("a pi flag spelling is not a /mlx-start flag", () => {
  assert.match(failure("--mlx-port 9"), /^unknown flag --mlx-port /);
});

test("a valued flag at the end of the line needs a value", () => {
  assert.equal(failure("qwen3_4b --port"), "--port needs a value");
});

test("a flag that takes no value refuses one", () => {
  assert.equal(failure("--trust-remote-code=yes"), "--trust-remote-code takes no value");
});

test("a repeated flag is an error, in either spelling", () => {
  assert.equal(failure("--port 1 --port 2"), "--port was given twice");
  assert.equal(failure("--port=1 --port 2"), "--port was given twice");
  assert.equal(failure("--trust-remote-code --trust-remote-code"), "--trust-remote-code was given twice");
});

test("a second positional is an error", () => {
  assert.equal(failure("a b"), "unexpected extra argument b (only one model is accepted)");
  assert.equal(failure("a --port 1 b"), "unexpected extra argument b (only one model is accepted)");
});

test("a positional that starts with a single dash is returned as the model unchanged", () => {
  assert.deepEqual(parseStartArgs("-x", SPECS), { ok: true, model: "-x", flags: [] });
});

test("tokenizer errors are the parse errors", () => {
  assert.equal(failure("--host 'oops"), "unterminated quote in the /mlx-start arguments");
  assert.equal(failure("a ".repeat(5000)), "the /mlx-start arguments are longer than 8192 characters");
});

test("echoed tokens contain no control characters and are clipped", () => {
  const nasty = failure("--bo\u001b[31mgus");
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(nasty), false, JSON.stringify(nasty));
  const long = failure(`--${"x".repeat(500)}`);
  assert.ok(long.length < 200, `message is ${long.length} characters`);
  const extra = failure(`a ${"y\u0007".repeat(200)}`);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(extra), false, JSON.stringify(extra));
  assert.ok(extra.length < 200, `message is ${extra.length} characters`);
});

test("a long run of quotes and backslashes is scanned in one pass", () => {
  const started = Date.now();
  const hostile = `"${"\\".repeat(4000)}`;
  assert.deepEqual(tokenizeStartArgs(hostile), { error: "unterminated quote in the /mlx-start arguments" });
  assert.ok(Date.now() - started < 1000);
});

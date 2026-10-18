import test from "node:test";
import assert from "node:assert/strict";
import { cleanLabel, clipDiagnostic, redactCredentials, redactIdCredentials } from "./diagnostic.js";

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

test("clipDiagnostic replaces C0, DEL and C1 control characters but keeps newline and tab", () => {
  const out = clipDiagnostic("a\u001b[31mred\u009b31m\tb\nc\u007fd\u0085e", 100);
  assert.doesNotMatch(out, CONTROL_CHARS);
  assert.ok(out.includes("\t") && out.includes("\n"));
  assert.match(out, /red/);
});

test("clipDiagnostic keeps the requested end when it clips", () => {
  assert.equal(clipDiagnostic("abcdef", 3, "start"), "abc");
  assert.equal(clipDiagnostic("abcdef", 3), "def");
});

test("cleanLabel collapses every control character, newline and tab included, to a space", () => {
  const out = cleanLabel("org/model\u001b]0;x\u0007\n\t\u009bname");
  assert.doesNotMatch(out, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(out, /^org\/model/);
  assert.match(out, /name$/);
});

test("cleanLabel leaves an ordinary model id untouched", () => {
  assert.equal(cleanLabel("mlx-community/Qwen3-4B-Instruct-2507-4bit"), "mlx-community/Qwen3-4B-Instruct-2507-4bit");
});

// ---- redactCredentials (plan 03-06, WR-01, D-18) ----

/** What `show` hands to the redaction: the value as JSON text, so a string starts with a double quote. */
const asJson = (text: string): string => JSON.stringify(text);

/** Input and expected output, in the spellings a pasted pip index can take. */
const REDACTED: Array<[string, string, string]> = [
  ["a plain user and password", "https://bob:s3cr3t@mirror.example/simple/", "https://***@mirror.example/simple/"],
  ["a password with a slash and a plus", "https://__token__:abc/def+ghi@mirror.example/simple/", "https://***@mirror.example/simple/"],
  ["a password with a question mark", "https://bob:pa?ss@mirror.example/simple/", "https://***@mirror.example/simple/"],
  ["a password with a hash", "https://bob:pa#ss@mirror.example/simple/", "https://***@mirror.example/simple/"],
  ["one slash after the scheme", "https:/bob:s3cr3t@mirror.example/simple/", "https:/***@mirror.example/simple/"],
  ["no slash after the scheme", "https:bob:s3cr3t@mirror.example/simple/", "https:***@mirror.example/simple/"],
  ["no scheme at all", "bob:s3cr3t@mirror.example/simple/", "***@mirror.example/simple/"],
  ["a space in the password", "https://bob:pa ss@mirror.example/simple/", "https://***@mirror.example/simple/"],
  ["an upper-case scheme", "HTTPS://bob:s3cr3t@mirror.example/", "HTTPS://***@mirror.example/"],
  ["backslashes instead of slashes", "https:\\\\bob:s3cr3t@mirror.example/", "https:\\\\***@mirror.example/"],
  ["an @ in the path: everything up to the last @ goes", "https://bob:s3cr3t@mirror.example/simple/@foo", "https://***@foo"],
];

for (const [name, input, expected] of REDACTED) {
  test(`redactCredentials hides the user and password: ${name}`, () => {
    assert.equal(redactCredentials(input), expected, "as plain text");
    assert.equal(redactCredentials(asJson(input)), asJson(expected), "as the JSON text that reaches show");
  });
}

const UNTOUCHED: Array<[string, string]> = [
  ["an index with no @", "https://mirror.example/simple/"],
  ["a query string and no @", "https://mirror.example/simple/?token=abc"],
  ["a model id", "mlx-community/Qwen3-4B"],
  ["a bare address", "127.0.0.1"],
  ["a JSON object whose @ is not in a URL", '{"a":"x@y"}'],
];

for (const [name, input] of UNTOUCHED) {
  test(`redactCredentials leaves ${name} alone`, () => {
    assert.equal(redactCredentials(input), input, "as plain text");
    assert.equal(redactCredentials(asJson(input)), asJson(input), "as JSON text");
  });
}

test("redactCredentials hides a URL embedded in JSON container text", () => {
  assert.equal(redactCredentials('{"url":"https://u:p@h"}'), '{"url":"https://***@h"}');
});

test("redactCredentials takes time proportional to the text: 300000 slashes return at once (T-03-23)", () => {
  for (const text of ["/".repeat(300000), '"' + "/".repeat(300000), "/".repeat(300000) + "@"]) {
    const started = Date.now();
    redactCredentials(text);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  }
});

test("redactCredentials takes time proportional to the text: a run of backslashes and of slashes inside JSON text return at once (T-03-23)", () => {
  const started = Date.now();
  redactCredentials('{"url":"' + "//".repeat(150000) + '"}');
  redactCredentials("\\".repeat(150000));
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

// ---- redactIdCredentials (06 review IN-01) ----

test("redactIdCredentials leaves a revision or a path that holds an @ alone", () => {
  for (const id of ["org/model@rev", "/Users/a@b/models/x", "a@b.com", "./models/x@1", "C:/Users/a@b/m"]) {
    assert.equal(redactIdCredentials(id), id, id);
    assert.equal(redactIdCredentials(asJson(id)), asJson(id), `${id} as JSON text`);
  }
});

test("redactIdCredentials leaves a drive path with backslashes alone (a backslash path shown as JSON text has doubled backslashes, which read as a UNC-style prefix and are not covered)", () => {
  assert.equal(redactIdCredentials("C:\\Users\\a@b\\m"), "C:\\Users\\a@b\\m");
});

test("redactIdCredentials still hides the user and password of an id written as a URL", () => {
  assert.equal(redactIdCredentials("https://bob:s3cr3t@host/org/model"), "https://***@host/org/model");
  assert.equal(redactIdCredentials("https://bob:pa/ss@host/org/model"), "https://***@host/org/model");
  assert.equal(redactIdCredentials(asJson("https://bob:s3cr3t@host/x")), asJson("https://***@host/x"));
  assert.equal(redactIdCredentials("hf://bob:s3cr3t@host/x"), "hf://***@host/x");
  assert.equal(redactIdCredentials("/models/https://u:p@h/x"), "/models/https://***@h/x");
});

test("redactIdCredentials takes time proportional to the text (T-03-23)", () => {
  const started = Date.now();
  for (const text of ["/".repeat(300000), "/".repeat(300000) + "@", "\\".repeat(150000), "a:" + "/".repeat(300000)]) redactIdCredentials(text);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

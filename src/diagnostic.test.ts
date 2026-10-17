import test from "node:test";
import assert from "node:assert/strict";
import { cleanLabel, clipDiagnostic } from "./diagnostic.js";

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

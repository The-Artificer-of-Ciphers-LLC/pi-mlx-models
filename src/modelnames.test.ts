import test from "node:test";
import assert from "node:assert/strict";
import { modelNames, numbered } from "./modelnames.js";

const LOOK_ALIKE = [`/Users/x/models/${"a".repeat(100)}-one`, `/Users/x/models/${"a".repeat(100)}-two`];

test("numbered: one line per name, counted from 1, so names that look alike stay different lines", () => {
  assert.deepEqual(numbered(["a", "b"]), ["1. a", "2. b"]);
  assert.deepEqual(numbered([]), []);
  const lines = numbered(LOOK_ALIKE);
  assert.notEqual(lines[0], lines[1]);
  assert.ok(lines[0].length < 120, "the name is clipped");
});

test("label: a unique key is named by its cleaned text, and nothing is added to it", () => {
  const names = modelNames(["org/a", "org/b"]);
  assert.equal(names.label("org/a"), "org/a");
  assert.equal(names.label("not/in/the/file"), "not/in/the/file");
  assert.equal(names.label("a\u001b[31mb"), names.label("a\u001b[31mb"));
  assert.doesNotMatch(names.label("a\u001b[31mb"), /\u001b/);
});

test("label: keys that show the same text get their place in the sorted list", () => {
  const names = modelNames(["ab\u0007c", "ab c", "other"]);
  const [first, second] = [names.label("ab\u0007c"), names.label("ab c")];
  assert.match(first, /\(entry [12] of 3\)$/);
  assert.match(second, /\(entry [12] of 3\)$/);
  assert.notEqual(first, second);
  assert.equal(names.label("other"), "other");

  const clipped = modelNames(LOOK_ALIKE);
  assert.match(clipped.label(LOOK_ALIKE[0]), /\(entry 1 of 2\)$/);
  assert.match(clipped.label(LOOK_ALIKE[1]), /\(entry 2 of 2\)$/);
});

test("label: a key that is not in the list yet is placed where the sorted list will put it once it is written", () => {
  const look = modelNames(["b\u0007", "d\u0007"]);
  // "b " shows the same text as "b\u0007" once cleaned; the control character sorts before a space, so the new key is entry 2 of 3.
  assert.equal(look.label("b "), "b (entry 2 of 3)");
  assert.equal(look.label("b\u0007"), "b");
  assert.equal(look.label("c"), "c");
});

test("place: the entry's number in the list and its text, and the text alone when the key is not in the list", () => {
  const names = modelNames(["org/a", "org/b", "org/c"]);
  assert.equal(names.place("org/b"), "2 of 3 (org/b)");
  assert.equal(names.place("org/gone"), "org/gone");
  const look = modelNames(LOOK_ALIKE);
  assert.notEqual(look.place(LOOK_ALIKE[0]), look.place(LOOK_ALIKE[1]));
  assert.match(look.place(LOOK_ALIKE[1]), /^2 of 2 \(/);
});

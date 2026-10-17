import test from "node:test";
import assert from "node:assert/strict";
import { createProgress, formatBar } from "./progress.js";

function setup() {
  const widgets: Array<string[] | undefined> = [];
  const statuses: Array<string | undefined> = [];
  const ui = {
    setWidget: (_id: string, lines: string[] | undefined) => void widgets.push(lines),
    setStatus: (_key: string, text: string | undefined) => void statuses.push(text),
  };
  const progress = createProgress(ui, { widgetId: "w", statusKey: "s", title: "T", steps: ["one", "two", "three"] });
  return { progress, widgets, statuses };
}

test("formatBar clamps and rounds", () => {
  assert.equal(formatBar(2, 4), "[████] 100%");
  assert.equal(formatBar(-1, 4), "[░░░░] 0%");
  assert.equal(formatBar(0.5, 4), "[██░░] 50%");
});

test("activating a step finishes earlier ones and shows only the current step", () => {
  const { progress, widgets } = setup();
  progress.activate(1, "working");
  assert.deepEqual(widgets.at(-1), ["T", "", "● two", "   working"]);
  progress.done(1, "ok");
  assert.deepEqual(widgets.at(-1), ["T", "", "✓ two", "   ok", "   [██████████████████] 100%"]);
});

test("a failed step wins the widget and shows its detail", () => {
  const { progress, widgets } = setup();
  progress.activate(2);
  progress.fail(2, "boom");
  assert.deepEqual(widgets.at(-1)?.slice(2), ["✗ three", "   boom"]);
});

test("status with progress renders a bar; clear removes the widget and stops the timer", () => {
  const { progress, widgets, statuses } = setup();
  progress.status("Downloading", { progress: 0.5 });
  assert.equal(statuses.at(-1), "[████████░░░░░░░░] 50% Downloading");
  progress.clear();
  assert.equal(widgets.at(-1), undefined);
});

test("status without progress renders a spinner", () => {
  const { progress, statuses } = setup();
  progress.status("Waiting");
  assert.match(statuses.at(-1)!, /^\[█░{15}\] Waiting$/);
  progress.stop();
});

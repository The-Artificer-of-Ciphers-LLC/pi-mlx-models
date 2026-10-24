import test from "node:test";
import assert from "node:assert/strict";
import { type ConfigMenuUi, createDialogs } from "./configdialogs.js";

type Notice = { message: string; type: string | undefined };

/** A scripted UI: each select answers from `answers` in turn; every title it was asked is recorded. */
function scripted(answers: Array<string | undefined | Error>): { ui: ConfigMenuUi; titles: string[]; notices: Notice[] } {
  const titles: string[] = [];
  const notices: Notice[] = [];
  const queue = [...answers];
  const ui: ConfigMenuUi = {
    async select(title) {
      titles.push(title);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    async input() {
      return "typed";
    },
    async confirm() {
      return true;
    },
    notify(message, type) {
      notices.push({ message, type });
    },
  };
  return { ui, titles, notices };
}

test("select, input and confirm: a dialog that throws or answers with the wrong type is a dismissal and a declined confirm", async () => {
  const broken = {
    select: async () => {
      throw new Error("boom");
    },
    input: async () => {
      throw new Error("boom");
    },
    confirm: async () => {
      throw new Error("boom");
    },
    notify: () => {
      throw new Error("boom");
    },
  } as unknown as ConfigMenuUi;
  const dialogs = createDialogs(broken);
  assert.equal(await dialogs.select("t", ["a"]), undefined);
  assert.equal(await dialogs.input("t"), undefined);
  assert.equal(await dialogs.confirm("t", "m"), false);
  assert.doesNotThrow(() => dialogs.notify("m"));
  assert.doesNotThrow(() => dialogs.report("m", "error"));

  const wrongTypes = { ...broken, select: async () => 7, input: async () => 7, confirm: async () => "yes" } as unknown as ConfigMenuUi;
  const typed = createDialogs(wrongTypes);
  assert.equal(await typed.select("t", ["a"]), undefined);
  assert.equal(await typed.input("t"), undefined);
  assert.equal(await typed.confirm("t", "m"), false);
});

test("pick: the index of the chosen option, undefined for a dismissal or an answer that is not an option", async () => {
  const { ui } = scripted(["b", "z", undefined]);
  const dialogs = createDialogs(ui);
  assert.equal(await dialogs.pick("t", ["a", "b"]), 1);
  assert.equal(await dialogs.pick("t", ["a", "b"]), undefined);
  assert.equal(await dialogs.pick("t", ["a", "b"]), undefined);
});

test("report: notifies as it is and puts a bounded copy above the title of the next answered menu, once", async () => {
  const { ui, titles, notices } = scripted(["a", "a"]);
  const dialogs = createDialogs(ui);
  dialogs.report("Saved x.", "info");
  assert.deepEqual(notices, [{ message: "Saved x.", type: "info" }]);
  await dialogs.pickWithResult("Menu", ["a"]);
  await dialogs.pickWithResult("Menu", ["a"]);
  assert.equal(titles[0], "Last result: Saved x.\n\nMenu");
  assert.equal(titles[1], "Menu");
});

test("pickWithResult: a menu that answers nothing gives the result back, unless a newer one was reported meanwhile", async () => {
  const { ui, titles } = scripted([undefined, "a", "a"]);
  const dialogs = createDialogs(ui);
  dialogs.report("First.");
  assert.equal(await dialogs.pickWithResult("Menu", ["a"]), undefined);
  assert.equal(await dialogs.pickWithResult("Menu", ["a"]), 0);
  assert.equal(titles[1], "Last result: First.\n\nMenu");

  // A result reported while a menu is open and then dismissed is not overwritten by the older copy.
  const racing = scripted([undefined, "a"]);
  const second = createDialogs({
    ...racing.ui,
    async select(title, options) {
      const answer = await racing.ui.select(title, options);
      if (answer === undefined) second.report("Newer.");
      return answer;
    },
  });
  second.report("Older.");
  await second.pickWithResult("Menu", ["a"]);
  await second.pickWithResult("Menu", ["a"]);
  assert.equal(racing.titles[1], "Last result: Newer.\n\nMenu");
});

test("pick does not use up the pending result", async () => {
  const { ui, titles } = scripted(["a", "a"]);
  const dialogs = createDialogs(ui);
  dialogs.report("Kept.");
  await dialogs.pick("Plain", ["a"]);
  await dialogs.pickWithResult("Menu", ["a"]);
  assert.equal(titles[0], "Plain");
  assert.equal(titles[1], "Last result: Kept.\n\nMenu");
});

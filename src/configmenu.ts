import {
  type ConfigScope,
  type ConfigTree,
  type EditOutcome,
  type Segments,
  confirmationFor,
  convertInput,
  createProfile,
  defaultProfileOf,
  deleteModelEntry,
  deleteProfile,
  editConfig,
  editableKeys,
  getAt,
  isPlausibleModelKey,
  modelEntrySummary,
  modelKeys,
  profileNames,
  renderConfig,
  segmentsFor,
  setAt,
  setDefaultProfile,
  unsetAt,
  validateModelKey,
  validateProfileName,
} from "./configedit.js";
import { type ConfigMenuUi, createDialogs, shown } from "./configdialogs.js";
import { type ModelNames, modelNames, numbered } from "./modelnames.js";
import { MODEL_PRESETS } from "./presets.js";
import { readLayerFile } from "./settings.js";

/**
 * The interactive menu of /mlx-config (CMD-02, D-17). It is a loop over `ctx.ui` on top of the pure editing core in
 * configedit.ts. It takes the UI object, the global config path and a flag for a running server as parameters, so it does
 * not know the extension and can be driven by a scripted UI over real files. Every action returns to the top menu.
 */

/** The entries of the top-level menu, in the order they are shown. */
export const MENU = {
  view: "View the current config",
  general: "Edit a general or server setting",
  modelBlock: "Edit options that apply to every model",
  modelEntry: "Edit options of one model",
  profiles: "Add, edit or delete a profile",
  defaultProfile: "Choose a model's default profile",
  deleteEntry: "Delete a model entry",
  done: "Done",
} as const;

/** The title of the top-level menu. */
export const MENU_TITLE = "MLX config";

/** What can be done with one key. */
export const ACTION = {
  set: "Set a value",
  remove: "Remove the key from the file",
  back: "Back",
} as const;

/** The list entry that adds a model entry by name. */
export const NEW_ENTRY = "New model entry...";
/** The list entry that adds a profile by name. */
export const NEW_PROFILE = "New profile...";
/** The list entry that clears a model's default profile. */
export const NO_DEFAULT = "(no default profile)";

/** What can be done with one profile. */
export const PROFILE_ACTION = {
  edit: "Edit a key of this profile",
  delete: "Delete this profile",
  back: "Back",
} as const;

export { CARRY_MAX_CHARS, CARRY_MAX_LINES, type ConfigMenuUi, carriedCopy } from "./configdialogs.js";

export interface ConfigMenuOptions {
  ui: ConfigMenuUi;
  /** Whether an interactive UI is attached; without one the menu only prints the config (D-23). */
  hasUI: boolean;
  /** The global config file, the only file the menu ever writes (D-18). */
  path: string;
  /** Whether a server of this session is running, so a saved notice can point to /mlx-restart (D-22). */
  serverRunning: boolean;
}

/** A bound on the rounds of the top menu, so a UI that always gives the same answer cannot keep the command running forever. */
const MAX_MENU_ROUNDS = 500;
/** A config value as a menu line shows it. */
function shownValue(value: unknown): string {
  if (value === undefined) return "(not set)";
  try {
    return shown(JSON.stringify(value) ?? String(value));
  } catch {
    return "(a value that cannot be shown)";
  }
}

/**
 * What a screen says when it is done: show it again (`stay`), go up one level (`up`), or end the menu because the file cannot
 * be used (`end`). Esc and Back mean `up`; an action that was saved, refused or declined means `stay`, so the user is still
 * where they were.
 */
type Step = "stay" | "up" | "end";

/** What a write came to: it changed the file, it changed nothing, it was refused, or the file cannot be used. */
type Written = "saved" | "unchanged" | "refused" | "end";

/** The step after a write: the user stays where they were; only a file that cannot be used ends the whole menu. */
const stepOf = (written: Written): Step => (written === "end" ? "end" : "stay");

/** What a parent screen does once a screen below it has gone up: show itself again, or end the menu with it. */
const below = (exit: "up" | "end"): Step => (exit === "end" ? "end" : "stay");

export async function runConfigMenu(options: ConfigMenuOptions): Promise<void> {
  const { path } = options;

  const dialogs = createDialogs(options.ui);
  const { report, pick, pickWithResult } = dialogs;

  /** The screens shown so far; the whole menu shows at most MAX_MENU_ROUNDS, so a UI that always gives the same answer ends it. */
  let screensShown = 0;

  /** Show a screen again for as long as it says `stay`; `up` and `end` are passed on to the screen above. */
  async function until(screen: () => Promise<Step>): Promise<"up" | "end"> {
    for (;;) {
      if (screensShown >= MAX_MENU_ROUNDS) return "end";
      screensShown += 1;
      namesSnapshot = undefined;
      const step = await screen();
      if (step !== "stay") return step;
    }
  }

  // Without an interactive UI nothing can be asked, so the menu only prints the config and says why it stops (D-23).
  if (!options.hasUI) {
    dialogs.notify(renderConfig(readLayerFile(path), path), "info");
    dialogs.notify("Editing the config needs an interactive pi session; this is a read-only view of the file.", "warning");
    return;
  }

  /** The file as data for showing current values; a file that cannot be used shows nothing, and the write reports it. */
  function currentTree(): ConfigTree {
    const file = readLayerFile(path);
    return file.state === "ok" ? file.data : {};
  }

  /**
   * Run an edit and tell the user what happened. `saved` and `unchanged` are the sentences for the two good outcomes; `after`
   * is an extra sentence at the end of the saved notice.
   */
  function write(change: (draft: ConfigTree) => ConfigTree, saved: string, unchanged: string, after = ""): Written {
    const outcome: EditOutcome = editConfig(path, change);
    namesSnapshot = undefined;
    if (!outcome.ok) {
      report(`Not saved: ${outcome.message}`, "error");
      return outcome.kind === "unreadable" ? "end" : "refused";
    }
    if (!outcome.changed) {
      report(`Nothing changed: ${unchanged}`, "info");
      return "unchanged";
    }
    const created = outcome.created ? ` The config file ${shown(path, 200)} was created.` : "";
    const running = options.serverRunning ? " A server is running: run /mlx-restart to apply it." : "";
    report(`${saved} The change takes effect on the next /mlx-start.${running}${created}${after}`, "info");
    return "saved";
  }

  /**
   * The keys of a scope with their values: choose one, then set it, change it or remove it. The list is shown again after
   * every outcome, so several keys can be changed in a row; Esc goes up. `suffix` says whose key it is, for notices.
   */
  async function keyListScreen(scope: ConfigScope, target: { model?: string; profile?: string }, title: string, suffix: string): Promise<Step> {
    const keys = editableKeys(scope);
    const tree = currentTree();
    const lines = keys.map((key) => `${key.label} = ${shownValue(getAt(tree, segmentsFor(scope, key.row, target)))}`);
    const chosen = await pickWithResult(title, lines);
    if (chosen === undefined) return "up";
    const key = keys[chosen];
    const segments: Segments = segmentsFor(scope, key.row, target);
    const current = getAt(tree, segments);
    const isSet = current !== undefined;
    const heading = `${key.label}: ${shown(key.row.expected, 200)}. Current value: ${shownValue(current)}.`;

    let value: unknown;
    let remove = false;
    if (key.row.kind === "bool") {
      const answers = ["true", "false", ...(isSet ? [ACTION.remove] : []), ACTION.back];
      const answer = await pick(heading, answers);
      if (answer === undefined || answers[answer] === ACTION.back) return "stay";
      if (answers[answer] === ACTION.remove) remove = true;
      else value = answers[answer] === "true";
    } else {
      const answers: string[] = [ACTION.set, ...(isSet ? [ACTION.remove] : []), ACTION.back];
      const answer = await pick(heading, answers);
      if (answer === undefined || answers[answer] === ACTION.back) return "stay";
      if (answers[answer] === ACTION.remove) {
        remove = true;
      } else {
        const typed = await dialogs.input(heading, isSet ? shownValue(current) : undefined);
        if (typed === undefined) return "stay";
        const converted = convertInput(key.row, typed);
        if (!converted.ok) {
          report(`Not saved: ${converted.message}.`, "error");
          return "stay";
        }
        value = converted.value;
      }
    }

    const name = `${key.label}${suffix}`;
    if (!remove) {
      const needed = confirmationFor(key.row, value);
      if (needed !== undefined && !(await dialogs.confirm(needed.title, needed.message))) {
        report(`Nothing was saved: ${name} was not confirmed.`, "info");
        return "stay";
      }
    }
    return stepOf(
      write(
        (draft) => (remove ? unsetAt(draft, segments) : setAt(draft, segments, value)),
        remove ? `Saved: ${name} was removed from the file.` : `Saved ${name}.`,
        remove ? `${name} was not in the file.` : `${name} already has that value.`,
      ),
    );
  }

  /**
   * The model list: choose a model key of the file by position, or with `allowNew` type a new one. Esc on the list is `up`;
   * a typed key that is dismissed, refused or not confirmed leaves the user on the list (`stay`).
   */
  async function chooseModel(title: string, allowNew: boolean): Promise<{ model: string } | { step: Step }> {
    const keys = modelKeys(currentTree());
    const chosen = await pickWithResult(title, [...numbered(keys), ...(allowNew ? [NEW_ENTRY] : [])]);
    if (chosen === undefined) return { step: "up" };
    if (chosen < keys.length) return { model: keys[chosen] };
    const presets = MODEL_PRESETS.map((preset) => preset.key).join(", ");
    const typed = await dialogs.input(`Model key: a preset key (${presets}) or a Hugging Face model id such as org/name`, "qwen3_4b");
    if (typed === undefined) return { step: "stay" };
    const checked = validateModelKey(typed);
    if (!checked.ok) {
      report(`Not added: ${checked.message}.`, "error");
      return { step: "stay" };
    }
    // Only a key that would create a new entry is asked about: a key already in the file adds nothing.
    if (!keys.includes(checked.value) && !isPlausibleModelKey(checked.value)) {
      // A number typed to /mlx-start is read as a preset number before any settings are matched, so a digit key can only be
      // reached through a model id that is a number by other means (such as defaultModel).
      const numberNote = /^\d+$/.test(checked.value) ? ` A number given to /mlx-start is read as a preset number, so a start does not use ${shown(checked.value)} as a model id.` : "";
      const confirmed = await dialogs.confirm(
        `Add ${shown(checked.value)} anyway?`,
        `${shown(checked.value)} is not a preset key (${presets}) and has no slash, as in org/name or in a path such as ./model. A start applies the settings stored under a key only when the preset key or the model id it starts is exactly this text, so settings stored under ${shown(checked.value)} are unlikely to be used unless you start a model by exactly this name.${numberNote} A common cause is typing a profile name where the model key belongs: choose the model first, then add the profile. Yes adds it anyway. No or Esc cancels.`,
      );
      if (!confirmed) {
        report(`Nothing was added: the model key ${shown(checked.value)} was not confirmed.`, "info");
        return { step: "stay" };
      }
    }
    return { model: checked.value };
  }

  /** The names of the model entries as the file lists them now: read once, and again after every screen and every write. */
  let namesSnapshot: ModelNames | undefined;
  const modelNamesNow = (): ModelNames => (namesSnapshot ??= modelNames(modelKeys(currentTree())));

  /** The words after a key name that say whose key it is. */
  const ofModel = (model: string): string => ` of model ${modelNamesNow().label(model)}`;
  const ofProfile = (model: string, profile: string): string => ` of profile ${shown(profile)}${ofModel(model)}`;
  const entryPlace = (model: string): string => modelNamesNow().place(model);

  /** The options of one model: pick the model, then edit its keys until Esc brings the user back to the model list. */
  async function modelEntryScreen(): Promise<Step> {
    const choice = await chooseModel("Choose the model whose options to edit", true);
    if (!("model" in choice)) return choice.step;
    const { model } = choice;
    return below(await until(() => keyListScreen("modelEntry", { model }, `Options${ofModel(model)}`, ofModel(model))));
  }

  /** Delete a profile after a confirmation; a default profile that named it is cleared in the same write. */
  async function deleteProfileFlow(model: string, profile: string): Promise<Step> {
    const clears = defaultProfileOf(currentTree(), model) === profile;
    const name = `profile ${shown(profile)} of model entry ${entryPlace(model)}`;
    const confirmed = await dialogs.confirm(
      `Delete ${name}?`,
      `This removes the profile and everything set in it from the config file.${clears ? " It is the default profile of this model, so the default is cleared too." : ""} Yes deletes it. No or Esc cancels.`,
    );
    if (!confirmed) {
      report(`Nothing was deleted: ${name} was not confirmed.`, "info");
      return "stay";
    }
    const written = write(
      (draft) => deleteProfile(draft, model, profile),
      `Deleted ${name}.${clears ? " It was the default profile, so defaultProfile was cleared too." : ""}`,
      `${name} was not in the file.`,
    );
    // The profile is gone either way, so its menu has nothing left to show: go up to the profile list. A refused write keeps it.
    return written === "refused" ? "stay" : written === "end" ? "end" : "up";
  }

  /** The profiles of one model: pick the model, then work on its profiles until Esc brings the user back to the model list. */
  async function profilesScreen(): Promise<Step> {
    const choice = await chooseModel("Choose the model whose profile to add, edit or delete", true);
    if (!("model" in choice)) return choice.step;
    const { model } = choice;
    return below(await until(() => profileListScreen(model)));
  }

  /** The profile list of one model: pick a profile or add one, then work on it until Esc brings the user back to the list. */
  async function profileListScreen(model: string): Promise<Step> {
    const names = profileNames(currentTree(), model);
    const chosen = await pickWithResult(`Profiles${ofModel(model)}`, [...numbered(names), NEW_PROFILE]);
    if (chosen === undefined) return "up";

    let profile: string;
    if (chosen < names.length) {
      profile = names[chosen];
    } else {
      const typed = await dialogs.input(`Name of the new profile${ofModel(model)} (letters, digits, dot, dash or underscore)`, "fast");
      if (typed === undefined) return "stay";
      const checked = validateProfileName(typed);
      if (!checked.ok) {
        report(`Not added: ${checked.message}.`, "error");
        return "stay";
      }
      profile = checked.value;
      if (names.includes(profile)) {
        report(`Profile ${shown(profile)}${ofModel(model)} already exists; its keys are edited and nothing is replaced.`, "info");
      } else {
        const created = write(
          (draft) => createProfile(draft, model, profile),
          `Created profile ${shown(profile)}${ofModel(model)}.`,
          `profile ${shown(profile)}${ofModel(model)} already exists.`,
          // The empty profile is written before the action menu opens, so Back leaves it in the file.
          " The profile is already saved and stays in the file if you choose Back.",
        );
        if (created !== "saved") return stepOf(created);
      }
    }
    return below(await until(() => profileScreen(model, profile)));
  }

  /** The menu of one profile: edit its keys, delete it, or go back to the profile list. */
  async function profileScreen(model: string, profile: string): Promise<Step> {
    const actions: string[] = [PROFILE_ACTION.edit, PROFILE_ACTION.delete, PROFILE_ACTION.back];
    const action = await pickWithResult(`Profile ${shown(profile)}${ofModel(model)}`, actions);
    if (action === undefined || actions[action] === PROFILE_ACTION.back) return "up";
    if (actions[action] === PROFILE_ACTION.edit) {
      const title = `Keys of profile ${shown(profile)}${ofModel(model)}`;
      return below(await until(() => keyListScreen("profile", { model, profile }, title, ofProfile(model, profile))));
    }
    return deleteProfileFlow(model, profile);
  }

  /** The default profile: pick the model, then its profile. The model list is shown again after each, so another model can follow. */
  async function defaultProfileScreen(): Promise<Step> {
    if (modelKeys(currentTree()).length === 0) {
      // A file that cannot be read has no models to list; say so the way a write would, and stop.
      if (readLayerFile(path).state === "unusable") return stepOf(write((draft) => draft, "", ""));
      report("The config file lists no models yet: add options or a profile for a model first.", "info");
      return "up";
    }
    const choice = await chooseModel("Choose the model whose default profile to set", false);
    if (!("model" in choice)) return choice.step;
    const { model } = choice;
    const tree = currentTree();
    const names = profileNames(tree, model);
    if (names.length === 0) {
      report(`Model ${shown(model)} has no profiles: add a profile first.`, "info");
      return "stay";
    }
    const current = defaultProfileOf(tree, model);
    const lines = numbered(names).map((line, index) => (names[index] === current ? `${line} (current default)` : line));
    const chosen = await pick(`Default profile${ofModel(model)}`, [...lines, NO_DEFAULT]);
    if (chosen === undefined) return "stay";
    if (chosen >= names.length) {
      return stepOf(
        write((draft) => setDefaultProfile(draft, model, undefined), `Saved: the default profile${ofModel(model)} was removed.`, `model ${shown(model)} has no default profile.`),
      );
    }
    const name = names[chosen];
    return stepOf(
      write(
        (draft) => setDefaultProfile(draft, model, name),
        `Saved: the default profile${ofModel(model)} is now ${shown(name)}.`,
        `the default profile${ofModel(model)} is already ${shown(name)}.`,
      ),
    );
  }

  /** The most profile names or option keys a delete confirm lists before it counts the rest. */
  const LISTED_MAX = 8;
  const listed = (names: string[]): string => {
    const first = names.slice(0, LISTED_MAX).map((name) => shown(name)).join(", ");
    return names.length > LISTED_MAX ? `${first} and ${names.length - LISTED_MAX} more` : first;
  };

  /** What deleting a model entry takes with it, as one sentence for the confirm; an entry that holds nothing says so. */
  function lostByEntry(model: string): string {
    const summary = modelEntrySummary(currentTree(), model);
    if (summary.notAnObject) return "The entry is not an object, so it holds no settings; it is removed as it is.";
    const parts: string[] = [];
    if (summary.profiles.length > 0) parts.push(`the ${summary.profiles.length === 1 ? "profile" : "profiles"} ${listed(summary.profiles)}`);
    if (summary.defaultProfile !== undefined) parts.push(`the defaultProfile ${shownValue(summary.defaultProfile)}`);
    if (summary.options.length > 0) parts.push(`the ${summary.options.length === 1 ? "option" : "options"} ${listed(summary.options)}`);
    if (parts.length === 0) return "The entry holds nothing, so no setting is lost.";
    return `This removes the model entry from the config file together with ${parts.join("; ")}.`;
  }

  /** Delete a whole model entry after a confirmation that names what is lost; nothing else in the file is touched. */
  async function deleteEntryFlow(): Promise<"up" | "end"> {
    let deleted = false;
    return until(async () => {
      if (modelKeys(currentTree()).length === 0) {
        // The last entry was just deleted: the result is already on screen, so there is nothing more to say.
        if (deleted) return "up";
        // A file that cannot be read has no entries to list; say so the way a write would, and stop.
        if (readLayerFile(path).state === "unusable") return stepOf(write((draft) => draft, "", ""));
        report("The config file lists no model entries: there is nothing to delete.", "info");
        return "up";
      }
      const choice = await chooseModel("Choose the model entry to delete", false);
      if (!("model" in choice)) return choice.step;
      const { model } = choice;
      const name = `model entry ${entryPlace(model)}`;
      const confirmed = await dialogs.confirm(
        `Delete ${name}?`,
        `${lostByEntry(model)} Other model entries and settings are not touched. Yes deletes it. No or Esc cancels.`,
      );
      if (!confirmed) {
        report(`Nothing was deleted: ${name} was not confirmed.`, "info");
        return "stay";
      }
      const written = write((draft) => deleteModelEntry(draft, model), `Deleted ${name}.`, `${name} was not in the file.`);
      if (written === "saved" || written === "unchanged") deleted = true;
      return stepOf(written);
    });
  }

  // The top menu is the first screen: Done or Esc leaves, and every other entry opens a screen that Esc comes back from.
  await until(async () => {
    const entries = [MENU.view, MENU.general, MENU.modelBlock, MENU.modelEntry, MENU.profiles, MENU.defaultProfile, MENU.deleteEntry, MENU.done];
    const chosen = await pickWithResult(MENU_TITLE, entries);
    if (chosen === undefined || entries[chosen] === MENU.done) return "up";
    switch (entries[chosen]) {
      case MENU.view:
        dialogs.notify(renderConfig(readLayerFile(path), path), "info");
        return "stay";
      case MENU.general:
        return below(await until(() => keyListScreen("global", {}, MENU.general, "")));
      case MENU.modelBlock:
        return below(await until(() => keyListScreen("modelBlock", {}, MENU.modelBlock, "")));
      case MENU.modelEntry:
        return below(await until(modelEntryScreen));
      case MENU.profiles:
        return below(await until(profilesScreen));
      case MENU.defaultProfile:
        return below(await until(defaultProfileScreen));
      case MENU.deleteEntry:
        return below(await deleteEntryFlow());
      default:
        return "stay";
    }
  });
}

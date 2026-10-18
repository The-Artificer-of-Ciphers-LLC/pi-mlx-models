import {
  type ConfigScope,
  type ConfigTree,
  type EditOutcome,
  type Segments,
  confirmationFor,
  convertInput,
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
  unsetAt,
  validateModelKey,
  validateProfileName,
} from "./configedit.js";
import { cleanLabel, clipDiagnostic, redactCredentials } from "./diagnostic.js";
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

/** The parts of pi's `ctx.ui` the menu uses, with pi's signatures. */
export interface ConfigMenuUi {
  select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

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
/** The longest name or value a notice or a menu line shows, in characters. */
const SHOWN_MAX = 80;

/** Text from the file or from the user as a notice or menu line shows it: cleaned, then credentials hidden, then clipped. */
const shown = (text: string, max = SHOWN_MAX): string => clipDiagnostic(redactCredentials(cleanLabel(text)), max, "start");

/** A config value as a menu line shows it. */
function shownValue(value: unknown): string {
  if (value === undefined) return "(not set)";
  try {
    return shown(JSON.stringify(value) ?? String(value));
  } catch {
    return "(a value that cannot be shown)";
  }
}

/** The most lines of a result the next menu title carries, so a long refusal cannot make the menu taller than the screen. */
export const CARRY_MAX_LINES = 6;
/** The most characters of a result the next menu title carries. */
export const CARRY_MAX_CHARS = 500;

/**
 * A notice as the title of the next menu carries it: the first lines, cut to a length, with "..." when anything was left
 * out. The message was built from `shown(...)` parts, so it is already cleaned and has credentials hidden; it is not
 * redacted again, because redaction works by position over a whole text. clipDiagnostic still replaces control characters.
 */
function carriedCopy(message: string): string {
  const lines = message.split("\n");
  const kept = lines.slice(0, CARRY_MAX_LINES).join("\n");
  const clipped = clipDiagnostic(kept, CARRY_MAX_CHARS, "start");
  const cut = lines.length > CARRY_MAX_LINES || kept.trim().length > CARRY_MAX_CHARS;
  return cut ? `${clipped}...` : clipped;
}

/** The result of one flow: go back to the top menu, or end the menu (the file cannot be used). */
type Flow = "menu" | "end";

/** What a write came to: it changed the file, it changed nothing, it was refused, or the file cannot be used. */
type Written = "saved" | "unchanged" | "refused" | "end";

/** A write whose outcome ends the flow: only a file that cannot be used ends the whole menu. */
const flowOf = (written: Written): Flow => (written === "end" ? "end" : "menu");

export async function runConfigMenu(options: ConfigMenuOptions): Promise<void> {
  const { path } = options;

  // Every ui call is guarded: a dialog that throws is a dismissal (and a declined confirm), the same fail-closed stance as
  // the trust dialogs (Phase 2 D-13). A notify that throws must never stop the menu.
  const dialogs = {
    async select(title: string, choices: string[]): Promise<string | undefined> {
      try {
        const answer = await options.ui.select(title, choices);
        return typeof answer === "string" ? answer : undefined;
      } catch {
        return undefined;
      }
    },
    async input(title: string, placeholder?: string): Promise<string | undefined> {
      try {
        const answer = await options.ui.input(title, placeholder);
        return typeof answer === "string" ? answer : undefined;
      } catch {
        return undefined;
      }
    },
    async confirm(title: string, message: string): Promise<boolean> {
      try {
        return (await options.ui.confirm(title, message)) === true;
      } catch {
        return false;
      }
    },
    notify(message: string, type: "info" | "warning" | "error" = "info"): void {
      try {
        options.ui.notify(message, type);
      } catch {
        // A notice that cannot be shown does not change what was or was not saved.
      }
    },
  };

  // Without an interactive UI nothing can be asked, so the menu only prints the config and says why it stops (D-23).
  if (!options.hasUI) {
    dialogs.notify(renderConfig(readLayerFile(path), path), "info");
    dialogs.notify("Editing the config needs an interactive pi session; this is a read-only view of the file.", "warning");
    return;
  }

  /** The last result of an action, waiting for the title of the next menu; used up by a menu that is answered. */
  let pendingResult: string | undefined;

  /** Tell the user what happened: notify with the message as it is, and remember a bounded copy for the next menu title. */
  function report(message: string, type: "info" | "warning" | "error" = "info"): void {
    dialogs.notify(message, type);
    pendingResult = carriedCopy(message);
  }

  /** The title with the last result above it, once; the result is cleared. Without a result the title is unchanged. */
  function titled(title: string): string {
    if (pendingResult === undefined) return title;
    const carried = pendingResult;
    pendingResult = undefined;
    return `Last result: ${carried}\n\n${title}`;
  }

  /** The index of the chosen option, or undefined for a dismissal or an answer that is not one of the options. */
  async function pick(title: string, choices: string[]): Promise<number | undefined> {
    const answer = await dialogs.select(title, choices);
    if (answer === undefined) return undefined;
    const index = choices.indexOf(answer);
    return index < 0 ? undefined : index;
  }

  /**
   * `pick` with the pending result above the title. An answered menu uses the result up, so it is shown once per answered
   * menu. A menu that answers nothing (dismissed, or a dialog that threw: `dialogs.select` cannot tell the two apart) may
   * never have been seen, so the result is put back for the next menu, unless `report` stored a newer one meanwhile (WR-03).
   */
  async function pickWithResult(title: string, choices: string[]): Promise<number | undefined> {
    const carried = pendingResult;
    const chosen = await pick(titled(title), choices);
    if (chosen === undefined && pendingResult === undefined) pendingResult = carried;
    return chosen;
  }

  /** The file as data for showing current values; a file that cannot be used shows nothing, and the write reports it. */
  function currentTree(): ConfigTree {
    const file = readLayerFile(path);
    return file.state === "ok" ? file.data : {};
  }

  /** Run an edit and tell the user what happened. `saved` and `unchanged` are the sentences for the two good outcomes. */
  function write(change: (draft: ConfigTree) => ConfigTree, saved: string, unchanged: string): Written {
    const outcome: EditOutcome = editConfig(path, change);
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
    report(`${saved} The change takes effect on the next /mlx-start.${running}${created}`, "info");
    return "saved";
  }

  /** Choose one key of a scope, then set it, change it or remove it. `suffix` says whose key it is, for notices. */
  async function editKey(scope: ConfigScope, target: { model?: string; profile?: string }, title: string, suffix: string): Promise<Flow> {
    const keys = editableKeys(scope);
    const tree = currentTree();
    const lines = keys.map((key) => `${key.label} = ${shownValue(getAt(tree, segmentsFor(scope, key.row, target)))}`);
    const chosen = await pick(title, lines);
    if (chosen === undefined) return "menu";
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
      if (answer === undefined || answers[answer] === ACTION.back) return "menu";
      if (answers[answer] === ACTION.remove) remove = true;
      else value = answers[answer] === "true";
    } else {
      const answers: string[] = [ACTION.set, ...(isSet ? [ACTION.remove] : []), ACTION.back];
      const answer = await pick(heading, answers);
      if (answer === undefined || answers[answer] === ACTION.back) return "menu";
      if (answers[answer] === ACTION.remove) {
        remove = true;
      } else {
        const typed = await dialogs.input(heading, isSet ? shownValue(current) : undefined);
        if (typed === undefined) return "menu";
        const converted = convertInput(key.row, typed);
        if (!converted.ok) {
          report(`Not saved: ${converted.message}.`, "error");
          return "menu";
        }
        value = converted.value;
      }
    }

    const name = `${key.label}${suffix}`;
    if (!remove) {
      const needed = confirmationFor(key.row, value);
      if (needed !== undefined && !(await dialogs.confirm(needed.title, needed.message))) {
        report(`Nothing was saved: ${name} was not confirmed.`, "info");
        return "menu";
      }
    }
    return flowOf(
      write(
        (draft) => (remove ? unsetAt(draft, segments) : setAt(draft, segments, value)),
        remove ? `Saved: ${name} was removed from the file.` : `Saved ${name}.`,
        remove ? `${name} was not in the file.` : `${name} already has that value.`,
      ),
    );
  }

  /** One menu line per name, numbered so two names that look alike once cleaned stay different lines. */
  const numbered = (names: string[]): string[] => names.map((name, index) => `${index + 1}. ${shown(name)}`);

  /** Choose a model key of the file by position, or with `allowNew` type a new one. Undefined when dismissed or refused. */
  async function chooseModel(title: string, allowNew: boolean): Promise<string | undefined> {
    const keys = modelKeys(currentTree());
    const chosen = await pick(title, [...numbered(keys), ...(allowNew ? [NEW_ENTRY] : [])]);
    if (chosen === undefined) return undefined;
    if (chosen < keys.length) return keys[chosen];
    const presets = MODEL_PRESETS.map((preset) => preset.key).join(", ");
    const typed = await dialogs.input(`Model key: a preset key (${presets}) or a Hugging Face model id such as org/name`, "qwen3_4b");
    if (typed === undefined) return undefined;
    const checked = validateModelKey(typed);
    if (!checked.ok) {
      report(`Not added: ${checked.message}.`, "error");
      return undefined;
    }
    // Only a key that would create a new entry is asked about: a key already in the file adds nothing.
    if (!keys.includes(checked.value) && !isPlausibleModelKey(checked.value)) {
      const confirmed = await dialogs.confirm(
        `Add ${shown(checked.value)} anyway?`,
        `${shown(checked.value)} is not a preset key (${presets}) and has no slash, as in org/name or in a path such as ./model. A start applies the settings stored under a key only when the preset key or the model id it starts is exactly this text, so settings stored under ${shown(checked.value)} are unlikely to be used unless you start a model by exactly this name. A common cause is typing a profile name where the model key belongs: choose the model first, then add the profile. Yes adds it anyway. No or Esc cancels.`,
      );
      if (!confirmed) {
        report(`Nothing was added: the model key ${shown(checked.value)} was not confirmed.`, "info");
        return undefined;
      }
    }
    return checked.value;
  }

  /**
   * A model as a notice or title names it: the cleaned, clipped key, and "(entry N of M)" after it only when another key of
   * the file shows the same text, so nothing changes for a key that is unique (WR-02c). A key not in the file yet is placed
   * where the sorted list will put it once it is written.
   */
  function modelLabel(model: string): string {
    const text = shown(model);
    const keys = modelKeys(currentTree());
    if (!keys.some((other) => other !== model && shown(other) === text)) return text;
    const all = keys.includes(model) ? keys : [...keys, model].sort();
    return `${text} (entry ${all.indexOf(model) + 1} of ${all.length})`;
  }

  /** The words after a key name that say whose key it is. */
  const ofModel = (model: string): string => ` of model ${modelLabel(model)}`;
  const ofProfile = (model: string, profile: string): string => ` of profile ${shown(profile)}${ofModel(model)}`;

  /**
   * A model entry as the menu numbers it, "3 of 5 (key)", for the questions that cannot be undone: two keys that look alike
   * once cleaned and clipped give the same `shown` text, but never the same place (WR-02, WR-02b). A key that is no longer
   * in the file has no place and is named by its text.
   */
  function entryPlace(model: string): string {
    const keys = modelKeys(currentTree());
    const index = keys.indexOf(model);
    return index < 0 ? shown(model) : `${index + 1} of ${keys.length} (${shown(model)})`;
  }

  async function modelEntryFlow(): Promise<Flow> {
    const model = await chooseModel("Choose the model whose options to edit", true);
    if (model === undefined) return "menu";
    return editKey("modelEntry", { model }, `Options${ofModel(model)}`, ofModel(model));
  }

  /** Delete a profile after a confirmation; a default profile that named it is cleared in the same write. */
  async function deleteProfile(model: string, profile: string): Promise<Flow> {
    const defaultPath = ["models", model, "defaultProfile"];
    const clears = getAt(currentTree(), defaultPath) === profile;
    const name = `profile ${shown(profile)} of model entry ${entryPlace(model)}`;
    const confirmed = await dialogs.confirm(
      `Delete ${name}?`,
      `This removes the profile and everything set in it from the config file.${clears ? " It is the default profile of this model, so the default is cleared too." : ""} Yes deletes it. No or Esc cancels.`,
    );
    if (!confirmed) {
      report(`Nothing was deleted: ${name} was not confirmed.`, "info");
      return "menu";
    }
    return flowOf(
      write(
        (draft) => {
          const without = unsetAt(draft, ["models", model, "profiles", profile]);
          return getAt(without, defaultPath) === profile ? unsetAt(without, defaultPath) : without;
        },
        `Deleted ${name}.${clears ? " It was the default profile, so defaultProfile was cleared too." : ""}`,
        `${name} was not in the file.`,
      ),
    );
  }

  async function profilesFlow(): Promise<Flow> {
    const model = await chooseModel("Choose the model whose profile to add, edit or delete", true);
    if (model === undefined) return "menu";
    const names = profileNames(currentTree(), model);
    const chosen = await pick(`Profiles${ofModel(model)}`, [...numbered(names), NEW_PROFILE]);
    if (chosen === undefined) return "menu";

    let profile: string;
    if (chosen < names.length) {
      profile = names[chosen];
    } else {
      const typed = await dialogs.input(`Name of the new profile${ofModel(model)} (letters, digits, dot, dash or underscore)`, "fast");
      if (typed === undefined) return "menu";
      const checked = validateProfileName(typed);
      if (!checked.ok) {
        report(`Not added: ${checked.message}.`, "error");
        return "menu";
      }
      profile = checked.value;
      if (names.includes(profile)) {
        report(`Profile ${shown(profile)}${ofModel(model)} already exists; its keys are edited and nothing is replaced.`, "info");
      } else {
        const created = write(
          (draft) => setAt(draft, ["models", model, "profiles", profile], {}),
          `Created profile ${shown(profile)}${ofModel(model)}.`,
          `profile ${shown(profile)}${ofModel(model)} already exists.`,
        );
        if (created !== "saved") return flowOf(created);
      }
    }

    const actions: string[] = [PROFILE_ACTION.edit, PROFILE_ACTION.delete, PROFILE_ACTION.back];
    const action = await pickWithResult(`Profile ${shown(profile)}${ofModel(model)}`, actions);
    if (action === undefined) return "menu";
    if (actions[action] === PROFILE_ACTION.edit) {
      return editKey("profile", { model, profile }, `Keys of profile ${shown(profile)}${ofModel(model)}`, ofProfile(model, profile));
    }
    if (actions[action] === PROFILE_ACTION.delete) return deleteProfile(model, profile);
    return "menu";
  }

  async function defaultProfileFlow(): Promise<Flow> {
    if (modelKeys(currentTree()).length === 0) {
      // A file that cannot be read has no models to list; say so the way a write would, and stop.
      if (readLayerFile(path).state === "unusable") return flowOf(write((draft) => draft, "", ""));
      report("The config file lists no models yet: add options or a profile for a model first.", "info");
      return "menu";
    }
    const model = await chooseModel("Choose the model whose default profile to set", false);
    if (model === undefined) return "menu";
    const tree = currentTree();
    const names = profileNames(tree, model);
    if (names.length === 0) {
      report(`Model ${shown(model)} has no profiles: add a profile first.`, "info");
      return "menu";
    }
    const current = getAt(tree, ["models", model, "defaultProfile"]);
    const lines = numbered(names).map((line, index) => (names[index] === current ? `${line} (current default)` : line));
    const chosen = await pick(`Default profile${ofModel(model)}`, [...lines, NO_DEFAULT]);
    if (chosen === undefined) return "menu";
    const defaultPath = ["models", model, "defaultProfile"];
    if (chosen >= names.length) {
      return flowOf(
        write((draft) => unsetAt(draft, defaultPath), `Saved: the default profile${ofModel(model)} was removed.`, `model ${shown(model)} has no default profile.`),
      );
    }
    const name = names[chosen];
    return flowOf(
      write(
        (draft) => setAt(draft, defaultPath, name),
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
  async function deleteEntryFlow(): Promise<Flow> {
    if (modelKeys(currentTree()).length === 0) {
      // A file that cannot be read has no entries to list; say so the way a write would, and stop.
      if (readLayerFile(path).state === "unusable") return flowOf(write((draft) => draft, "", ""));
      report("The config file lists no model entries: there is nothing to delete.", "info");
      return "menu";
    }
    const model = await chooseModel("Choose the model entry to delete", false);
    if (model === undefined) return "menu";
    const name = `model entry ${entryPlace(model)}`;
    const confirmed = await dialogs.confirm(
      `Delete ${name}?`,
      `${lostByEntry(model)} Other model entries and settings are not touched. Yes deletes it. No or Esc cancels.`,
    );
    if (!confirmed) {
      report(`Nothing was deleted: ${name} was not confirmed.`, "info");
      return "menu";
    }
    return flowOf(write((draft) => unsetAt(draft, ["models", model]), `Deleted ${name}.`, `${name} was not in the file.`));
  }

  for (let round = 0; round < MAX_MENU_ROUNDS; round += 1) {
    const entries = [MENU.view, MENU.general, MENU.modelBlock, MENU.modelEntry, MENU.profiles, MENU.defaultProfile, MENU.deleteEntry, MENU.done];
    const chosen = await pickWithResult(MENU_TITLE, entries);
    if (chosen === undefined || entries[chosen] === MENU.done) return;
    let flow: Flow = "menu";
    switch (entries[chosen]) {
      case MENU.view:
        dialogs.notify(renderConfig(readLayerFile(path), path), "info");
        break;
      case MENU.general:
        flow = await editKey("global", {}, MENU.general, "");
        break;
      case MENU.modelBlock:
        flow = await editKey("modelBlock", {}, MENU.modelBlock, "");
        break;
      case MENU.modelEntry:
        flow = await modelEntryFlow();
        break;
      case MENU.profiles:
        flow = await profilesFlow();
        break;
      case MENU.defaultProfile:
        flow = await defaultProfileFlow();
        break;
      case MENU.deleteEntry:
        flow = await deleteEntryFlow();
        break;
      default:
        break;
    }
    if (flow === "end") return;
  }
}

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
  done: "Done",
} as const;

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

  /** The index of the chosen option, or undefined for a dismissal or an answer that is not one of the options. */
  async function pick(title: string, choices: string[]): Promise<number | undefined> {
    const answer = await dialogs.select(title, choices);
    if (answer === undefined) return undefined;
    const index = choices.indexOf(answer);
    return index < 0 ? undefined : index;
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
      dialogs.notify(`Not saved: ${outcome.message}`, "error");
      return outcome.kind === "unreadable" ? "end" : "refused";
    }
    if (!outcome.changed) {
      dialogs.notify(`Nothing changed: ${unchanged}`, "info");
      return "unchanged";
    }
    const created = outcome.created ? ` The config file ${shown(path, 200)} was created.` : "";
    const running = options.serverRunning ? " A server is running: run /mlx-restart to apply it." : "";
    dialogs.notify(`${saved} The change takes effect on the next /mlx-start.${running}${created}`, "info");
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
          dialogs.notify(`Not saved: ${converted.message}.`, "error");
          return "menu";
        }
        value = converted.value;
      }
    }

    const name = `${key.label}${suffix}`;
    if (!remove) {
      const needed = confirmationFor(key.row, value);
      if (needed !== undefined && !(await dialogs.confirm(needed.title, needed.message))) {
        dialogs.notify(`Nothing was saved: ${name} was not confirmed.`, "info");
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
      dialogs.notify(`Not added: ${checked.message}.`, "error");
      return undefined;
    }
    // Only a key that would create a new entry is asked about: a key already in the file adds nothing.
    if (!keys.includes(checked.value) && !isPlausibleModelKey(checked.value)) {
      const confirmed = await dialogs.confirm(
        `Add ${shown(checked.value)} anyway?`,
        `${shown(checked.value)} is not a preset key (${presets}), has no slash like org/name and is not a local path, so no start will use settings stored under it. A common cause is typing a profile name where the model key belongs: choose the model first, then add the profile. Yes adds it anyway. No or Esc cancels.`,
      );
      if (!confirmed) {
        dialogs.notify(`Nothing was added: the model key ${shown(checked.value)} was not confirmed.`, "info");
        return undefined;
      }
    }
    return checked.value;
  }

  /** The words after a key name that say whose key it is. */
  const ofModel = (model: string): string => ` of model ${shown(model)}`;
  const ofProfile = (model: string, profile: string): string => ` of profile ${shown(profile)}${ofModel(model)}`;

  async function modelEntryFlow(): Promise<Flow> {
    const model = await chooseModel("Choose the model whose options to edit", true);
    if (model === undefined) return "menu";
    return editKey("modelEntry", { model }, `Options${ofModel(model)}`, ofModel(model));
  }

  /** Delete a profile after a confirmation; a default profile that named it is cleared in the same write. */
  async function deleteProfile(model: string, profile: string): Promise<Flow> {
    const defaultPath = ["models", model, "defaultProfile"];
    const clears = getAt(currentTree(), defaultPath) === profile;
    const name = `profile ${shown(profile)}${ofModel(model)}`;
    const confirmed = await dialogs.confirm(
      `Delete ${name}?`,
      `This removes the profile and everything set in it from the config file.${clears ? " It is the default profile of this model, so the default is cleared too." : ""} Yes deletes it. No or Esc cancels.`,
    );
    if (!confirmed) {
      dialogs.notify(`Nothing was deleted: ${name} was not confirmed.`, "info");
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
        dialogs.notify(`Not added: ${checked.message}.`, "error");
        return "menu";
      }
      profile = checked.value;
      if (names.includes(profile)) {
        dialogs.notify(`Profile ${shown(profile)}${ofModel(model)} already exists; its keys are edited and nothing is replaced.`, "info");
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
    const action = await pick(`Profile ${shown(profile)}${ofModel(model)}`, actions);
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
      dialogs.notify("The config file lists no models yet: add options or a profile for a model first.", "info");
      return "menu";
    }
    const model = await chooseModel("Choose the model whose default profile to set", false);
    if (model === undefined) return "menu";
    const tree = currentTree();
    const names = profileNames(tree, model);
    if (names.length === 0) {
      dialogs.notify(`Model ${shown(model)} has no profiles: add a profile first.`, "info");
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

  for (let round = 0; round < MAX_MENU_ROUNDS; round += 1) {
    const entries = [MENU.view, MENU.general, MENU.modelBlock, MENU.modelEntry, MENU.profiles, MENU.defaultProfile, MENU.done];
    const chosen = await pick("MLX config", entries);
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
      default:
        break;
    }
    if (flow === "end") return;
  }
}

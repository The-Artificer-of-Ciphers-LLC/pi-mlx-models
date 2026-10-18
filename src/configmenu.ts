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
  renderConfig,
  segmentsFor,
  setAt,
  unsetAt,
} from "./configedit.js";
import { cleanLabel, clipDiagnostic, redactCredentials } from "./diagnostic.js";
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

  /** Run an edit and tell the user what happened. `saved` says what was saved, as a sentence. */
  function write(change: (draft: ConfigTree) => ConfigTree, saved: string, unchanged: string): Flow {
    const outcome: EditOutcome = editConfig(path, change);
    if (!outcome.ok) {
      dialogs.notify(`Not saved: ${outcome.message}`, "error");
      return outcome.kind === "unreadable" ? "end" : "menu";
    }
    if (!outcome.changed) {
      dialogs.notify(`Nothing changed: ${unchanged}`, "info");
      return "menu";
    }
    const created = outcome.created ? ` The config file ${shown(path, 200)} was created.` : "";
    const running = options.serverRunning ? " A server is running: run /mlx-restart to apply it." : "";
    dialogs.notify(`${saved} The change takes effect on the next /mlx-start.${running}${created}`, "info");
    return "menu";
  }

  /** Choose one key of a scope, then set it, change it or remove it. `where` says whose key it is, for notices. */
  async function editKey(scope: ConfigScope, target: { model?: string; profile?: string }, title: string, where: string): Promise<Flow> {
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

    const name = `${where}${key.label}`;
    if (!remove) {
      const needed = confirmationFor(key.row, value);
      if (needed !== undefined && !(await dialogs.confirm(needed.title, needed.message))) {
        dialogs.notify(`Nothing was saved: ${name} was not confirmed.`, "info");
        return "menu";
      }
    }
    return write(
      (draft) => (remove ? unsetAt(draft, segments) : setAt(draft, segments, value)),
      remove ? `Saved: ${name} was removed from the file.` : `Saved ${name}.`,
      remove ? `${name} was not in the file.` : `${name} already has that value.`,
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
      default:
        break;
    }
    if (flow === "end") return;
  }
}

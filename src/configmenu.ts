/**
 * The interactive menu of /mlx-config (CMD-02, D-17). It is a loop over `ctx.ui` on top of the pure editing core in
 * configedit.ts. It takes the UI object, the global config path and a flag for a running server as parameters, so it does
 * not know the extension and can be driven by a scripted UI over real files.
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

export async function runConfigMenu(_options: ConfigMenuOptions): Promise<void> {
  throw new Error("not implemented");
}

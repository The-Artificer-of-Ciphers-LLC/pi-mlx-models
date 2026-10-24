import { clipDiagnostic } from "./diagnostic.js";

/**
 * The dialogs of /mlx-config: pi's `ctx.ui` made safe to call, and the last result carried into the title of the next menu.
 * Nothing here knows the config file or the menu; the menu takes these as they are.
 */

/** The parts of pi's `ctx.ui` the menu uses, with pi's signatures. */
export interface ConfigMenuUi {
  select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

type NoticeType = "info" | "warning" | "error";

/** The most lines of a result the next menu title carries, so a long refusal cannot make the menu taller than the screen. */
export const CARRY_MAX_LINES = 6;
/** The most characters of a result the next menu title carries. */
export const CARRY_MAX_CHARS = 500;

/**
 * Defense in depth for the carried copy: in every whitespace-separated token that holds "://", the text between "://" and
 * the token's last at sign becomes "***", so "https://u:p@host/x" is carried as "https://***@host/x". Every other token and
 * every separator is returned as it is, so the status word of a notice and text such as @scope/pkg, model@rev or a@b.com
 * (no "://" in the token) are kept. `redactCredentials` is not used because it works by position and cuts a line at its last
 * at sign, which would drop the status word, and the userinfo pattern inside it is private to src/diagnostic.ts and stops at
 * a slash, so it would leak a password that holds one. The cost is one indexOf and one lastIndexOf per token (linear).
 * Limits: a password that holds whitespace is not covered here (the primary layers, `shown` and the settings messages, still
 * hide it), and a URL whose own path holds an at sign has the text between "://" and that last sign hidden, which errs toward
 * hiding.
 */
function maskCredentialSpans(line: string): string {
  return line
    .split(/(\s+)/)
    .map((token) => {
      const scheme = token.indexOf("://");
      if (scheme < 0) return token;
      const at = token.lastIndexOf("@");
      return at > scheme + 2 ? `${token.slice(0, scheme + 3)}***${token.slice(at)}` : token;
    })
    .join("");
}

/**
 * A notice as the title of the next menu carries it: the first lines, each with the credential span of a URL masked, cut to
 * a length, with "..." when anything was left out. The notice itself (ctx.ui.notify) is not changed. The message was built
 * from `shown(...)` parts, but its other parts (settings messages, a write reason, a path) are composed elsewhere, so the
 * copy does not rely on that. clipDiagnostic still replaces control characters.
 */
export function carriedCopy(message: string): string {
  const lines = message.split("\n");
  const kept = lines.slice(0, CARRY_MAX_LINES).map(maskCredentialSpans).join("\n");
  const clipped = clipDiagnostic(kept, CARRY_MAX_CHARS, "start");
  const cut = lines.length > CARRY_MAX_LINES || kept.trim().length > CARRY_MAX_CHARS;
  return cut ? `${clipped}...` : clipped;
}

export interface Dialogs {
  select(title: string, choices: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: NoticeType): void;
  /** Tell the user what happened: notify with the message as it is, and remember a bounded copy for the next menu title. */
  report(message: string, type?: NoticeType): void;
  /** The index of the chosen option, or undefined for a dismissal or an answer that is not one of the options. */
  pick(title: string, choices: string[]): Promise<number | undefined>;
  /**
   * `pick` with the pending result above the title. An answered menu uses the result up, so it is shown once per answered
   * menu. A menu that answers nothing (dismissed, or a dialog that threw: `select` cannot tell the two apart) may never have
   * been seen, so the result is put back for the next menu, unless `report` stored a newer one meanwhile (WR-03).
   */
  pickWithResult(title: string, choices: string[]): Promise<number | undefined>;
}

/**
 * Every ui call is guarded: a dialog that throws is a dismissal (and a declined confirm), the same fail-closed stance as the
 * trust dialogs (Phase 2 D-13). A notify that throws must never stop the menu.
 */
export function createDialogs(ui: ConfigMenuUi): Dialogs {
  /** The last result of an action, waiting for the title of the next menu; used up by a menu that is answered. */
  let pendingResult: string | undefined;

  const dialogs: Dialogs = {
    async select(title, choices) {
      try {
        const answer = await ui.select(title, choices);
        return typeof answer === "string" ? answer : undefined;
      } catch {
        return undefined;
      }
    },
    async input(title, placeholder) {
      try {
        const answer = await ui.input(title, placeholder);
        return typeof answer === "string" ? answer : undefined;
      } catch {
        return undefined;
      }
    },
    async confirm(title, message) {
      try {
        return (await ui.confirm(title, message)) === true;
      } catch {
        return false;
      }
    },
    notify(message, type = "info") {
      try {
        ui.notify(message, type);
      } catch {
        // A notice that cannot be shown does not change what was or was not saved.
      }
    },
    report(message, type = "info") {
      dialogs.notify(message, type);
      pendingResult = carriedCopy(message);
    },
    async pick(title, choices) {
      const answer = await dialogs.select(title, choices);
      if (answer === undefined) return undefined;
      const index = choices.indexOf(answer);
      return index < 0 ? undefined : index;
    },
    async pickWithResult(title, choices) {
      const carried = pendingResult;
      pendingResult = undefined;
      const shownTitle = carried === undefined ? title : `Last result: ${carried}\n\n${title}`;
      const chosen = await dialogs.pick(shownTitle, choices);
      if (chosen === undefined && pendingResult === undefined) pendingResult = carried;
      return chosen;
    },
  };
  return dialogs;
}

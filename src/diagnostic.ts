/**
 * Untrusted text (child output, response bodies, discovered model ids) is shown in pi's UI, so it is
 * cleaned before it gets there. Terminal escape sequences cannot be injected through text that has
 * had its control characters replaced.
 */

/** C0 controls other than tab and newline, DEL, and the C1 range (U+0080-U+009F, which includes CSI U+009B). */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Clip `text` to `max` characters after replacing control characters other than newline and tab with a
 * space. `from` picks which end survives the clip.
 */
export const clipDiagnostic = (text: string, max: number, from: "start" | "end" = "end"): string => {
  const clean = text.replace(CONTROLS, " ").trim();
  return from === "end" ? clean.slice(-max) : clean.slice(0, max);
};

/** A single-line label: every control character, newline and tab included, becomes a space. */
export const cleanLabel = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

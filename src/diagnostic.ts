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

/** The start of a shown URL: an optional double quote (shown values are JSON text), an optional scheme, any run of slashes. */
const URL_START = /^"?(?:https?:|[A-Za-z][A-Za-z0-9+.-]*:(?=[/\\]))?[/\\]*/i;
/** Text that is a JSON object or array, where an `@` belongs to some member and not to a URL at the start. */
const JSON_CONTAINER = /^"?[{[]/;
/** A user and password inside a URL that sits somewhere in the text: after two slashes, up to the next `@`. */
const EMBEDDED_USERINFO = /([/\\]{2})[^\s/\\?#"]*@/g;

/**
 * Text with the user name and password of a URL replaced by `***`, wherever the text is shown: a refused pip index is
 * often one with a pasted secret (WR-01, D-18).
 *
 * A password may hold any character, `/`, `?`, `#` and a space included, so the rule is by position and not by shape:
 * everything from the end of the scheme prefix (a quote, a scheme, slashes, each optional) up to the last `@` is
 * hidden. That also covers one slash, no slash and no scheme. A path that holds an `@` is hidden along with it.
 * Text that starts as a JSON object or array is left to the embedded-URL rule alone.
 *
 * The cost is linear in the length of the text, because the text can come from a project file of up to 256 KiB
 * (T-03-23): one `lastIndexOf`, one pattern anchored at the start with nothing after its repetition, and a pattern
 * whose class stops at the next slash. A pattern of the form prefix-star, anything-star, `@` is quadratic on a long
 * run of slashes and must not replace them.
 */
export const redactCredentials = (text: string): string => {
  let out = text;
  const at = text.lastIndexOf("@");
  if (at !== -1 && !JSON_CONTAINER.test(text)) {
    const start = URL_START.exec(text)?.[0].length ?? 0;
    if (start <= at) out = `${text.slice(0, start)}***${text.slice(at)}`;
  }
  return out.replace(EMBEDDED_USERINFO, "$1***@");
};

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomicfile.js";
import { cleanLabel, clipDiagnostic } from "./diagnostic.js";
import { CONTROL_CHARACTER, MAX_TEXT_LENGTH, PROFILE_NAME } from "./settings.js";

/**
 * The remembered last launch (CMD-06, D-01, D-02, D-05, D-06). One small extension-owned file next to the global config.json, so
 * the config files stay read-only for the extension. It holds a format version, the model id and the profile name and
 * nothing else; typed overrides are never saved (D-02).
 *
 * Any process of the user, or a sync tool, can change this file, and its model id ends up on a server command line, so it
 * is read strictly: a record that is not exactly right is unreadable and is never partly used. Every reason is a fixed
 * phrase (plus an error code at most), so text from a tampered file or the path never reaches a notice.
 */

export const LAST_LAUNCH_FILE = "last-launch.json";
export const LAST_LAUNCH_VERSION = 1;
/** The largest record that is read; a model id may be 4096 characters and everything else is fixed. */
export const MAX_LAST_LAUNCH_BYTES = 8 * 1024;

export interface LastLaunch {
  model: string;
  profile: string | null;
}

export type LastLaunchRead = { state: "absent" } | { state: "unreadable"; reason: string } | { state: "ok"; value: LastLaunch };

/** The three keys of a record, in the order the writer produces them. */
const KEYS = ["version", "model", "profile"];

/**
 * A model id that is safe to keep and to replay: non-empty, not padded, a single line without control characters, within the
 * length limit and not starting with a dash, because the id can become a server argument and a leading dash is a flag
 * (the check `resolveModel` makes again later). The reader and the writer both use this, so the writer cannot produce a
 * record the reader refuses.
 */
function validModel(model: unknown): model is string {
  return (
    typeof model === "string" &&
    model !== "" &&
    model === model.trim() &&
    model.length <= MAX_TEXT_LENGTH &&
    !CONTROL_CHARACTER.test(model) &&
    !model.startsWith("-")
  );
}

/** A profile name is the one rule config files already follow (`PROFILE_NAME`), or null for no profile. */
function validProfile(profile: unknown): profile is string | null {
  return profile === null || (typeof profile === "string" && PROFILE_NAME.test(profile));
}

/** The record lives in the directory of the global config file. */
export function lastLaunchPath(globalConfigPath: string): string {
  return join(dirname(globalConfigPath), LAST_LAUNCH_FILE);
}

/**
 * Write the record atomically: one line of JSON and a newline, keys in a fixed order, nothing but the version, the model id
 * and the profile name. A value the reader would refuse is refused here without touching the file system. The last writer
 * wins and there is no lock (D-05). Never throws.
 */
export function writeLastLaunch(path: string, value: LastLaunch): { ok: true } | { ok: false; reason: string } {
  if (!validModel(value.model)) return { ok: false, reason: "the model id cannot be remembered" };
  if (!validProfile(value.profile)) return { ok: false, reason: "the profile name cannot be remembered" };
  const text = `${JSON.stringify({ version: LAST_LAUNCH_VERSION, model: value.model, profile: value.profile })}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_LAST_LAUNCH_BYTES) return { ok: false, reason: "the record is too large to remember" };
  return writeFileAtomic(path, text);
}

const unreadable = (reason: string): LastLaunchRead => ({ state: "unreadable", reason });

/**
 * Read the record. A file that is not there (or sits under something that is not a directory) is absent and nothing is
 * created. Anything else wrong with it is unreadable with a fixed reason: the caller names the file (D-06). The file is
 * looked at with `stat` first, so a directory, a device or a huge file is refused without being read.
 */
export function readLastLaunch(path: string): LastLaunchRead {
  let bytes: Buffer;
  try {
    const info = statSync(path);
    if (!info.isFile()) return unreadable("is not a regular file");
    if (info.size > MAX_LAST_LAUNCH_BYTES) return unreadable("is larger than 8 KiB");
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
    const shown = typeof code === "string" ? clipDiagnostic(cleanLabel(code), 40, "start") : "";
    return unreadable(shown === "" ? "cannot be read" : `cannot be read (${shown})`);
  }
  // The file may have grown between the stat and the read.
  if (bytes.length > MAX_LAST_LAUNCH_BYTES) return unreadable("is larger than 8 KiB");
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return unreadable("is empty");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // The parser's message quotes the text, so it is not passed on.
    return unreadable("is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return unreadable("must contain a JSON object");
  const fields = data as Record<string, unknown>;
  // Own-key lookups only, and nothing is copied onto another object: a "__proto__" key is just an extra key here.
  if (!Object.hasOwn(fields, "version") || fields.version !== LAST_LAUNCH_VERSION) return unreadable("was written in an unknown format version");
  const keys = Object.keys(fields);
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return unreadable("does not hold exactly the fields version, model and profile");
  if (!validModel(fields.model)) return unreadable("has an invalid model id");
  if (!validProfile(fields.profile)) return unreadable("has an invalid profile name");
  return { state: "ok", value: { model: fields.model, profile: fields.profile } };
}

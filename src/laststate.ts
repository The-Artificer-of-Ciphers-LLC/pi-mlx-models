import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomicfile.js";

/**
 * The remembered last launch (CMD-06, D-01, D-02, D-05). One small extension-owned file next to the global config.json, so
 * the config files stay read-only for the extension. It holds a format version, the model id and the profile name and
 * nothing else; typed overrides are never saved (D-02).
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

/** The record lives in the directory of the global config file. */
export function lastLaunchPath(globalConfigPath: string): string {
  return join(dirname(globalConfigPath), LAST_LAUNCH_FILE);
}

/** Write the record atomically: one line of JSON and a newline, keys in a fixed order. Never throws. */
export function writeLastLaunch(path: string, value: LastLaunch): { ok: true } | { ok: false; reason: string } {
  const text = `${JSON.stringify({ version: LAST_LAUNCH_VERSION, model: value.model, profile: value.profile })}\n`;
  return writeFileAtomic(path, text);
}

/** Read the record. A file that is not there (or sits under something that is not a directory) is absent. */
export function readLastLaunch(path: string): LastLaunchRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
    return { state: "unreadable", reason: "cannot be read" };
  }
  const data = JSON.parse(text) as { model: string; profile: string | null };
  return { state: "ok", value: { model: data.model, profile: data.profile } };
}

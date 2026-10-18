/** The remembered last launch (CMD-06, D-01, D-02, D-05, D-06). Stub: the real body follows in the next commit. */

export const LAST_LAUNCH_FILE = "last-launch.json";
export const LAST_LAUNCH_VERSION = 1;
export const MAX_LAST_LAUNCH_BYTES = 8 * 1024;

export interface LastLaunch {
  model: string;
  profile: string | null;
}

export type LastLaunchRead = { state: "absent" } | { state: "unreadable"; reason: string } | { state: "ok"; value: LastLaunch };

export function lastLaunchPath(_globalConfigPath: string): string {
  throw new Error("not implemented");
}

export function writeLastLaunch(_path: string, _value: LastLaunch): { ok: true } | { ok: false; reason: string } {
  throw new Error("not implemented");
}

export function readLastLaunch(_path: string): LastLaunchRead {
  throw new Error("not implemented");
}

import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cleanLabel, clipDiagnostic } from "./diagnostic.js";

/**
 * One atomic file writer, shared by the last-launch record (plan 06-04) and the config editor (plan 06-05) so the crash
 * behavior is defined once (D-05, D-20). The text goes to a temp file in the target's own directory and is then renamed
 * over the target, so a reader sees the old file or the new one and never half of either. Last writer wins and there is no
 * lock file. This module depends on nothing of the extension, so any later module can use it without a cycle.
 */

export interface AtomicWriteOptions {
  /** Permission bits of a file this call creates; default 0o600. */
  mode?: number;
  /** Keep the permission bits of an existing regular target instead of `mode`. */
  keepMode?: boolean;
  /** When the target is a symlink, write the file behind it and keep the link; otherwise the link itself is replaced. */
  followSymlink?: boolean;
}

/** A failure carries a reason that is an errno code or a fixed phrase: never the path or the text (the caller names the file). */
export type AtomicWriteResult = { ok: true } | { ok: false; reason: string };

/** Makes two temp names in one process differ even when the clock and the target name are the same. */
let tempCounter = 0;

const DEFAULT_MODE = 0o600;
const MAX_ATTEMPTS = 3;

/** The reason for a failed write: the errno code, cleaned and at most 40 characters, else a fixed phrase. */
function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== "string") return "write failed";
  const clean = clipDiagnostic(cleanLabel(code), 40, "start");
  return clean === "" ? "write failed" : clean;
}

/** The file the write really replaces: with `followSymlink` the file behind a link, else the path as given. */
function resolveTarget(path: string, followSymlink: boolean): string {
  if (!followSymlink) return path;
  try {
    return realpathSync(path);
  } catch {
    // A path that does not exist yet (or a link to nothing) is written as given.
    return path;
  }
}

/** The permission bits of an existing regular file, else undefined. */
function existingMode(path: string): number | undefined {
  try {
    const info = statSync(path);
    return info.isFile() ? info.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write `text` to `path` atomically. Synchronous like the rest of the file code in this repository, and it never throws:
 * every failure is a `{ ok: false, reason }` and leaves the previous content of the target untouched and no temp file
 * behind. Missing parent directories are created. An empty `text` is written as an empty file; refusing it is the caller's
 * business.
 */
export function writeFileAtomic(path: string, text: string, options: AtomicWriteOptions = {}): AtomicWriteResult {
  let temp: string | undefined;
  let fd: number | undefined;
  try {
    const target = resolveTarget(path, options.followSymlink === true);
    const directory = dirname(target);
    mkdirSync(directory, { recursive: true });
    const mode = (options.keepMode === true ? existingMode(target) : undefined) ?? options.mode ?? DEFAULT_MODE;
    // The temp name is made from the target's base name, the process id and a counter; the exclusive open means an
    // existing file of that name is never overwritten, a clash just takes the next number.
    for (let attempt = 0; fd === undefined; attempt += 1) {
      tempCounter += 1;
      const candidate = join(directory, `${basename(target)}.${process.pid}.${tempCounter}.tmp`);
      try {
        fd = openSync(candidate, "wx", mode);
        temp = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt + 1 >= MAX_ATTEMPTS) throw error;
      }
    }
    // The open applies the process umask; the permission bits asked for are set exactly.
    fchmodSync(fd, mode);
    const bytes = Buffer.from(text, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    try {
      fsyncSync(fd);
    } catch {
      // Best effort: some file systems refuse it, and the rename below is still atomic.
    }
    closeSync(fd);
    fd = undefined;
    renameSync(temp as string, target);
    return { ok: true };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing more to do with a descriptor that will not close.
      }
    }
    if (temp !== undefined) {
      try {
        unlinkSync(temp);
      } catch {
        // The temp file may already be gone.
      }
    }
    return { ok: false, reason: reasonOf(error) };
  }
}

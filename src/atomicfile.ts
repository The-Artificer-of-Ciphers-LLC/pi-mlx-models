/**
 * One atomic file writer, shared by the last-launch record and the config editor so the crash behavior is defined once
 * (plan 06-01, D-05, D-20). Placeholder for the test-first step; the real body follows in the next commit.
 */

export interface AtomicWriteOptions {
  /** Permission bits of a file this call creates; default 0o600. */
  mode?: number;
  /** Keep the permission bits of an existing regular target instead of `mode`. */
  keepMode?: boolean;
  /** When the target is a symlink, write the file behind it and keep the link. */
  followSymlink?: boolean;
}

export type AtomicWriteResult = { ok: true } | { ok: false; reason: string };

export function writeFileAtomic(path: string, text: string, options: AtomicWriteOptions = {}): AtomicWriteResult {
  void path;
  void text;
  void options;
  throw new Error("not implemented");
}

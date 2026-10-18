import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiHost } from "./index.js";
import type { ModelConfigRead } from "./modelinfo.js";

/**
 * Shared helpers for tests that need a real child process standing in for
 * `mlx_lm.server`. Excluded from the production build (see tsconfig.json) and
 * never published.
 *
 * Compiled test files live flat in `.test-dist/`, so the relative hop below
 * lands on the repo-root `test/fixtures` directory.
 */
export const STUB_SERVER_PATH = fileURLToPath(new URL("../test/fixtures/stub-mlx-server.mjs", import.meta.url));

export type StubMode = "ok" | "flood" | "exit-early" | "bind-hang" | "warmup-400" | "hang" | "ignore-term";

/** Local address shape; deliberately not imported from server.ts. */
export interface StubAddress {
  host: string;
  port: number;
}

/** Ask the OS for a free loopback port, then release it. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not read the assigned port"));
        return;
      }
      const { port } = address;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** True when a TCP connect to the loopback port is refused. */
export function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

/** argv for the stub, mirroring the real server's --model/--host/--port flags; `extraArgs` are appended last. */
export function stubArgs(model: string, address: StubAddress, extraArgs: readonly string[] = []): string[] {
  return [STUB_SERVER_PATH, "--model", model, "--host", address.host, "--port", String(address.port), ...extraArgs];
}

type Handler = (args: string, ctx: any) => Promise<void>;
/** A handler registered with `pi.on`: session_shutdown takes nothing, before_provider_request takes an event and a context. */
export type HookHandler = (event?: any, ctx?: any) => unknown;
export type ProviderCall = { name: string; config: any };
export type Note = { message: string; type: string };
export type FlagRegistration = { name: string; options: { description?: string; type: "boolean" | "string"; default?: boolean | string } };

/**
 * A fake pi that records what the extension registers, so tests can drive the handlers directly.
 * Flags are recorded as registered (`flags`), set from the test with `setFlag` (undefined clears one) and
 * counted when read (`getFlagCalls`). Like pi, a registered default is written into the flag values at
 * registration, which is why the extension must never pass one.
 */
export function makeFakePi() {
  const commands = new Map<string, Handler>();
  const handlers = new Map<string, HookHandler>();
  const providerCalls: ProviderCall[] = [];
  const flags: FlagRegistration[] = [];
  const flagValues = new Map<string, boolean | string>();
  let getFlagCalls = 0;
  const setModelCalls: unknown[] = [];
  let setModelBehaviour: (model: unknown) => boolean | Promise<boolean> = () => true;
  const emitModelSelect = (model: unknown, source: string) => {
    handlers.get("model_select")?.({ type: "model_select", model, previousModel: undefined, source });
  };
  const pi: PiHost = {
    registerCommand(name, options) {
      commands.set(name, options.handler);
    },
    registerProvider(name, config) {
      providerCalls.push({ name, config });
    },
    registerFlag(name, options) {
      flags.push({ name, options });
      if (options.default !== undefined) flagValues.set(name, options.default);
    },
    getFlag(name) {
      getFlagCalls += 1;
      return flagValues.get(name);
    },
    // Explicit parameter types: PiHost.on is overloaded, so an object-literal method gets no contextual types.
    on(event: string, handler: HookHandler) {
      handlers.set(event, handler);
    },
    async setModel(model: unknown) {
      setModelCalls.push(model);
      const result = await setModelBehaviour(model);
      // Like pi, a switch it accepts is announced before setModel returns.
      if (result === true) emitModelSelect(model, "set");
      return result;
    },
  };
  return {
    pi,
    commands,
    handlers,
    providerCalls,
    flags,
    setFlag(name: string, value: boolean | string | undefined) {
      if (value === undefined) flagValues.delete(name);
      else flagValues.set(name, value);
    },
    getFlagCalls: () => getFlagCalls,
    /** The models passed to `pi.setModel`, in order. */
    setModelCalls,
    /** Replaces what `pi.setModel` does; the default accepts every model. */
    onSetModel(fn: (model: unknown) => boolean | Promise<boolean>) {
      setModelBehaviour = fn;
    },
    /** Raises a model_select event the way pi does when the user picks, cycles or restores a model. */
    selectModel(model: unknown, source = "set") {
      emitModelSelect(model, source);
    },
  };
}

/** A fake pi model registry that knows the given models; `find` records its calls and returns the same object each time. */
export function makeFakeRegistry(known: Array<{ provider: string; id: string }>) {
  const models = new Map<string, { provider: string; id: string; name: string }>();
  for (const { provider, id } of known) models.set(`${provider}/${id}`, { provider, id, name: id });
  const findCalls: Array<[string, string]> = [];
  const registry = {
    find(provider: string, id: string) {
      findCalls.push([provider, id]);
      return models.get(`${provider}/${id}`);
    },
  };
  return { registry, findCalls, models };
}

export interface CtxOptions {
  /** The command's working directory; default is a fresh temporary directory. */
  cwd?: string;
  /** Whether an interactive UI is attached; default true. */
  hasUI?: boolean;
  /** The answer ui.confirm gives, or a function of the dialog's title and message; default true. */
  confirm?: boolean | ((title: string, message: string) => boolean);
  /** The text ui.input gives for a dialog title and placeholder; undefined (a dismissal) when absent or when it returns undefined. */
  input?: (title: string, placeholder?: string) => string | undefined;
  /** What `ctx.modelRegistry` is; default: none, like a host that does not expose one. */
  modelRegistry?: { find(provider: string, modelId: string): unknown };
}

/** One dialog `makeCtx` showed: which method, its title, and the options (select) or message (confirm). */
export interface Prompt {
  kind: "select" | "input" | "confirm";
  title: string;
  options?: string[];
  message?: string;
}

/**
 * A fake ctx.ui; `select` decides what the picker returns (default: the first option) and receives the dialog title as its
 * second argument. Every select, input and confirm is recorded in `prompts`, in call order.
 */
export function makeCtx(
  select: (options: string[], title: string) => string | undefined = (options) => options[0],
  options: CtxOptions = {},
) {
  const notes: Note[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const widgets: Array<{ id: string; lines: string[] | undefined }> = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const prompts: Prompt[] = [];
  const ctx = {
    cwd: options.cwd ?? mkdtempSync(join(tmpdir(), "pi-mlx-ctx-")),
    hasUI: options.hasUI ?? true,
    ...(options.modelRegistry !== undefined ? { modelRegistry: options.modelRegistry } : {}),
    ui: {
      notify(message: string, type = "info") {
        notes.push({ message, type });
      },
      async select(title: string, choices: string[]) {
        prompts.push({ kind: "select", title, options: [...choices] });
        return select(choices, title);
      },
      async input(title: string, placeholder?: string) {
        prompts.push({ kind: "input", title });
        return options.input?.(title, placeholder);
      },
      async confirm(title: string, message: string) {
        confirms.push({ title, message });
        prompts.push({ kind: "confirm", title, message });
        return typeof options.confirm === "function" ? options.confirm(title, message) : (options.confirm ?? true);
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
      setWidget(id: string, lines: string[] | undefined) {
        widgets.push({ id, lines });
      },
    },
  };
  return { ctx, notes, statuses, widgets, confirms, prompts };
}

/**
 * A select callback that answers from a script, one step per call. A string picks the first option that contains that text
 * (case-sensitive), a number picks the option at that index, and undefined answers undefined (a dismissal). An exhausted
 * script answers undefined. A string or number that matches no option answers undefined and records a message that lists the
 * options in `errors`, so a test can assert the script and the menu agree. `remaining()` counts the unused steps.
 */
export function scriptSelect(...steps: Array<string | number | undefined>) {
  let next = 0;
  const errors: string[] = [];
  const answer = (options: string[], title?: string): string | undefined => {
    if (next >= steps.length) return undefined;
    const step = steps[next];
    next += 1;
    if (step === undefined) return undefined;
    const found = typeof step === "number" ? options[step] : options.find((option) => option.includes(step));
    if (found === undefined) {
      errors.push(`step ${next} (${JSON.stringify(step)}) matched none of the options of ${JSON.stringify(title ?? "")}: ${JSON.stringify(options)}`);
    }
    return found;
  };
  return Object.assign(answer, { errors, remaining: (): number => steps.length - next });
}

/** An input callback that answers from a script, one text per call; undefined is a dismissal and an exhausted script answers undefined. */
export function scriptInput(...texts: Array<string | undefined>) {
  let next = 0;
  const answer = (_title: string, _placeholder?: string): string | undefined => {
    if (next >= texts.length) return undefined;
    const text = texts[next];
    next += 1;
    return text;
  };
  return Object.assign(answer, { remaining: (): number => texts.length - next });
}

export interface SpawnStubOptions {
  mode: StubMode | (string & {});
  port: number;
  host?: string;
  model?: string;
  env?: Record<string, string>;
  stdio?: StdioOptions;
}

/** Spawn the stub under the current Node binary. */
export function spawnStub(options: SpawnStubOptions): ChildProcess {
  const { mode, port, host = "127.0.0.1", model = "stub/model", env = {}, stdio = ["ignore", "pipe", "pipe"] } = options;
  return spawn(process.execPath, stubArgs(model, { host, port }), {
    env: { ...process.env, ...env, STUB_MODE: mode },
    stdio,
  });
}

export interface WaitForHttpOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/** Poll until any HTTP response arrives; reject at the deadline. */
export async function waitForHttp(url: string, options: WaitForHttpOptions = {}): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 25 } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      await res.arrayBuffer().catch(() => undefined);
      return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`no HTTP response from ${url} within ${timeoutMs} ms: ${String(lastError)}`);
}

/** One request the stub recorded: the URL it was posted to and the body, parsed when it was JSON and raw text otherwise. */
export interface RecordedRequest {
  url: string;
  body: unknown;
}

/** The requests the stub wrote to its STUB_REQUEST_FILE, oldest first; empty when the file does not exist. */
export function readRequests(file: string): RecordedRequest[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as RecordedRequest);
}

/** Resolve with the exit code/signal once the child has exited. */
export function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** The parsed `config.json` of a real model, committed under test/fixtures/hf-config (a name without the `.json` suffix). */
export function hfFixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`../test/fixtures/hf-config/${name}.json`, import.meta.url), "utf8"));
}

export interface WriteHfCacheOptions {
  /** The snapshot directory name; default is a fixed 40-character hexadecimal revision. */
  revision?: string;
  /** The text of `refs/main`; default is the revision. */
  refsText?: string;
  /** Leave `refs/main` out. */
  omitRefs?: boolean;
  /** Write `config.json` as a regular file in the snapshot instead of a symlink to a blob. */
  regularFile?: boolean;
  /** The exact text of `config.json`, written instead of the JSON of `config`. */
  raw?: string;
}

/**
 * Lay out one Hugging Face hub cache entry the way huggingface_hub does: `models--ORG--NAME/refs/main`, a blob named
 * by a hash, and `snapshots/<revision>/config.json` as a relative symlink to that blob. Returns the snapshot directory.
 */
export function writeHfCache(cacheRoot: string, repoId: string, config: unknown, options: WriteHfCacheOptions = {}): string {
  const revision = options.revision ?? "0123456789abcdef0123456789abcdef01234567";
  const entry = join(cacheRoot, `models--${repoId.replace("/", "--")}`);
  const snapshot = join(entry, "snapshots", revision);
  mkdirSync(snapshot, { recursive: true });
  const text = options.raw ?? JSON.stringify(config);
  if (options.regularFile) {
    writeFileSync(join(snapshot, "config.json"), text);
  } else {
    const blobs = join(entry, "blobs");
    mkdirSync(blobs, { recursive: true });
    const blobName = createHash("sha1").update(text).digest("hex");
    writeFileSync(join(blobs, blobName), text);
    symlinkSync(join("..", "..", "blobs", blobName), join(snapshot, "config.json"));
  }
  if (!options.omitRefs) {
    mkdirSync(join(entry, "refs"), { recursive: true });
    writeFileSync(join(entry, "refs", "main"), options.refsText ?? revision);
  }
  return snapshot;
}

/** A stand-in for the model-config reader: answers from `configs` by model id, else with `otherwise`, and records its calls. */
export function makeFakeModelConfig(
  configs: Record<string, unknown> = {},
  otherwise: ModelConfigRead = { ok: true, config: { max_position_embeddings: 131072 }, source: "cache" },
) {
  const calls: Array<{ modelId: string; hub: boolean }> = [];
  const read = async (modelId: string, options: { hub: boolean }): Promise<ModelConfigRead> => {
    calls.push({ modelId, hub: options.hub });
    if (Object.hasOwn(configs, modelId)) return { ok: true, config: configs[modelId], source: "cache" };
    return otherwise;
  };
  return { read, calls };
}

import { cleanLabel, clipDiagnostic, redactCredentials } from "./diagnostic.js";
import { probeModels, type ModelsProbe } from "./discovery.js";
import { connectProbe, probeAddress } from "./port.js";
import type { ServerAddress } from "./server.js";

/**
 * The read-only seams behind /mlx-status: a probe of one host and port, a classifier that cannot call a loading
 * server ready, and a formatter for the status block (D-08 to D-12).
 */

/**
 * Default bound, in milliseconds, of one status probe's models request. Shorter than DISCOVERY_TIMEOUT_MS (5000),
 * because a status command should answer quickly. Approved by the owner on 2026-10-18 (plan 06-03 summary).
 */
export const STATUS_PROBE_TIMEOUT_MS = 1500;

/** What one probe of a host and port found: whether a connect is accepted and, only then, whether /v1/models answers. */
export interface HealthProbe {
  accepts: boolean;
  models: ModelsProbe;
}

export type ProbeHealth = (address: ServerAddress, baseUrl: string) => Promise<HealthProbe>;

export interface HealthProbeDeps {
  connect?: (host: string, port: number) => Promise<boolean>;
  models?: (options: { baseUrl: string; timeoutMs: number }) => Promise<ModelsProbe>;
  /** Bound of the models request; defaults to STATUS_PROBE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Connect first; ask /v1/models only when the connect is accepted, so nothing listening costs no HTTP request. */
export function createHealthProbe(deps: HealthProbeDeps = {}): ProbeHealth {
  const connect = deps.connect ?? ((host: string, port: number) => connectProbe(host, port));
  const models = deps.models ?? probeModels;
  const timeoutMs = deps.timeoutMs ?? STATUS_PROBE_TIMEOUT_MS;
  return async (address, baseUrl) => {
    const accepts = await connect(probeAddress(address.host), address.port);
    if (!accepts) return { accepts: false, models: { answers: false } };
    return { accepts: true, models: await models({ baseUrl, timeoutMs }) };
  };
}

export type SessionState = "none" | "starting" | "ready";
export type Health = "ready" | "loading" | "down" | "not answering";

export interface StatusView {
  health: Health;
  address: ServerAddress;
  session: SessionState;
  launch?: {
    modelId: string;
    presetKey?: string;
    profileLine: string;
    flagsLine: string;
    requestLine: string;
    modelLine?: string;
  };
  served: readonly string[];
}

/**
 * Turn what a probe found into a health word. While a start of this session is under way the answer is always
 * loading, even when /v1/models already answers: mlx_lm.server answers it before the model is loaded and warmed, so an
 * answer then proves nothing (Pitfall 1). Ready needs a completed start of this session or, for a server this session
 * did not start, an answering /v1/models. A server this session did not start that accepts and stays silent is
 * reported as not answering and never as loading, because nothing says it is starting.
 */
export function classifyHealth(session: SessionState, probe: HealthProbe): Health {
  if (session === "starting") return "loading";
  if (!probe.accepts) return "down";
  if (probe.models.answers) return "ready";
  // A finished start whose server is busy (mlx_lm.server handles one request at a time) is loading, following D-08.
  return session === "ready" ? "loading" : "not answering";
}

/** At most this many served ids are listed; the rest are counted (T-06-06). */
const MAX_SERVED_IDS = 10;
/** A shown id is clipped to this many characters. */
const ID_LIMIT = 80;

/** Text from a server or a file, made safe to show: control characters out, credentials hidden, then clipped (the clip is last). */
const shown = (text: string): string => clipDiagnostic(redactCredentials(cleanLabel(text)), ID_LIMIT, "start");

const hostPort = (address: ServerAddress): string =>
  `${address.host.includes(":") ? `[${address.host}]` : address.host}:${address.port}`;

function servedText(served: readonly string[]): string {
  if (served.length === 0) return "none reported";
  const listed = served.slice(0, MAX_SERVED_IDS).map(shown).join(", ");
  const rest = served.length - MAX_SERVED_IDS;
  return rest > 0 ? `${listed} and ${rest} more` : listed;
}

type Launch = NonNullable<StatusView["launch"]>;

/** The text in parentheses on the first line, for a launch of this session. */
function sessionReason(view: StatusView, where: string): string {
  if (view.session === "starting") return "a start is under way";
  switch (view.health) {
    case "ready":
      return `answering on ${where}`;
    case "loading":
      return "busy or not answering yet";
    case "down":
      return "the server this session started is not answering";
    case "not answering":
      return "accepts connections but does not answer /v1/models";
  }
}

/** A launch of this session. The profile, flags, request and model lines are the start message lines, passed in as given. */
function formatSession(view: StatusView, launch: Launch, where: string): string {
  const preset = launch.presetKey ? ` (preset ${shown(launch.presetKey)})` : "";
  const out = [`status: ${view.health} (${sessionReason(view, where)})`, `server: ${shown(launch.modelId)}${preset} on ${where}`];
  for (const line of [launch.profileLine, launch.flagsLine, launch.requestLine]) if (line !== "") out.push(line);
  if (view.session === "starting") out.push("note: the model details appear after the start finishes");
  else if (launch.modelLine) out.push(launch.modelLine);
  return out.join("\n");
}

/** A server this session did not start: only the port, the health and what it serves are known. */
function formatForeign(view: StatusView, where: string): string {
  if (view.health === "down") return `status: down (nothing is listening on ${where})`;
  if (view.health === "not answering") {
    return `status: not answering (${where} accepts connections but does not answer /v1/models; not started by this session)`;
  }
  return [
    `status: ${view.health} (answering on ${where})`,
    `server: ${where}, not started by this session`,
    `models: ${servedText(view.served)}`,
    "profile: unknown",
    "flags: unknown",
    "note: the model line is not shown for a server this session did not start",
  ].join("\n");
}

/**
 * The status block: one multi-line text. Every id that came from a server or a file is cleaned, has credentials hidden
 * and is clipped before it is shown (T-06-06); the reasons hold no other text from the probe.
 */
export function formatStatus(view: StatusView): string {
  const where = hostPort(view.address);
  if (view.session === "none" || view.launch === undefined) return formatForeign(view, where);
  return formatSession(view, view.launch, where);
}

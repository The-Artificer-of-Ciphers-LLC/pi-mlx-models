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
 * because a status command should answer quickly. Open decision for the user, recorded in the plan 06-03 summary.
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

export function classifyHealth(session: SessionState, probe: HealthProbe): Health {
  if (session !== "none") throw new Error("not implemented");
  if (!probe.accepts) return "down";
  return probe.models.answers ? "ready" : "not answering";
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

export function formatStatus(view: StatusView): string {
  if (view.session !== "none") throw new Error("not implemented");
  const where = hostPort(view.address);
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

import type { ModelsProbe } from "./discovery.js";
import type { ServerAddress } from "./server.js";

export const STATUS_PROBE_TIMEOUT_MS = 1500;

export interface HealthProbe {
  accepts: boolean;
  models: ModelsProbe;
}

export type ProbeHealth = (address: ServerAddress, baseUrl: string) => Promise<HealthProbe>;

export function createHealthProbe(_deps: {
  connect?: (host: string, port: number) => Promise<boolean>;
  models?: (options: { baseUrl: string; timeoutMs: number }) => Promise<ModelsProbe>;
  timeoutMs?: number;
} = {}): ProbeHealth {
  throw new Error("not implemented");
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

export function classifyHealth(_session: SessionState, _probe: HealthProbe): Health {
  throw new Error("not implemented");
}

export function formatStatus(_view: StatusView): string {
  throw new Error("not implemented");
}

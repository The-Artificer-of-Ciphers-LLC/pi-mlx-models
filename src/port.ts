import { connect, createServer, type NetConnectOpts } from "node:net";

/**
 * Port-occupancy probes. A port counts as occupied when EITHER something accepts a
 * connection OR an exclusive bind fails with EADDRINUSE: a bind probe alone misses a
 * wildcard-bound occupant on macOS, and a connect probe alone cannot see a socket that
 * is bound but not listening.
 *
 * Known conservative behaviour: a listener bound to a wildcard address (0.0.0.0 or ::)
 * makes the connect probe report busy even though a loopback bind could succeed on macOS.
 * Such users are refused and pointed at PI_MLX_MODELS_PORT rather than being let through.
 *
 * The probes never listen on a wildcard address; see probeAddress.
 */

/** True when something accepts a TCP connection at host:port. Resolves false on error or timeout. */
export function connectProbe(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const options: NetConnectOpts = { host, port };
    const socket = connect(options);
    let settled = false;
    const done = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** True when an exclusive bind of host:port fails with EADDRINUSE. A successful probe bind is closed before resolving. */
export function bindProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRINUSE"));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(false)));
  });
}

/** The address a probe actually uses: wildcard hosts and the empty string map to loopback, everything else is unchanged. */
export function probeAddress(host: string): string {
  return host === "" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

/** True when the target address is occupied, by either probe. Never binds a wildcard address (T-01-11). */
export async function probePort(host: string, port: number): Promise<boolean> {
  const target = probeAddress(host);
  if (await connectProbe(target, port)) return true;
  return bindProbe(target, port);
}

export interface WaitForPortFreeOptions {
  host: string;
  port: number;
  /** Resolves true while the port is occupied. */
  probe: (host: string, port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

/**
 * Poll `probe` until the port is free. Bounded by an attempt count of
 * max(1, ceil(timeoutMs / pollMs)) rather than the wall clock, so a fake `sleep`
 * makes it deterministic. Resolves true when free, false when still occupied.
 */
export async function waitForPortFree({ host, port, probe, sleep, timeoutMs, pollMs }: WaitForPortFreeOptions): Promise<boolean> {
  const interval = Math.max(1, pollMs);
  const attempts = Math.max(1, Math.ceil(timeoutMs / interval));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!(await probe(host, port))) return true;
    if (attempt < attempts) await sleep(pollMs);
  }
  return false;
}

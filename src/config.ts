import { join } from "node:path";
import { homedir } from "node:os";
// Namespace import so a pi build without the getAgentDir export yields undefined instead of a load-time failure.
import * as pi from "@mariozechner/pi-coding-agent";

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_MODEL_ID = "mlx-community/Qwen3-4B-Instruct-2507-4bit";

/** The OpenAI-style base URL for a host and port. A bare IPv6 host is bracketed. Callers append "/models" etc. */
export function deriveBaseUrl(host: string, port: number): string {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}/v1`;
}

export interface PortResult {
  port: number;
  warning?: string;
}

/**
 * Parse the PI_MLX_MODELS_PORT value. Only trimmed decimal integers from 1 to
 * 65535 are accepted; anything else (empty, text, 0, out of range, fractional)
 * falls back with a warning so a malformed variable can never become port 0 or NaN.
 */
export function parsePort(raw: string | undefined, fallback: number = DEFAULT_PORT): PortResult {
  if (raw === undefined) return { port: fallback };
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed);
    if (port >= 1 && port <= 65535) return { port };
  }
  return {
    port: fallback,
    warning: `PI_MLX_MODELS_PORT=${JSON.stringify(raw)} is not a port number from 1 to 65535; using ${fallback}.`,
  };
}

export interface AgentDirDeps {
  getAgentDir?: () => string;
  env: NodeJS.ProcessEnv;
  home: string;
}

/**
 * Resolve pi's agent directory: pi's own getAgentDir() when the host exports it,
 * else PI_CODING_AGENT_DIR (with ~ expansion), else ~/.pi/agent.
 */
export function resolveAgentDir({ getAgentDir, env, home }: AgentDirDeps): string {
  if (typeof getAgentDir === "function") {
    try {
      return getAgentDir();
    } catch {
      // fall through to the env/home rules rather than failing the import
    }
  }
  const fromEnv = env.PI_CODING_AGENT_DIR;
  if (fromEnv) {
    if (fromEnv === "~") return home;
    if (fromEnv.startsWith("~/")) return join(home, fromEnv.slice(2));
    return fromEnv;
  }
  return join(home, ".pi", "agent");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

function normalizeHost(host: string): string {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare.toLowerCase();
}

/**
 * True only for the three spellings of this machine's own loopback address: 127.0.0.1, localhost and ::1
 * (case-insensitive, brackets stripped). Everything else is non-loopback, including the wildcards 0.0.0.0 and ::,
 * other 127.x addresses and IPv4-mapped IPv6: the rule is deliberately conservative (D-17).
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

function hostsMatch(urlHost: string, launchHost: string): boolean {
  if (urlHost === launchHost) return true;
  if (LOOPBACK_HOSTS.has(urlHost) && LOOPBACK_HOSTS.has(launchHost)) return true;
  return WILDCARD_HOSTS.has(launchHost) && LOOPBACK_HOSTS.has(urlHost);
}

/**
 * Compare an explicit PI_MLX_MODELS_BASE_URL with the launch host/port. Returns a
 * warning when they disagree (the extension would poll and register one address while
 * the server listens on another), or null when there is nothing to report.
 */
export function baseUrlWarning({
  baseUrl,
  host,
  port,
  source = "PI_MLX_MODELS_BASE_URL",
}: {
  baseUrl: string | undefined;
  host: string;
  port: number;
  /** What names the value in the message: the variable by default, or the layer that set it. */
  source?: string;
}): string | null {
  if (baseUrl === undefined) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `${source}=${JSON.stringify(baseUrl)} is not a valid URL.`;
  }
  const urlHost = normalizeHost(url.hostname);
  const urlPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const launchHost = normalizeHost(host);
  if (hostsMatch(urlHost, launchHost) && urlPort === port) return null;
  return (
    `${source} points at ${urlHost}:${urlPort} but the server launches on ${launchHost}:${port}; ` +
    `polling and registration would use the URL while the server launches on the launch address.`
  );
}

/** An environment value with surrounding whitespace removed; empty or blank counts as unset. */
export function envText(raw: string | undefined): string | undefined {
  return raw?.trim() || undefined;
}

/** The project-level config file, relative to the working directory of the command (never searched for in parents). */
export const PROJECT_CONFIG_RELPATH = join(".pi", "pi-mlx-models.json");
export const PROVIDER_ID = "pi-mlx-models";
export const DATA_DIR = join(
  resolveAgentDir({
    getAgentDir: (pi as { getAgentDir?: () => string }).getAgentDir,
    env: process.env,
    home: homedir(),
  }),
  "pi-mlx-models",
);
/** The user-level config file. Read on every /mlx-start; never created by the extension. */
export const GLOBAL_CONFIG_PATH = join(DATA_DIR, "config.json");
export const VENV_DIR = join(DATA_DIR, "venv");
export const VENV_PYTHON = join(VENV_DIR, "bin", "python3");
export const HF_HOME = join(DATA_DIR, "models");

import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_PORT = 8080;

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

const portResult = parsePort(process.env.PI_MLX_MODELS_PORT);

export const PORT = portResult.port;
export const HOST = process.env.PI_MLX_MODELS_HOST ?? "127.0.0.1";
export const BASE_URL = process.env.PI_MLX_MODELS_BASE_URL ?? `http://${HOST}:${PORT}/v1`;
export const DEFAULT_MODEL = process.env.PI_MLX_MODELS_DEFAULT_MODEL ?? "mlx-community/Qwen3-4B-Instruct-2507-4bit";

/** Warnings found while reading configuration; index.ts surfaces each once. config.ts never prints. */
export const CONFIG_WARNINGS: readonly string[] = [...(portResult.warning ? [portResult.warning] : [])];

export const PROVIDER_ID = "pi-mlx-models";
export const DATA_DIR = join(homedir(), ".pi", "agent", "pi-mlx-models");
export const VENV_DIR = join(DATA_DIR, "venv");
export const VENV_PYTHON = join(VENV_DIR, "bin", "python3");
export const HF_HOME = join(DATA_DIR, "models");

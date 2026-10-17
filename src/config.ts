import { join } from "node:path";
import { homedir } from "node:os";

export const PORT = Number(process.env.PI_MLX_MODELS_PORT ?? 11434);
export const HOST = process.env.PI_MLX_MODELS_HOST ?? "127.0.0.1";
export const BASE_URL = process.env.PI_MLX_MODELS_BASE_URL ?? `http://${HOST}:${PORT}/v1`;
export const DEFAULT_MODEL = process.env.PI_MLX_MODELS_DEFAULT_MODEL ?? "mlx-community/Qwen3-4B-Instruct-2507-4bit";

export const PROVIDER_ID = "pi-mlx-models";
export const DATA_DIR = join(homedir(), ".pi", "agent", "pi-mlx-models");
export const VENV_DIR = join(DATA_DIR, "venv");
export const VENV_PYTHON = join(VENV_DIR, "bin", "python3");
export const HF_HOME = join(DATA_DIR, "models");

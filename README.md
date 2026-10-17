# pi-mlx-models

Local MLX model launcher for [Pi](https://pi.dev) on Apple Silicon.

<p align="center">
  <img src="./assets/preset-selector.png" alt="Preset selector" width="780" />
</p>

`pi-mlx-models` adds a local OpenAI-compatible provider to Pi, with a guided startup flow for MLX models.

## What you get

- Interactive preset selector via `/mlx-start`
- Local runtime bootstrap via `/mlx-init` (venv + `mlx-lm`)
- Startup progress with stage/status updates and warm-up timer
- Provider models only appear when the server is actually ready
- Stop/cleanup command via `/mlx-stop`

## Install

### From npm

```bash
pi install npm:pi-mlx-models
```

### From GitHub

```bash
pi install git:github.com/vmarinogg/pi-mlx-models
```

## Quick start

```bash
/mlx-init
/mlx-start
```

When `/mlx-start` is used with no args, a selector opens and you can pick a preset with arrow keys + Enter.

You can also start directly with a full model id:

```bash
/mlx-start mlx-community/Qwen3-4B-Instruct-2507-4bit
```

## Commands

- `/mlx-init` — initialize local MLX runtime
- `/mlx-start [preset-number|preset-key|hf-model-id]` — open selector (no args), or start a preset by its number (1-5) or key, or any full model id
- `/mlx-stop` — stop server and clear active provider models

## Included presets

- `deepseek_r1_1_5b` — reasoning, math
- `gemma4_e2b` — writing, summarization
- `llama3_2_3b` — chat, rewriting
- `qwen3_4b` — coding, reasoning
- `smollm3_3b` — fast chat, quick drafts

> [!TIP]
> Want to try other models? Browse MLX Community collections on Hugging Face:  
> https://huggingface.co/mlx-community/collections

## Requirements

- macOS on Apple Silicon
- Python 3.11 or newer

## Configuration

Environment variables supported by the extension:

- `PI_MLX_MODELS_PORT` (default: `8080`)
- `PI_MLX_MODELS_HOST` (default: `127.0.0.1`)
- `PI_MLX_MODELS_BASE_URL` (default: `http://<host>:<port>/v1`)
- `PI_MLX_MODELS_DEFAULT_MODEL` (default: `mlx-community/Qwen3-4B-Instruct-2507-4bit`)

The default port changed in 0.2.0 from the previous Ollama default (`11434`); set `PI_MLX_MODELS_PORT` to keep any other port. An empty or invalid port value falls back to `8080` with a warning.

## Local data paths

The data directory follows pi's agent directory: `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. Runtime artifacts are stored under `pi-mlx-models` in it:

- `<agent dir>/pi-mlx-models/venv`
- `<agent dir>/pi-mlx-models/models`

With `PI_CODING_AGENT_DIR` unset these are `~/.pi/agent/pi-mlx-models/venv` and `~/.pi/agent/pi-mlx-models/models`.

## Development

```bash
npm install
npm run build
```

Pi package manifest is in `package.json`:

- `pi.extensions: ["dist/index.js"]`

## Screenshots

### Startup progress

![Startup progress](./assets/start-progress.png)

### Command menu

![Commands](./assets/commands.png)

### Model selection

![Model selection](./assets/model-selection.png)

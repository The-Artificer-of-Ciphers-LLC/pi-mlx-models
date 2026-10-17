# Commands reference

The three commands `@taoc/pi-mlx-models` adds to pi. Settings, flags and their precedence are in the [configuration reference](configuration.md).

## `/mlx-init`

```
/mlx-init
```

Creates or updates the local runtime: finds a Python 3.11 or newer interpreter, creates a virtual environment under `<agent dir>/pi-mlx-models/venv`, upgrades pip and installs or upgrades `mlx-lm`.

- Python is chosen from `PI_MLX_MODELS_PYTHON` when set, then from a list of common locations, then from `PATH`, newest version first.
- A virtual environment built on a Python older than 3.11 is recreated.
- It is refused while a start is in progress. Run `/mlx-stop` first.
- `/mlx-start` installs the runtime when it is missing, but never upgrades an existing one. Use `/mlx-init` to upgrade `mlx-lm`.

## `/mlx-start`

```
/mlx-start [model] [--flag value | --flag=value ...]
```

Starts the local MLX server for a model, waits until it answers a completion, and registers it with pi as the provider `pi-mlx-models`.

| Argument | Meaning |
|----------|---------|
| none | Opens a preset selector. If `--mlx-model` is set, that model starts without the selector. |
| a number from 1 to 5 | The preset at that position in the [preset list](#presets) |
| a preset key | For example `qwen3_4b` |
| a model id | Any Hugging Face model id, for example `mlx-community/Qwen3-4B-Instruct-2507-4bit`. It must not start with `-`. |

The flags, their syntax and their precedence are in the [configuration reference](configuration.md#mlx-start-arguments).

Before it starts anything, `/mlx-start` checks the arguments and the configuration. A problem is reported in one message and nothing is installed or started. It may then ask for confirmation of settings that [run code or open the network](configuration.md#settings-that-ask-for-permission).

Starting a model while another is running replaces the running server.

## `/mlx-stop`

```
/mlx-stop
```

Stops the server, waits for it to exit and for its port to be released, and removes the provider's models from pi. It also cancels a start that is still in progress.

Quitting pi stops the server too, waiting a few seconds for it to exit.

## Presets

| Number | Key | Model id | Good for |
|--------|-----|----------|----------|
| 1 | `deepseek_r1_1_5b` | `mlx-community/DeepSeek-R1-Distill-Qwen-1.5B-4bit` | reasoning, math |
| 2 | `gemma4_e2b` | `mlx-community/gemma-4-e2b-it-4bit` | writing, summarization |
| 3 | `llama3_2_3b` | `mlx-community/Llama-3.2-3B-Instruct-4bit` | chat, rewriting |
| 4 | `qwen3_4b` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | coding, reasoning |
| 5 | `smollm3_3b` | `mlx-community/SmolLM3-3B-4bit` | fast chat, quick drafts |

Other models: browse the [MLX Community collections](https://huggingface.co/mlx-community/collections) on Hugging Face and start one by its id.

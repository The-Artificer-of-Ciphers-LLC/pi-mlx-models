# Commands reference

The three commands `@taoc/pi-mlx-models` adds to pi. Settings, flags and their precedence are in the [configuration reference](configuration.md).

## `/mlx-init`

```
/mlx-init [--pip-index url] [--mlx-lm-version latest|X]
```

Creates or updates the local runtime: finds a Python 3.11 or newer interpreter, creates a virtual environment under `<agent dir>/pi-mlx-models/venv`, upgrades pip and installs mlx-lm.

| Flag | Meaning |
|------|---------|
| `--mlx-lm-version latest` | Install the newest mlx-lm, never below 0.24.0. This is the default. |
| `--mlx-lm-version X` | Install exactly version `X`, for example `0.32.2`, upgrading or downgrading as needed. |
| `--pip-index url` | Install from this package index instead of `https://pypi.org/simple/`. |

The flags apply to that run only. What `/mlx-init` installs is decided by the same layers as other settings: the flag, then the environment (`PI_MLX_MODELS_MLX_LM_VERSION`, `PI_MLX_MODELS_PIP_INDEX`), then the project file (version only), then the global file. The rules for both values are in [mlx-lm version and install source](configuration.md#mlx-lm-version-and-install-source).

- It reads the global file, the project file and the environment, and prints what it will install before it starts: `Installing mlx-lm latest (default) from https://pypi.org/simple/ (default)`. Each part names its source.
- It refuses, and installs nothing, when a file is invalid (an unrelated bad key also stops it), when the project file sets an option that runs code, opens the network or chooses the pip index, and while a start is in progress. For the last, run `/mlx-stop` first.
- A failure names the spec and the index, for example `Installing mlx-lm==0.31.1 from https://mirror.example/simple/ failed: ...`, followed by pip's own message.
- Python is chosen from `PI_MLX_MODELS_PYTHON` when set, then from a list of common locations, then from `PATH`, newest version first.
- A virtual environment built on a Python older than 3.11 is recreated.
- `/mlx-start` installs the runtime only when no working install exists, and then with the same index and version setting. It never upgrades or downgrades an existing install. When the installed version is not the pinned one, `/mlx-start` says so and launches what is installed. Use `/mlx-init` to apply the pin.

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

It can also show these warnings, described in the [configuration reference](configuration.md#what-a-start-shows): the installed mlx-lm is not the pinned version, a flag is skipped because the install does not support it, and, after the start message, quantized KV cache turns batching off.

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

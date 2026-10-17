# Configuration reference

Every setting `@taoc/pi-mlx-models` reads, where it can be set, and how the sources are combined. For instructions see [How to configure the MLX server](../how-to/configure-the-server.md). For the reasoning behind the design see [About layered configuration and trust](../explanation/layered-configuration-and-trust.md).

## Sources, from highest precedence to lowest

| # | Source | Applies to |
|---|--------|------------|
| 1 | Flags typed after `/mlx-start` | one launch |
| 2 | pi flags (`--mlx-*`) | the pi session |
| 3 | Environment variables (`PI_MLX_MODELS_*`) | the pi process |
| 4 | Project file `.pi/pi-mlx-models.json` | the project directory |
| 5 | Global file `config.json` | the user |
| 6 | Built-in default | |

The first source that sets a value wins. Each source is read at every `/mlx-start`, so an edit takes effect on the next start without reloading pi.

Environment variables and pi flags only exist for the connection settings listed below. Model options (`model` block and `models` entries) come from the two files and from `/mlx-start` flags; see [Model options](#model-options).

## Files

| File | Location |
|------|----------|
| Global | `<agent dir>/pi-mlx-models/config.json` |
| Project | `.pi/pi-mlx-models.json` in pi's working directory |

`<agent dir>` is `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. The project file is read from the working directory only, never from a parent directory.

A file that does not exist is ignored. A file that cannot be read, is larger than 256 KiB, is not a regular file, is not valid JSON, or is not a JSON object stops the start with a message that names the file.

Values in files are checked strictly: a number must be a JSON number, a boolean a JSON boolean. Nothing is converted.

### File layout

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8080,
    "allowedOrigins": ["http://localhost:3000"],
    "logLevel": "INFO",
    "trustRemoteCode": false
  },
  "model": {
    "adapterPath": "~/adapters/my-lora",
    "draftModel": "mlx-community/Qwen3-0.6B-4bit",
    "numDraftTokens": 4,
    "chatTemplate": "./templates/chat.jinja",
    "useDefaultChatTemplate": false,
    "chatTemplateArgs": { "enable_thinking": false }
  },
  "models": {
    "qwen3_4b": { "numDraftTokens": 2 }
  },
  "baseUrl": "http://127.0.0.1:8080/v1",
  "defaultModel": "qwen3_4b"
}
```

`baseUrl`, `defaultModel` and `models` are top-level keys. Every other key lives inside its block. An unknown key stops the start; the message names the key and the file layer.

## Settings

The **Flag** column is the `mlx_lm.server` flag the setting becomes. Host and port are always passed. Every other flag is passed only when some source sets it to something other than its default.

| Setting | Type and allowed values | Default | Flag | `/mlx-start` flag | pi flag | Environment variable |
|---------|-------------------------|---------|------|-------------------|---------|----------------------|
| `server.host` | host name or address, 1 to 253 characters from letters, digits and `. : _ - [ ]`, not starting with `-` | `127.0.0.1` | `--host` | `--host` | `--mlx-host` | `PI_MLX_MODELS_HOST` |
| `server.port` | integer 1 to 65535 | `8080` | `--port` | `--port` | `--mlx-port` | `PI_MLX_MODELS_PORT` |
| `server.allowedOrigins` | list of non-empty strings without commas or spaces | none | `--allowed-origins` | `--allowed-origins` (comma-separated) | | |
| `server.logLevel` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` | none | `--log-level` | `--log-level` | `--mlx-log-level` | |
| `server.trustRemoteCode` | `true` or `false` | `false` | `--trust-remote-code` | `--trust-remote-code` (no value) | | |
| `model.adapterPath` | non-empty path | none | `--adapter-path` | `--adapter-path` | | |
| `model.draftModel` | non-empty model id | none | `--draft-model` | `--draft-model` | | |
| `model.numDraftTokens` | integer of at least 1 | none | `--num-draft-tokens` | `--num-draft-tokens` | | |
| `model.chatTemplate` | path to a template file | none | `--chat-template` | `--chat-template` | | |
| `model.useDefaultChatTemplate` | `true` or `false` | `false` | `--use-default-chat-template` | `--use-default-chat-template` (no value) | | |
| `model.chatTemplateArgs` | JSON object | none | `--chat-template-args` | `--chat-template-args` (a JSON string) | | |
| `baseUrl` | `http` or `https` URL; a trailing slash is removed | `http://<host>:<port>/v1` | | | | `PI_MLX_MODELS_BASE_URL` |
| `defaultModel` | non-empty model id or preset key | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | | | | `PI_MLX_MODELS_DEFAULT_MODEL` |

A valued flag is passed to the server as one argument, `--flag=value`. The `--host` and `--port` pair keeps its two-argument form, so a launch that sets nothing has the same arguments as before configuration files existed.

`baseUrl` is where pi sends requests. When it does not match the launch host and port, a warning says which source set it.

`defaultModel` is used only when a start names no model at all. A bare `/mlx-start` always opens the preset picker, so in practice this setting has little effect.

### Environment variables

| Variable | Notes |
|----------|-------|
| `PI_MLX_MODELS_PORT` | A value that is not a whole number from 1 to 65535, including an empty value, is ignored with a warning. |
| `PI_MLX_MODELS_HOST` | An empty value counts as unset. |
| `PI_MLX_MODELS_BASE_URL` | An empty value counts as unset. |
| `PI_MLX_MODELS_DEFAULT_MODEL` | |
| `PI_MLX_MODELS_PYTHON` | Path to the Python interpreter used to build the virtual environment. Must be Python 3.11 or newer. If it is set but unusable, `/mlx-init` fails and names it instead of choosing another Python. |
| `PI_CODING_AGENT_DIR` | pi's agent directory. Sets where `pi-mlx-models` keeps its files. |

A bad value in a file, a pi flag or a `/mlx-start` flag stops the start. A bad value in an environment variable is ignored with a warning and the next source down is used.

## Model options

The `model` block and the `models` entries set options for the model being started. They are resolved after the model is chosen, from lowest to highest precedence:

1. Global file: `model`, then `models.<preset key>`, then `models.<model id>`
2. Project file: the same three, in the same order
3. `/mlx-start` flags

A `models` entry is keyed by a preset key (for example `qwen3_4b`) or by a full model id, and holds the same keys as the `model` block. A project `model` block beats a global `models` entry.

Values replace each other, except `chatTemplateArgs`: objects from different sources are merged key by key.

Paths: `~` is your home directory, and a relative path is relative to pi's working directory.

Limits:

- A chat template file must be a regular file of at most 64 KiB containing non-empty UTF-8 text. Its text, not its path, is passed to the server.
- `chatTemplateArgs` is at most 16 KiB, after merging.

## `/mlx-start` arguments

```
/mlx-start [model] [--flag value | --flag=value ...]
```

- `model` is a preset number (1 to 5), a preset key, or a full model id. A model id must not start with `-`.
- A valued flag takes the next word, unless that word starts with `--`. Use `--flag=value` for such a value.
- `--trust-remote-code` and `--use-default-chat-template` take no value.
- Single quotes are literal. Inside double quotes a backslash escapes a quote or a backslash. A quoted part joins the text next to it, so `--chat-template-args='{"a":1}'` is one word.
- A flag may appear once. An unknown flag, a missing value, a second model and an unterminated quote are errors.
- The whole argument string is limited to 8192 characters.
- Flags apply to that launch only; nothing is remembered.

## pi flags

Registered when the extension loads. Each is read at every start.

| Flag | Meaning |
|------|---------|
| `--mlx-model` | Model that a bare `/mlx-start` launches (preset number, preset key or model id). A model typed after `/mlx-start` wins. It never starts anything by itself. |
| `--mlx-port` | Port, 1 to 65535 |
| `--mlx-host` | Host or address |
| `--mlx-log-level` | `DEBUG`, `INFO`, `WARNING`, `ERROR` or `CRITICAL` |

## Settings that ask for permission

A loopback host is `127.0.0.1`, `localhost` or `::1`. Everything else is non-loopback, including `0.0.0.0` and `::`.

| Setting | In the project file | From any other source |
|---------|--------------------|-----------------------|
| `server.trustRemoteCode: true` | The start is refused. | Asks for confirmation. |
| `server.host` that is non-loopback | The start is refused. | Asks for confirmation. |
| `baseUrl` that is non-loopback | The start is refused. | Asks for confirmation. |

- A refused project file cannot be overridden, even when a higher source sets a different value, because the file is checked on its own content.
- A confirmation is asked at every start, one dialog per risk, and nothing is remembered. Declining cancels the start. The dialog shows which source set the value.
- With no interactive UI, a start that needs confirmation is refused.
- `trustRemoteCode` has no environment variable and no pi flag.

## Flags the installed mlx-lm does not support

When a launch uses any flag beyond host and port, the extension asks the installed mlx-lm which flags it supports, by running `python -m mlx_lm.server --help` in the virtual environment, with a 15 second limit. The answer is kept for the session, per mlx-lm version.

- A flag the install does not list is left out of the launch. One warning names each skipped flag and the mlx-lm version, and the start continues.
- If the check fails, a warning says so and every configured flag is passed.
- Host and port are never skipped. A launch that uses only host and port does not run the check.

## What a start shows

The start message lists every flag that differs from its default, with the source of each:

```
flags: --log-level INFO (global file), --num-draft-tokens 4 (project file)
```

Sources are named `global file`, `project file`, `/mlx-start`, `pi flag --mlx-port` and `env PI_MLX_MODELS_PORT`. A skipped flag is marked `skipped`.

A configuration problem is reported once, as one message that names every offending key, its source and what is allowed. Nothing is installed or started when that happens.

## Server process

The server is started with `PYTHONSAFEPATH=1`, so that the project directory is not searched for Python modules.

## Local data

| Path | Contents |
|------|----------|
| `<agent dir>/pi-mlx-models/venv` | Python virtual environment with mlx-lm |
| `<agent dir>/pi-mlx-models/models` | Downloaded model files |
| `<agent dir>/pi-mlx-models/config.json` | Global configuration file |

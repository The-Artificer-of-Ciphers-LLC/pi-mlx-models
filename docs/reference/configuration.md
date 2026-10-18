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

Environment variables and pi flags only exist for the settings that have such a column entry below. Model options (`model` block and `models` entries) come from the two files and from `/mlx-start` flags; see [Model options](#model-options). The `mlxLm` block is read by `/mlx-init` and `/mlx-start` and has its own flags and variables; see [mlx-lm version and install source](#mlx-lm-version-and-install-source).

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
    "trustRemoteCode": false,
    "decodeConcurrency": 4,
    "promptConcurrency": 4,
    "prefillStepSize": 2048,
    "promptCacheSize": 10,
    "promptCacheBytes": 8589934592,
    "kvBits": 4,
    "kvGroupSize": 64,
    "quantizedKvStart": 5000
  },
  "mlxLm": {
    "version": "0.32.2",
    "pipIndex": "https://mirror.example/simple/"
  },
  "model": {
    "adapterPath": "~/adapters/my-lora",
    "draftModel": "mlx-community/Qwen3-0.6B-4bit",
    "numDraftTokens": 4,
    "chatTemplate": "./templates/chat.jinja",
    "useDefaultChatTemplate": false,
    "chatTemplateArgs": { "enable_thinking": false },
    "sampling": { "temperature": 0.7, "maxTokens": 2048 }
  },
  "provider": {
    "listAllModels": false
  },
  "models": {
    "qwen3_4b": {
      "numDraftTokens": 2,
      "defaultProfile": "careful",
      "profiles": {
        "careful": {
          "sampling": { "temperature": 0.2, "topP": 0.9 },
          "chatTemplateArgs": { "enable_thinking": false },
          "limits": { "maxTokens": 4096 }
        }
      }
    }
  },
  "baseUrl": "http://127.0.0.1:8080/v1",
  "defaultModel": "qwen3_4b"
}
```

`baseUrl`, `defaultModel` and `models` are top-level keys. Every other key lives inside its block. `mlxLm` is a block like `server`: it holds `version` and `pipIndex`. `provider` is a block too: it holds `listAllModels`. An unknown key stops the start; the message names the key and the file layer.

## Settings

The **Flag** column is the `mlx_lm.server` flag the setting becomes. Host and port are always passed. Every other flag is passed only when some source sets it to something other than its default. A setting with no default is passed whenever a source sets it, even to the value mlx-lm uses itself.

| Setting | Type and allowed values | Default | Flag | `/mlx-start` flag | pi flag | Environment variable |
|---------|-------------------------|---------|------|-------------------|---------|----------------------|
| `server.host` | host name or address, 1 to 253 characters from letters, digits and `. : _ - [ ]`, not starting with `-` | `127.0.0.1` | `--host` | `--host` | `--mlx-host` | `PI_MLX_MODELS_HOST` |
| `server.port` | integer 1 to 65535 | `8080` | `--port` | `--port` | `--mlx-port` | `PI_MLX_MODELS_PORT` |
| `server.allowedOrigins` | list of non-empty strings without commas or spaces | none | `--allowed-origins` | `--allowed-origins` (comma-separated) | | |
| `server.logLevel` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` | none | `--log-level` | `--log-level` | `--mlx-log-level` | |
| `server.trustRemoteCode` | `true` or `false` | `false` | `--trust-remote-code` | `--trust-remote-code` (no value) | | |
| `server.decodeConcurrency` | integer of at least 1 | none | `--decode-concurrency` | `--decode-concurrency` | | |
| `server.promptConcurrency` | integer of at least 1 | none | `--prompt-concurrency` | `--prompt-concurrency` | | |
| `server.prefillStepSize` | integer of at least 1 | none | `--prefill-step-size` | `--prefill-step-size` | | |
| `server.promptCacheSize` | integer of at least 1 | none | `--prompt-cache-size` | `--prompt-cache-size` | | |
| `server.promptCacheBytes` | integer number of bytes, at least 1 | none | `--prompt-cache-bytes` | `--prompt-cache-bytes` | | |
| `server.kvBits` | integer from 2 to 8 | none | `--kv-bits` | `--kv-bits` | | |
| `server.kvGroupSize` | integer of at least 1 | none | `--kv-group-size` | `--kv-group-size` | | |
| `server.quantizedKvStart` | integer of at least 0 | none | `--quantized-kv-start` | `--quantized-kv-start` | | |
| `model.adapterPath` | non-empty path | none | `--adapter-path` | `--adapter-path` | | |
| `model.draftModel` | non-empty model id | none | `--draft-model` | `--draft-model` | | |
| `model.numDraftTokens` | integer of at least 1 | none | `--num-draft-tokens` | `--num-draft-tokens` | | |
| `model.chatTemplate` | path to a template file | none | `--chat-template` | `--chat-template` | | |
| `model.useDefaultChatTemplate` | `true` or `false` | `false` | `--use-default-chat-template` | `--use-default-chat-template` (no value) | | |
| `model.chatTemplateArgs` | JSON object | none | `--chat-template-args` | `--chat-template-args` (a JSON string) | | |
| `model.sampling.temperature` | number of at least 0 | none | `--temp` | | | |
| `model.sampling.topP` | number above 0 and at most 1 | none | `--top-p` | | | |
| `model.sampling.topK` | integer of at least 0 | none | `--top-k` | | | |
| `model.sampling.minP` | number from 0 to 1 | none | `--min-p` | | | |
| `model.sampling.repetitionPenalty` | number above 0 | none | none (request only) | | | |
| `model.sampling.maxTokens` | integer of at least 1 | none | `--max-tokens` | | | |
| `model.sampling.stop` | a non-empty string, or a list of 1 to 4 non-empty strings of at most 256 characters each | none | none (request only) | | | |
| `model.sampling.seed` | integer | none | none (request only) | | | |
| `model.limits.contextWindow` | integer of at least 1 | derived, see [Model metadata](#model-metadata-and-the-model-list) | none (tells pi only) | | | |
| `model.limits.maxTokens` | integer of at least 1 | derived, see [Model metadata](#model-metadata-and-the-model-list) | none (tells pi only) | | | |
| `model.limits.reasoning` | `true` or `false` | derived, see [Model metadata](#model-metadata-and-the-model-list) | none (tells pi only) | | | |
| `model.limits.input` | a list of `text` and `image` that includes `text` | `["text"]` | none (tells pi only) | | | |
| `provider.listAllModels` | `true` or `false` | `false` | none | | | |
| `baseUrl` | `http` or `https` URL; a trailing slash is removed | `http://<host>:<port>/v1` | | | | `PI_MLX_MODELS_BASE_URL` |
| `defaultModel` | non-empty model id or preset key | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | | | | `PI_MLX_MODELS_DEFAULT_MODEL` |
| `mlxLm.version` | the word `latest` or an exact version such as `0.32.2` | `latest` | | | | `PI_MLX_MODELS_MLX_LM_VERSION` |
| `mlxLm.pipIndex` | `https` URL without credentials, spaces, a query string or a fragment (`http` only for a loopback host) | `https://pypi.org/simple/` | | | | `PI_MLX_MODELS_PIP_INDEX` |

The eight `model.sampling.*` rows can only be set in a file, either in a `model` block, a `models` entry or a profile; they have no `/mlx-start` flag, pi flag or environment variable. See [Sampling and profiles](#sampling-and-profiles).

The four `model.limits.*` rows are written inside a profile only, as a `limits` object; they are not allowed in the `model` block or in a `models` entry, and they have no `/mlx-start` flag, pi flag or environment variable. They change what pi is told about a model and never reach the server's command line or a request. `provider.listAllModels` can only be set in a file, the global one or the project one, and has no flag or environment variable. See [Model metadata and the model list](#model-metadata-and-the-model-list).

The two `mlxLm` rows are settings of `/mlx-init`, not of the server. Their command-line forms are the `/mlx-init` flags `--mlx-lm-version` and `--pip-index`, not `/mlx-start` flags. They have no pi flag. When pi loads the extension these two settings are not looked at: a bad value does not change the provider URL or the default model, and only `/mlx-init` and `/mlx-start` report it.

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
| `PI_MLX_MODELS_MLX_LM_VERSION` | `latest` or an exact version. An invalid value is ignored with a warning. An empty value counts as unset. |
| `PI_MLX_MODELS_PIP_INDEX` | The pip index URL. An invalid value refuses `/mlx-init` and `/mlx-start` with an error, so an install never silently falls back to another index. When pi loads the extension this variable is not looked at, so a bad value does not change the provider URL or the default model. An empty value counts as unset. |
| `PI_MLX_MODELS_PYTHON` | Path to the Python interpreter used to build the virtual environment. Must be Python 3.11 or newer. If it is set but unusable, `/mlx-init` fails and names it instead of choosing another Python. |
| `PI_CODING_AGENT_DIR` | pi's agent directory. Sets where `pi-mlx-models` keeps its files. |

A bad value in a file, a pi flag or a `/mlx-start` flag stops the start. A bad value in an environment variable is ignored with a warning and the next source down is used. The exception is `PI_MLX_MODELS_PIP_INDEX`: a bad value refuses `/mlx-init` and `/mlx-start` instead.

#### Hugging Face variables

The extension also reads four variables that belong to Hugging Face, not to this package. They are used only to find a model's `config.json` (see [Context window](#context-window)). They have no `PI_MLX_MODELS_` form and no setting in a file.

| Variable | Notes |
|----------|-------|
| `HF_TOKEN` | Sent as a bearer token to the Hub when the cache has no `config.json`, for a gated or private repository. It is read from the environment only: no config key holds a token, nothing is written to a file, and it is never shown in a message. |
| `HF_HUB_OFFLINE` | `1`, `true`, `yes` or `on` (any letter case) stops the Hub request, so only the cache is used. Any other value, or none, allows it. |
| `HF_ENDPOINT` | The Hub's base URL. Used only when it is a plain `https` URL without credentials, a query string or a fragment; otherwise `https://huggingface.co` is used. |
| `HF_HUB_CACHE` | The cache directory looked in first. Default: `<agent dir>/pi-mlx-models/models/hub`. An empty value counts as unset. |

## Performance and KV cache options

Eight `server` keys tune throughput and memory. They have no default of their own and no environment variable or pi flag: a key that no source sets is not passed, and mlx-lm uses its own default. They are server-wide, not per model, and can be set in either file or typed after `/mlx-start` with the flag in the Flag column above.

| Key | mlx-lm's own default | First mlx-lm release with the flag |
|-----|----------------------|------------------------------------|
| `decodeConcurrency` | 32 | 0.30.6 |
| `promptConcurrency` | 8 | 0.30.6 |
| `prefillStepSize` | 2048 | 0.31.1 |
| `promptCacheSize` | 10 | 0.31.1 |
| `promptCacheBytes` | none (no byte limit) | 0.31.1 |
| `kvBits` | none (no quantization) | 0.32.0 |
| `kvGroupSize` | 64 | 0.32.0 |
| `quantizedKvStart` | 5000 | 0.32.0 |

mlx-lm 0.31.0 was yanked from PyPI because of a KV cache cross-contamination bug, so 0.31.1 is the first usable release for the prefill and prompt cache flags. An install that lacks a flag skips it with a notice; see [Flags the installed mlx-lm does not support](#flags-the-installed-mlx-lm-does-not-support).

Checks are sanity checks only: values are integers, at least 1 (`quantizedKvStart` at least 0), and `kvBits` is from 2 to 8. There is no upper bound, because mlx-lm decides what the hardware can take. `promptCacheBytes` is a plain integer number of bytes, for example `8589934592` for 8 GiB; size words such as `8GB` are not accepted.

### Quantized KV cache

Setting `kvBits` turns on KV cache quantization, which saves memory on long sessions. It disables batching in mlx-lm. Every start that passes `--kv-bits` shows one warning, with the value and the source:

```
KV quantization (--kv-bits 4, global file): Disables batching, so requests are served one at a time.
```

- `decodeConcurrency` or `promptConcurrency` above 1 together with `kvBits` still launches. The warning adds that they have no effect while `--kv-bits` is set, for example `--decode-concurrency 2 has no effect while --kv-bits is set.`
- `kvGroupSize` or `quantizedKvStart` without `kvBits` still launches. One info note says the flag has no effect without `--kv-bits`.

Limits that MLX enforces and the extension does not check:

- `kvBits` 7 is rejected by MLX.
- `kvGroupSize` must be 32, 64 or 128.
- Quantization starts only after `quantizedKvStart` tokens (5000 by default), so a bad pair of values fails on the first long prompt and not at launch. The server's own error is shown.

## mlx-lm version and install source

`/mlx-init` installs mlx-lm into the virtual environment. Two settings control what it installs and where from.

**`mlxLm.version`** is one of:

- `latest` (the default): `/mlx-init` installs the newest mlx-lm, never below 0.24.0.
- An exact version such as `0.32.2`: `/mlx-init` installs exactly that version, upgrading or downgrading as needed.

Nothing else is accepted: no ranges, no specifiers such as `>=`, no URLs. The project file may set `mlxLm.version`.

**`mlxLm.pipIndex`** is the package index pip installs from.

- It must be an `https` URL, or `http` for `127.0.0.1`, `localhost` or `[::1]`. It must contain no whitespace and no credentials; use pip's netrc file or keyring for those. It has no query string or fragment, because either can carry a token that would then show in the install line and in failure texts. For `http` the host must be written as `127.0.0.1`, `localhost` or `[::1]` (any letter case, any port), so spellings such as `127.1`, `0x7f.1` or a decimal number are refused.
- It is passed to pip as `--index-url=VALUE` in both pip steps, the pip upgrade and the mlx-lm install. The index must therefore carry `pip` itself.
- Only `--index-url` is passed. pip's own environment and configuration, for example `PIP_EXTRA_INDEX_URL`, still apply.
- In a refused value everything from the end of the scheme up to the last `@` is replaced by `***`, whatever it contains (`/`, `?`, `#` or a space). The same is done for a stray URL typed after `/mlx-init` or `/mlx-start`. A path that contains `@` may be hidden too. A query string is refused, not hidden: it is shown once as typed, clipped to 60 characters, in the refusal.
- Only the plain `http://` or `https://` spelling is accepted: a backslash, a single slash after the scheme and an escaped character in the host are refused, because pip reads them differently from the check.
- It can be set in the global file, by `PI_MLX_MODELS_PIP_INDEX` or by `/mlx-init --pip-index`. A project file cannot set it; see [Settings that ask for permission](#settings-that-ask-for-permission).

Only `/mlx-init` changes the installed mlx-lm. `/mlx-start` never upgrades or downgrades, and runs pip only when there is no working install at all. In that case it uses the same index and pin as `/mlx-init`, so a configured mirror applies on the first launch.

A yanked release such as 0.31.0 can still be pinned: pip installs an exact pin to a yanked file and prints the reason.

### When the pin and the install differ

- If an exact pin is set and the installed mlx-lm is another version, every `/mlx-start` shows one warning before the start message and launches what is installed:

  ```
  mlx-lm pinned 0.31.1 (project file), installed 0.32.2; run /mlx-init to apply
  ```

  The part in parentheses names the source of the pin and is left out when none is known. `0.32` and `0.32.0` count as the same version. With `latest` the installed version is not queried and nothing is shown.
- If an exact pin is set and the installed version cannot be read, a warning names the pin and the reason, and the start goes on with what is installed:

  ```
  mlx-lm pinned 0.31.1 (project file) was not compared with the installed version: REASON
  ```

- A flag that is newer than a pinned version is skipped by the usual check. The notice then names the pin: `mlx-lm is pinned to 0.31.1 by project file; raise or remove the pin, then run /mlx-init`.

## Model options

The `model` block and the `models` entries set options for the model being started. They are resolved after the model is chosen, from lowest to highest precedence:

1. Global file: `model`, then `models.<preset key>`, then `models.<model id>`
2. Project file: the same three, in the same order
3. The selected profile, if any: the global file's, then the project file's, key by key (see [Sampling and profiles](#sampling-and-profiles))
4. `/mlx-start` flags

A `models` entry is keyed by a preset key (for example `qwen3_4b`) or by a full model id, and holds the same keys as the `model` block, plus `sampling`, `profiles` and `defaultProfile`. A project `model` block beats a global `models` entry.

Values replace each other, except `chatTemplateArgs` and `sampling`: objects from different sources are merged key by key. A `sampling.stop` list is a single value and replaces a lower source's list whole.

Paths: `~` is your home directory, and a relative path is relative to pi's working directory.

Limits:

- A chat template file must be a regular file of at most 64 KiB containing non-empty UTF-8 text. Its text, not its path, is passed to the server.
- `chatTemplateArgs` is at most 16 KiB, after merging.

## Sampling and profiles

Sampling settings and named profiles set how a model answers. A step-by-step guide is in [How to use profiles and sampling](../how-to/use-profiles-and-sampling.md).

### Sampling

The `sampling` object holds eight keys. It is a per-model option: it can be set in the `model` block, in a `models` entry or in a profile.

| Key | OpenAI request field | Server flag |
|-----|----------------------|-------------|
| `temperature` | `temperature` | `--temp` |
| `topP` | `top_p` | `--top-p` |
| `topK` | `top_k` | `--top-k` |
| `minP` | `min_p` | `--min-p` |
| `repetitionPenalty` | `repetition_penalty` | none |
| `maxTokens` | `max_completion_tokens` (and `max_tokens` when pi sent that name) | `--max-tokens` |
| `stop` | `stop` | none |
| `seed` | `seed` | none |

- One value feeds both places. A key that has a server flag is passed to the server as the launch default and is also written into the requests pi sends to that server. `repetitionPenalty`, `stop` and `seed` have no server flag, so they only reach requests; the start message lists them on the `request:` line.
- A server flag that the installed mlx-lm lacks is skipped with the usual notice (see [Flags the installed mlx-lm does not support](#flags-the-installed-mlx-lm-does-not-support)). The request value still applies.
- Sampling is merged in this order, lowest first: the `model` block, the `models` entry, the profile. Each layer is merged key by key, and a `stop` list replaces the lower list whole.

### Profiles

A profile is a named set of per-model options for one model.

- **Where.** A profile lives in the `profiles` object of a `models` entry, keyed by a preset key or a model id, in either file. It is not allowed in the `model` block. A profile is reachable only for the model of its entry. When a preset key entry and a model id entry both define the same profile name, the two are merged key by key, and the model id entry's value wins for a key both set. A key only the preset key entry sets is kept. The same merge applies across the global and project files, where the project file's value wins.
- **What it may hold.** The keys of the `model` block (`adapterPath`, `draftModel`, `numDraftTokens`, `chatTemplate`, `useDefaultChatTemplate`, `chatTemplateArgs`), a `sampling` object, and a `limits` object. Each profile is flat.
- **What it may not hold.** Every `server` key (`port`, `host`, `logLevel`, `allowedOrigins`, `trustRemoteCode`, the concurrency, cache and KV cache keys), a nested `profiles` object, and `extends`. Any key inside `limits` other than the four listed below is refused too. The start is refused with a message that names the key and the file.
- **limits.** Every profile may carry an optional flat `limits` object with up to four keys: `contextWindow`, `maxTokens`, `reasoning` and `input`. They set what pi is told about the model and are described in [Model metadata and the model list](#model-metadata-and-the-model-list). `limits` anywhere other than inside a profile is an unknown key; in the `model` block or a `models` entry the message says it belongs inside a profile.
- **Names.** 1 to 64 characters: letters, digits, `.`, `_` and `-`, starting with a letter or digit.

Choosing a profile:

- `/mlx-start MODEL --profile NAME` uses the profile for that launch only.
- `defaultProfile` in a `models` entry names the profile used when `--profile` is not given. With neither, no profile is used and the launch is as before.
- Naming a profile that the model does not have stops the start before anything is installed or started, and lists the model's profiles in sorted order:

  ```
  profile "nope" (/mlx-start --profile): not defined for mlx-community/Qwen3-4B-Instruct-2507-4bit; available profiles: careful, wild
  ```

- A `defaultProfile` is checked only when it is used. A `defaultProfile` that names a missing profile does not affect a launch of another model, and does not affect a launch that picks another profile with `--profile`.

Layering, from highest precedence to lowest, per key:

1. Flags typed after `/mlx-start`
2. The selected profile. When both files define it, the project file's value beats the global file's, key by key.
3. Project file settings (`model`, then the `models` entries)
4. Global file settings (the same)

A project file may define profiles under the same rules as its `model` block: a `chatTemplate` in a project profile must point inside the project directory, and a profile cannot hold the settings that ask for permission (see [Settings that ask for permission](#settings-that-ask-for-permission)), because those are `server` keys. Choosing a profile adds no confirmation dialog.

### Request settings

pi sends each request to the launched model itself. A hook changes that request before it is sent.

- **Fields written.** `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `stop`, `seed`, the output limit as `max_completion_tokens` (and also `max_tokens` when pi sent a field of that name), and `chat_template_kwargs`.
- **Configured values win.** A configured value overwrites the same field of pi's request. A field that no source sets is left as pi sent it.
- **One source of chat template arguments.** When the merged `chatTemplateArgs` is not empty, the hook replaces pi's `chat_template_kwargs` with them (it does not merge) and removes pi's `reasoning_effort`, so that exactly one setting about thinking remains. When no `chatTemplateArgs` is configured, pi's `chat_template_kwargs` and `reasoning_effort` are not touched. The same object is also passed to the server as `--chat-template-args` at launch.
- **What the hook leaves alone.** Requests to any provider other than `pi-mlx-models`, requests for a model id other than the launched one (for example after switching with `/model`), and every request while no launch has been made in this session (a server started elsewhere, or after `/mlx-stop` or when the session ends). Requests made while a new `/mlx-start` is still starting are also left alone, because the values of the previous launch end when the new start begins. A request for this provider whose model id is not the launched one is left unchanged, and a warning that names the launched model id is shown once per session, because the profile and sampling settings did not reach the server.
- **When values are read.** The values come from the launch made in this session and are held in memory. Nothing is saved between sessions, and the config files are not read for each request: an edit applies from the next `/mlx-start`.
- **Unexpected shape.** A request that is not an object with a `messages` list is left unchanged. One warning per session says so.

To check what the server receives, set `server.logLevel` to `DEBUG`; see [How to use profiles and sampling](../how-to/use-profiles-and-sampling.md#check-what-the-server-receives).

> Changed in this release: `model.chatTemplateArgs` set in a config file used to reach the server only as the `--chat-template-args` launch flag. They are now also sent with every request to the launched model, replacing pi's `chat_template_kwargs` and removing pi's `reasoning_effort`.

## Model metadata and the model list

pi needs four facts about each model it lists: the context window, the output limit, whether the model reasons, and which kinds of input it takes. A step-by-step guide is in [How to set a model's context window, thinking flag and output limit](../how-to/set-model-limits.md).

### What pi is told about a model

| Value | Where it comes from | Default | Override (inside a profile) |
|-------|---------------------|---------|-----------------------------|
| Context window | The model's own `config.json`; see [Context window](#context-window) | 32768 when it cannot be read | `limits.contextWindow` |
| Output limit | A quarter of the context window, at most 8192 (32768 for a reasoning model), at least 1; see [Output limit](#output-limit) | as described | `limits.maxTokens` |
| Reasoning | The preset's flag, else a short list of names; see [Reasoning](#reasoning) | no | `limits.reasoning` |
| Input | Text for every model; see [Image input](#image-input) | `["text"]` | `limits.input` |

A value from `limits` always wins over what is detected. The values are held for the launched model and are worked out at every `/mlx-start`, so an edit applies from the next start. Each start shows them on a `model:` line; see [What a start shows](#what-a-start-shows).

### Context window

The window is the value of `max_position_embeddings` in the model's `config.json`. A `text_config.max_position_embeddings` that is a positive integer is used first, because multimodal models such as gemma-4 and KAT-Coder keep the value there and have none at the top level. Otherwise the top-level value is used. A value that is missing, not an integer, zero or negative counts as unreadable.

Where the file is looked for, in order:

1. **The Hugging Face cache.** The directory is `HF_HUB_CACHE` when set, otherwise `<agent dir>/pi-mlx-models/models/hub`, which is where the server's downloads go. A model `ORG/NAME` is `models--ORG--NAME/snapshots/REVISION/config.json` there. `REVISION` is the one named by `refs/main`; when that is missing or has no file, the newest snapshot that holds a `config.json`. A model given as an absolute path, or starting with `./` or `../`, is read from `config.json` in that directory.
2. **The Hub.** Only for the launched model, only when the cache has no copy, and only after the server has started, when the model has normally been downloaded already. The request is `GET https://huggingface.co/ORG/NAME/resolve/main/config.json` (`HF_ENDPOINT` changes the host). `HF_TOKEN` is sent as a bearer token to that host only, so a gated repository can be read. The request, any redirects (at most three, never from `https` to `http`) and the body share a limit of 3000 ms, and the body may be at most 2 MiB. `HF_HUB_OFFLINE` set to a true value stops the request. See [Hugging Face variables](#hugging-face-variables).

A `config.json` must be a regular file of at most 2 MiB holding a JSON object. The other models listed when `provider.listAllModels` is `true` are read from the cache only; the Hub is never asked for them.

When no window can be read, the model still starts and is registered with **32768**. One warning says why, once for each model and reason while pi runs:

```
context window unavailable for mlx-community/SmolLM3-3B-4bit (not in the local cache; the Hugging Face Hub could not be reached); using 32768
```

The text in parentheses is one of a small set of reasons, such as `not in the Hugging Face cache`, `not in the local cache; ...` followed by what the Hub answered, `config.json is not valid JSON`, `config.json is larger than 2 MiB`, `config.json has no usable max_position_embeddings`, or `not a Hugging Face repository id or an absolute path`. It never holds a path, a token or file text.

`limits.contextWindow` sets the window by hand. It replaces whatever `config.json` says and skips the read: nothing is looked up, no Hub request is made and no notice is shown. Use it when the file cannot be read, or when the window you can use differs from the file. A model extended by rope scaling can declare a smaller `max_position_embeddings` than it handles.

The windows of the cached presets and KAT-Coder:

| Model | Context window | Where |
|-------|----------------|-------|
| `mlx-community/Qwen3-4B-Instruct-2507-4bit` | 262144 | top level |
| `mlx-community/SmolLM3-3B-4bit` | 65536 | top level |
| `mlx-community/gemma-4-e2b-it-4bit` | 131072 | `text_config` |
| `mlx-community/Llama-3.2-3B-Instruct-4bit` | 131072 | top level |
| `mlx-community/DeepSeek-R1-Distill-Qwen-1.5B-4bit` | 131072 | top level |
| `mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit` | 262144 | `text_config` |

### Reasoning

Whether a model reasons is decided in this order:

1. `limits.reasoning` in the profile, `true` or `false`.
2. The preset's flag, when the model id is a preset's. Only the DeepSeek-R1 distill preset reasons.
3. The model's name. The last part of the id (after the final `/`) is lower-cased and split on every run of characters that is not a letter or a digit. The model reasons when one of the pieces is exactly `r1`, `qwq`, `thinking`, `reasoning`, `reasoner` or `magistral`. The organisation never counts, and neither does a word that only contains one of these.
4. Otherwise no.

The chat template is not consulted: a template can mention thinking for a model that does not think. `mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit` is not on the list and is not detected; it is the example for `limits.reasoning`.

A model flagged as reasoning is registered as `reasoning`, with compat flags that make pi send neither the `developer` role nor `reasoning_effort`, because mlx-lm chat templates reject both. pi's thinking-level selector therefore appears but sends nothing. `chatTemplateArgs` with `enable_thinking` is the only lever on whether the model thinks.

### Image input

Every model is registered as text only, the gemma-4 preset included. Nothing is detected automatically. `limits.input` replaces the list: a non-empty list of `text` and `image` that includes `text`; a repeated entry is collapsed. It tells pi to offer images and nothing more; the model and the server have to handle them.

### Output limit

The output limit is the most a reply may be, as pi is told. Unless `limits.maxTokens` sets it, it is the smaller of 8192 (32768 for a reasoning model) and a quarter of the context window, and at least 1.

| Model | Output limit |
|-------|--------------|
| Qwen3, SmolLM3, gemma-4, Llama-3.2 | 8192 |
| DeepSeek-R1 distill (reasoning) | 32768 |
| Any model whose window fell back to 32768 | 8192 |

`limits.maxTokens` is a whole number of at least 1. pi asks the server for at most that many tokens per reply, and sizes its context for it, unless `sampling.maxTokens` overwrites the value in the request.

`limits.maxTokens` and `sampling.maxTokens` are separate. The first is what pi is told; the second is what the server and the requests carry (`--max-tokens` and `max_completion_tokens`). A profile with only `limits.maxTokens` adds no `--max-tokens` and changes no request. When `sampling.maxTokens` is above the output limit pi is told about, every start shows one warning that names both numbers and the source of the limit:

```
sampling.maxTokens 20000 is above the output limit pi is told about, 8192 (default); pi sizes its context for 8192. Set limits.maxTokens in the profile to match.
```

### Thinking tokens

mlx-lm 0.32.2 and its main branch have no thinking-budget parameter, and every upstream proposal for one is closed and unmerged. One cap covers the thinking and the answer together: the request's `max_completion_tokens`, else `max_tokens`, else the server's `--max-tokens`, which is 512 by default. A long thought can use all of it. The levers are:

- `limits.maxTokens`, what pi is told and so what it asks for.
- `sampling.maxTokens`, what the server and the requests carry.
- `chatTemplateArgs` with `enable_thinking`, for a model whose chat template reads it.

The extension sends configured `chatTemplateArgs` with every request to the launched model, as well as at launch (see [Request settings](#request-settings)). An open mlx-lm report, issue 1803, says per-request `chat_template_kwargs` may bypass the prompt cache. It is unconfirmed: one commenter could not reproduce it.

### Which models pi lists

By default pi lists only the model that is loaded. Before the first `/mlx-start` the list is empty, and `/mlx-stop` and the end of the session leave it empty again; each registers an empty list.

`provider.listAllModels` set to `true` lists every model the server reports, each with its own metadata. The loaded model keeps the values from its start. The others are read from the cache only, and one warning gives the count of those that fell back to 32768 and the first reason, without their ids:

```
context window unavailable for 2 other listed models (not in the Hugging Face cache); using 32768 for them
```

The key can be set in the global file or the project file. It is read at every `/mlx-start`; when pi loads, only the global file and the environment are looked at.

A server you started yourself, reached through `PI_MLX_MODELS_BASE_URL` or `baseUrl`, is not started by `/mlx-start`, so nothing is loaded and the default list is empty. Set `provider.listAllModels` to `true` to list its models.

## `/mlx-init` arguments

```
/mlx-init [--pip-index url] [--mlx-lm-version latest|X]
```

- `--pip-index` and `--mlx-lm-version` are the only flags. There is no model word. Each takes a value, as the next word or as `--flag=value`, and the tokenizer rules are those of `/mlx-start`.
- They apply to that run only; nothing is remembered. A flag beats the environment variable and both files.
- `/mlx-init` reads the global file, the project file and the environment, like `/mlx-start`. It refuses on an invalid file or on a project file that asks for something it may not, so an unrelated bad key also stops it. Nothing is installed in that case.

## `/mlx-start` arguments

```
/mlx-start [model] [--profile name] [--flag value | --flag=value ...]
```

- `model` is a preset number (1 to 5), a preset key, or a full model id. A model id must not start with `-`.
- A valued flag takes the next word, unless that word starts with `--`. Use `--flag=value` for such a value.
- `--trust-remote-code` and `--use-default-chat-template` take no value.
- The performance and KV cache flags (`--decode-concurrency`, `--prompt-concurrency`, `--prefill-step-size`, `--prompt-cache-size`, `--prompt-cache-bytes`, `--kv-bits`, `--kv-group-size`, `--quantized-kv-start`) take a whole number.
- `--profile NAME` takes a value, may appear once and may not be empty. It selects a profile of the model for that launch; see [Profiles](#profiles).
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
| `mlxLm.pipIndex` | `/mlx-init` and `/mlx-start` are refused. | Accepted without a dialog from the global file, the environment or the `/mlx-init` flag. |

- A refused project file cannot be overridden, even when a higher source sets a different value, because the file is checked on its own content.
- A confirmation is asked at every start, one dialog per risk, and nothing is remembered. Declining cancels the start. The dialog shows which source set the value.
- With no interactive UI, a start that needs confirmation is refused.
- `trustRemoteCode` has no environment variable and no pi flag.
- The pip index decides which code `pip install` fetches, so a project file may not choose it. From your own sources it applies without confirmation, and `/mlx-init` always shows it. A project file may pin `mlxLm.version`.

## Flags the installed mlx-lm does not support

When a launch uses any flag beyond host and port, the extension asks the installed mlx-lm which flags it supports, by running `python -m mlx_lm.server --help` in the virtual environment, with a 15 second limit. The answer is kept for the session, per mlx-lm version.

- A flag the install does not list is left out of the launch. One warning names each skipped flag and the mlx-lm version, and the start continues. The warning ends with `(run /mlx-init to upgrade)`. When an exact `mlxLm.version` is set it ends with `(mlx-lm is pinned to X by SOURCE; raise or remove the pin, then run /mlx-init)` instead, because upgrading is not what a pinned install needs.
- If the check fails, a warning says so and every configured flag is passed.
- Host and port are never skipped. A launch that uses only host and port does not run the check.

## What a start shows

The start message lists every flag that differs from its default, with the source of each:

```
flags: --log-level INFO (global file), --num-draft-tokens 4 (project file)
```

Sources are named `global file`, `project file`, `/mlx-start`, `pi flag --mlx-port` and `env PI_MLX_MODELS_PORT`. A value that comes from a profile is labelled `profile NAME`. A skipped flag is marked `skipped`.

A launch that uses a profile adds a `profile:` line before the flags, naming the profile and where it was chosen. A launch that has request-only sampling values (`repetitionPenalty`, `stop`, `seed`) adds a `request:` line after the flags, because those values never reach the server's command line:

```
Starting MLX server with mlx-community/Qwen3-4B-Instruct-2507-4bit (preset: qwen3_4b)...
profile: careful (global file)
flags: --port 8080 (global file), --temp 0.2 (profile careful), --top-p 0.9 (profile careful)
request: repetition_penalty 1.1 (profile careful), stop ["###"] (profile careful), seed 42 (profile careful)
```

The place after `profile:` is `/mlx-start` when `--profile` chose it, otherwise the layer of the `defaultProfile` key (`global file` or `project file`). A launch with no profile and no request-only value shows neither line, and its message is unchanged.

Before the start message, a start can show a [pin warning](#when-the-pin-and-the-install-differ) (the pin differs from the install, or the installed version could not be read) and the [skipped-flag warning](#flags-the-installed-mlx-lm-does-not-support). After it, a launch with `kvBits` shows the [batching warning](#quantized-kv-cache), and a launch with `kvGroupSize` or `quantizedKvStart` but no `kvBits` shows the no-effect note. These are shown on every start, not once.

A configuration problem is reported once, as one message that names every offending key, its source and what is allowed. Nothing is installed or started when that happens.

### The model line and the metadata warnings

Once the server is ready and the provider is registered, a start shows what pi was told about the model. These messages come after the start message and before the ready message, in this order:

1. When `provider.listAllModels` is `true`, one warning for the other listed models that fell back, such as `context window unavailable for 2 other listed models (...); using 32768 for them`.
2. A warning when the launched model's context window could not be read, for example `context window unavailable for mlx-community/SmolLM3-3B-4bit (...); using 32768`. Warnings 1 and 2 are shown once for each text while pi runs. A profile that sets `limits.contextWindow` never shows warning 2.
3. A warning when `sampling.maxTokens` is above the output limit pi is told about. It is shown on every start that has the condition.
4. The `model:` line, with each value and its source:

   ```
   model: context 262144 (config.json), max output 8192 (default), reasoning no (preset), input text (default)
   ```

   The source is `config.json`, `fallback`, `default`, `preset`, `model name` or `profile NAME`. The rules behind each value are in [Model metadata and the model list](#model-metadata-and-the-model-list).

## Server process

The server is started with `PYTHONSAFEPATH=1`, so that the project directory is not searched for Python modules.

## Local data

| Path | Contents |
|------|----------|
| `<agent dir>/pi-mlx-models/venv` | Python virtual environment with mlx-lm |
| `<agent dir>/pi-mlx-models/models` | Downloaded model files |
| `<agent dir>/pi-mlx-models/models/hub` | The Hugging Face cache the server writes to, and where each model's `config.json` is looked for first (`HF_HUB_CACHE` replaces this path for the lookup) |
| `<agent dir>/pi-mlx-models/config.json` | Global configuration file |

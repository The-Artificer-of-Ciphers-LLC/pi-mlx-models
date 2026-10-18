# Changelog

All notable changes to `@taoc/pi-mlx-models` are listed here. Releases before 0.2.0 were published as `pi-mlx-models`; see the [tags](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/tags) for their code.

## Unreleased

### Added

- **Performance options.** `server.decodeConcurrency`, `server.promptConcurrency`, `server.prefillStepSize`, `server.promptCacheSize` and `server.promptCacheBytes`, each also a `/mlx-start` flag. The concurrency flags need mlx-lm 0.30.6 and the other three 0.31.1; an older install skips them with a warning.
- **KV cache quantization.** `server.kvBits`, `server.kvGroupSize` and `server.quantizedKvStart`, which need mlx-lm 0.32.0. A launch with `kvBits` warns that it disables batching, and says when concurrency settings then have no effect.
- **mlx-lm version policy.** `mlxLm.version` is `latest` or an exact version, set in either file, by `PI_MLX_MODELS_MLX_LM_VERSION` or by `/mlx-init --mlx-lm-version`. `/mlx-init` installs exactly the pinned version. When the installed mlx-lm differs from the pin, `/mlx-start` warns and launches what is installed.
- **Pip index.** `mlxLm.pipIndex`, `PI_MLX_MODELS_PIP_INDEX` and `/mlx-init --pip-index` install mlx-lm from another index. It is user-level only: a project file that sets it is refused.
- **Named profiles.** A `models` entry can hold `profiles`, each a set of per-model options and sampling values, and a `defaultProfile`. `/mlx-start MODEL --profile NAME` uses a profile for that launch. A missing profile name stops the start and lists the model's profiles. Server-wide keys are not allowed in a profile, and a project file's profiles follow the same rules as its `model` block.
- **Sampling.** A `sampling` object (`temperature`, `topP`, `topK`, `minP`, `repetitionPenalty`, `maxTokens`, `stop`, `seed`) in the `model` block, a `models` entry or a profile. `temperature`, `topP`, `topK`, `minP` and `maxTokens` are also passed to the server as `--temp`, `--top-p`, `--top-k`, `--min-p` and `--max-tokens`.
- **Sampling in requests.** The values are written into the requests pi sends to the launched model, so a configured value replaces pi's own. Requests to other providers or other models are not changed.
- **Start message.** A launch with a profile shows a `profile:` line, flags from a profile are labelled `(profile NAME)`, and sampling values that have no server flag are listed on a `request:` line.
- **Profile limits.** A profile's `limits` object accepts `contextWindow`, `maxTokens`, `reasoning` and `input`. Each replaces what pi is told about the model and always wins over detection and presets. `limits.maxTokens` is the output limit pi is told about; `sampling.maxTokens` is still the number the server and the requests carry. The keys are allowed inside a profile only. See [How to set a model's context window, thinking flag and output limit](docs/how-to/set-model-limits.md).
- **Model metadata.** pi is told each model's context window from its own `config.json`: the Hugging Face cache first, then the Hub (`HF_TOKEN`, `HF_HUB_OFFLINE` and `HF_ENDPOINT` apply), and `text_config.max_position_embeddings` before the top-level value. A model whose file cannot be read starts with 32768 and one warning that says why; `limits.contextWindow` sets the window by hand and skips the read.
- **Reasoning flag.** The presets say whether they reason, and any other model is flagged as reasoning when the last part of its id holds a whole token from a short list (`r1`, `qwq`, `thinking`, `reasoning`, `reasoner`, `magistral`). `limits.reasoning` overrides either answer. A reasoning model is registered with compat flags so pi sends neither the `developer` role nor `reasoning_effort`.
- **Image input.** Every model is registered as text only, including the gemma-4 preset. `limits.input` with `text` and `image` opts a model in; nothing is detected automatically.
- **Output limit.** The output limit pi is told about is a quarter of the context window, at most 8192, or 32768 for a reasoning model, and `limits.maxTokens` sets it. A `sampling.maxTokens` above that limit shows a warning on every start.
- **Model list.** `provider.listAllModels` (global or project file) lists every model the server reports, each with its own metadata read from the local cache.
- **Start message.** A `model:` line shows the context window, output limit, reasoning flag and input kinds pi was told, each with its source.
- **Model selection after a start.** When `/mlx-start` finishes, pi selects the started model for the session and the ready message says so. It does not switch when the start was stopped or replaced, when a model was picked in pi during the start, or when pi does not list or refuses the model; the ready message then still says to use `/model`.
- **`/mlx-last`.** Starts the model and the profile of the last successful start with no preset selector, also after pi was closed and opened again. Every successful start is remembered in `last-launch.json`, which holds the model id and the profile that applied and nothing else. `--profile` and the `/mlx-start` flags can be typed after `/mlx-last`; they apply to that launch only and are never remembered. It reads the configuration as it is now. It starts nothing and says why when nothing is remembered, when the remembered file cannot be read, or when the remembered profile is no longer defined for the model. See the [commands reference](docs/reference/commands.md#mlx-last).
- **`/mlx-status`.** One notice with the health (`ready`, `loading`, `down`, or `not answering` for a server this session did not start) and, for a launch of this session, the `profile:`, `flags:` and `request:` lines of the start message and the `model:` line. pi shows the `model:` line only once, when the start finishes, and `/mlx-status` repeats it. A server this session did not start is shown with its port, health and model ids, and its profile and flags as unknown.
- **`/mlx-restart`.** Starts the model of the running launch again with the same profile selection, through the configuration files as they are now. Flags typed after it apply to that restart only. The confirmations for settings that run code or open the network are asked again, and the arguments, the configuration and the confirmations are checked before the running server is touched. With nothing running it starts the remembered launch and says so.
- **`/mlx-config`.** A menu to view and edit the global config file without leaving pi: every setting, and profiles (add, edit a key, delete, choose the default). Each edit is checked as a hand-edited file is checked and written in one atomic step. Settings that run code, open the network, choose the pip index or start a model at startup ask for confirmation before they are saved. It edits the global file only and is read-only without an interactive UI. It never restarts anything; the notice for a saved edit points to `/mlx-restart` when a server is running.
- **Auto-start.** `autoStart` in the global file, or `PI_MLX_MODELS_AUTO_START`, starts the remembered model in the background when pi opens a session. It is off by default. It does nothing when nothing is remembered, and when something already answers on the port it shows one notice and leaves that server alone. It never confirms a trust setting for you, installs nothing, and does not change the selected model: the ready message tells you to pick the model with `/model`. A launch that needs a confirmation is skipped with a notice that points to `/mlx-start`. See [Auto-start](docs/reference/configuration.md#auto-start).

### Changed

- **pi now lists only the loaded model by default.** Before, it listed every model the server reported. The list is empty before the first `/mlx-start` and after `/mlx-stop`. Set `provider.listAllModels` to `true` to list every model. If you use a server you started yourself through `PI_MLX_MODELS_BASE_URL` or `baseUrl`, set it to `true` or pi shows no model until a first start.
- **The context window and output limit are no longer 128000 and 8192 for every model.** pi is told the model's own window, a quarter of it as the default output limit (at most 8192, or 32768 for a reasoning model), and 32768 when the window cannot be read. A model with a short window now gets a smaller limit than before; set `limits.contextWindow` or `limits.maxTokens` in a profile to change either.
- The DeepSeek-R1 distill preset is now flagged as a reasoning model, with the compat flags above and a 32768 output limit.
- The reserved empty `limits` object of a profile now has four keys. A `limits` key in the `model` block or a `models` entry is refused with a message that says it belongs inside a profile.

- `model.chatTemplateArgs` set in config are now also sent with every request to the launched model, replacing pi's `chat_template_kwargs` and removing pi's `reasoning_effort`. Before, they reached the server only as the `--chat-template-args` launch flag. pi's own thinking setting no longer conflicts with a configured value.
- `/mlx-init` now reads the layered configuration and refuses to run on an invalid file or on a project file that asks for something it may not.
- `/mlx-start`'s first install, when there is no virtual environment yet, uses the configured index and version. An existing install still makes no network call.
- The notice for a skipped flag names the pin when one is set: `mlx-lm is pinned to X by SOURCE; raise or remove the pin, then run /mlx-init`.
- pip is now passed the index as one `--index-url=` argument, and its failures name the spec and the index. The index stays in the progress line while pip prints.
- An invalid `PI_MLX_MODELS_PIP_INDEX` refuses `/mlx-init` and `/mlx-start` instead of installing from the default index. A refused index never shows its user name or password, and only the plain `http(s)://` spelling is accepted.
- A pip index with a query string or a fragment, or an `http` host written in a non-canonical form such as `127.1`, `0x7f.1` or a decimal number, is now refused. A query string can carry a token, and pip does not necessarily read those hosts as loopback.
- A refused index or a stray URL typed after `/mlx-init` or `/mlx-start` now hides everything between the scheme and the last `@`, including passwords that contain `/`, `?` or `#`.
- A bad `PI_MLX_MODELS_PIP_INDEX`, or a bad `mlxLm.pipIndex` or `mlxLm.version` in the global file, no longer changes the provider pi registers at load: the base URL and default model of the valid settings apply. `/mlx-init` and `/mlx-start` still refuse and name the bad value.
- An exact pin whose installed version cannot be read now shows a warning that the pin was not compared, with the reason, before the start message. The start still launches what is installed.
- **A project file that sets `autoStart` is refused,** with `true` or `false`, as one that sets `mlxLm.pipIndex` is. A project file that says `autoStart: false` therefore refuses launches in that project too. Set the option in your global file or the environment.
- **`config.json` can now be created by the extension,** only by `/mlx-config` on a first edit. Before, the extension never created it.
- **`last-launch.json` appears in the data directory** next to `config.json` after a successful start, and with it the directory itself. It holds the model id and the profile name; deleting it forgets the launch. See [The remembered launch](docs/reference/configuration.md#the-remembered-launch).

## 0.2.3 - 2026-10-17

### Changed

- The extension now names pi's current package, `@earendil-works/pi-coding-agent`, as its peer dependency and in its imports. It named `@mariozechner/pi-coding-agent`, which npm has deprecated in favour of the new name and which has had no release since May 2026.

### Fixed

- A project file (`.pi/pi-mlx-models.json`) can no longer set `server.allowedOrigins`: like a non-loopback host, it is refused with a warning, and the same setting in the global file still works.
- A project file's `model.chatTemplate` must now point inside the project directory, so a cloned repository cannot make the extension read another file on your machine into the server's command line. The global file, `models` entries there and `/mlx-start --chat-template` can still point anywhere.
- A bracketed IPv6 host such as `[::1]` is now passed to the server as `::1`, which Python can bind. It was passed with the brackets and the server failed to start.

### Project

- A release is now one manual run of the Release workflow: it bumps the version, updates this changelog, builds and tests, stages the release on npm and tags it. Pushing a tag no longer publishes anything.

## 0.2.2 - 2026-10-17

### Project

- Releases are now staged with `npm stage publish` from GitHub Actions, and go live when a maintainer approves them with two-factor authentication. This matches the trusted publisher, which does not allow a direct `npm publish`. There are no code changes since 0.2.0.

## 0.2.1 - 2026-10-17

### Project

- Not published to npm. The first CI publish of this version was refused because the workflow used a direct publish that the trusted publisher does not allow; 0.2.2 replaces it.

## 0.2.0 - 2026-10-17

### Added

- **Configuration files.** A global `config.json` in `<pi agent dir>/pi-mlx-models/` and a per-project `.pi/pi-mlx-models.json`. Both are read at every `/mlx-start`, so an edit needs no reload. See the [configuration reference](./docs/reference/configuration.md).
- **Server settings:** `server.host`, `server.port`, `server.allowedOrigins`, `server.logLevel`, `server.trustRemoteCode`, plus `baseUrl` and `defaultModel`.
- **Model options:** `model.adapterPath`, `model.draftModel`, `model.numDraftTokens`, `model.chatTemplate`, `model.useDefaultChatTemplate` and `model.chatTemplateArgs`, with a `models` block to override them for one preset or model id.
- **Flags on `/mlx-start`** for every setting above that maps to a server flag, and four pi flags: `--mlx-model`, `--mlx-port`, `--mlx-host`, `--mlx-log-level`.
- **Documented precedence:** `/mlx-start` flags, pi flags, environment variables, project file, global file, built-in default.
- **One validation report.** A wrong type, an out-of-range value or an unknown key stops the start before anything is installed or launched, with one message that names every offending key, its source and what is allowed. An unknown key gets a "did you mean" hint, including when it was written in the wrong block.
- **Permission checks.** A project file may not enable `trustRemoteCode` or use a non-loopback `host` or `baseUrl`; the start is refused. The same settings from any other source ask for confirmation at every start.
- **Flag probe.** Before a launch that uses optional flags, the installed mlx-lm is asked which server flags it supports. A flag it lacks is skipped with a warning that names it, and the server still starts.
- **The start message lists the flags in use** and which source set each one.
- **`PI_MLX_MODELS_PYTHON`** chooses the Python used to build the virtual environment.
- **Documentation** reorganised into guides, reference and background under `docs/`.

### Changed

- **The default port is 8080**, replacing the previous Ollama default (`11434`). Set `PI_MLX_MODELS_PORT` or `server.port` to keep another.
- **Data location follows pi's agent directory:** `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.
- **Python 3.11 or newer is required,** with no upper limit. A virtual environment built on an older Python is recreated.
- **Environment variables are validated.** An invalid or empty `PI_MLX_MODELS_PORT` is ignored with a warning; an empty `PI_MLX_MODELS_HOST` or `PI_MLX_MODELS_BASE_URL` counts as unset; a trailing slash on a base URL is removed. A warning is shown when the base URL does not match the launch host and port.
- **The server is started with `PYTHONSAFEPATH=1`,** so a project directory cannot shadow `mlx_lm` with a module of its own.
- **Package renamed to `@taoc/pi-mlx-models`.** Install it with `pi install npm:@taoc/pi-mlx-models`. The repository moved to `The-Artificer-of-Ciphers-LLC/pi-mlx-models`, and the license notice now lists The Artificer of Ciphers LLC alongside the original author.
- Preset numbers and keys are documented, and an out-of-range number or a model id that starts with `-` is rejected before anything runs.

### Fixed

- A start that fails no longer leaves its server process running.
- A port already in use is detected before launch and after, and the start fails with a message that names the ways to choose another port.
- `/mlx-stop` waits for the server to exit, escalating to a forced kill, and for the port to be released. It also cancels a start or install still in progress.
- Quitting pi waits, for a bounded time, for the server to stop.
- Health checks, warm-up and model discovery have time limits, so a server that never answers cannot hang the start.
- A server that dies early reports its last output, and pip failures report their final error.
- A failed start no longer leaves a stale progress spinner on screen.
- A server command that cannot be started fails the start quickly instead of waiting.
- `/mlx-init` is refused while a start is in progress.
- Terminal control characters in pip output, model names and configuration values are removed before they are shown.

### Project

- CI runs the tests on Ubuntu and macOS and fails if the suite runs fewer than two tests.
- Releases are published to npm from GitHub Actions with provenance, using npm trusted publishing.

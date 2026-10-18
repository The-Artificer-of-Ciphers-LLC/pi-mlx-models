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
- **Profile limits.** Every profile has an optional `limits` object that is reserved and empty: it accepts no keys yet, and a later release uses it for model limits. Until then `sampling.maxTokens` is the profile's output limit.

### Changed

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

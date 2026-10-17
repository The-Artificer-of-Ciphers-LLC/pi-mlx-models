# Changelog

All notable changes to `@taoc/pi-mlx-models` are listed here. Releases before 0.2.0 were published as `pi-mlx-models`; see the [tags](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/tags) for their code.

## Unreleased

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

# @taoc/pi-mlx-models

Local MLX model launcher for [pi](https://pi.dev) on Apple Silicon.

<p align="center">
  <a href="https://www.npmjs.com/package/@taoc/pi-mlx-models"><img alt="npm version" src="https://img.shields.io/npm/v/@taoc/pi-mlx-models?style=for-the-badge&logo=npm&label=npm" /></a>
  <a href="https://www.npmjs.com/package/@taoc/pi-mlx-models"><img alt="npm downloads per month" src="https://img.shields.io/npm/dm/@taoc/pi-mlx-models?style=for-the-badge&logo=npm&label=downloads" /></a>
  <a href="https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/actions/workflows/ci.yml"><img alt="tests" src="https://img.shields.io/github/actions/workflow/status/The-Artificer-of-Ciphers-LLC/pi-mlx-models/ci.yml?branch=main&style=for-the-badge&logo=github&label=tests" /></a>
  <a href="https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/The-Artificer-of-Ciphers-LLC/pi-mlx-models?style=for-the-badge&logo=github&label=stars" /></a>
  <a href="https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/The-Artificer-of-Ciphers-LLC/pi-mlx-models?style=for-the-badge&label=license" /></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/main/assets/preset-selector.png" alt="Preset selector" width="780" />
</p>

`@taoc/pi-mlx-models` adds a local OpenAI-compatible provider to pi, with a guided startup flow for MLX models.

## What you get

- A preset selector with `/mlx-start`, or any Hugging Face model id
- A local runtime built by `/mlx-init` (virtual environment and `mlx-lm`), with an optional mlx-lm version pin and pip index
- Day-to-day commands: `/mlx-last` starts the last model again, `/mlx-restart` applies a changed setting, `/mlx-status` shows the server
- `/mlx-config`, a menu to edit the global config file without leaving pi
- Optional auto-start of the last model when pi opens (off by default)
- Layered configuration: a global file, a project file, environment variables and flags
- Named profiles per model, and sampling values that also reach the requests pi sends
- The context window pi is told about each model is read from the model's own `config.json`
- Server tuning: concurrency, prompt cache and KV cache options, draft model, adapter, chat template
- A permission check for settings that run code or open the network
- Startup progress with stage and status updates and a warm-up timer
- Provider models appear only when the server is actually ready

## Requirements

- macOS on Apple Silicon
- Python 3.11 or newer (to use another interpreter, see [How to use a different Python](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/configure-the-server.md#use-a-different-python))

## Install

From npm:

```bash
pi install npm:@taoc/pi-mlx-models
```

From GitHub:

```bash
pi install git:github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models
```

## Quick start

In pi:

```
/mlx-init
/mlx-start
```

`/mlx-init` builds the runtime the first time. `/mlx-start` with no arguments opens a selector: pick a preset with the arrow keys and Enter. When the server is ready, pi says so. A step-by-step walk-through is in [Get started](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/tutorials/get-started.md).

To start a model directly, give a preset number or key, or any Hugging Face model id:

```
/mlx-start qwen3_4b
/mlx-start mlx-community/Qwen3-4B-Instruct-2507-4bit
```

Stop it with `/mlx-stop`.

## Commands

Details, arguments and the preset list are in the [commands reference](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/reference/commands.md).

- `/mlx-init`: create or update the local runtime (Python virtual environment and mlx-lm)
- `/mlx-start`: start the server for a preset, a model id or a profile
- `/mlx-last`: start the model and profile of the last successful start
- `/mlx-restart`: start the running model again through the settings as they are now
- `/mlx-stop`: stop the server
- `/mlx-status`: show the server's health, model, profile and flags
- `/mlx-config`: view and edit the global config file in a menu

## The default port

The server listens on `127.0.0.1:8080` by default, not on 11434. Set `PI_MLX_MODELS_PORT` (or `server.port` in a config file) to change it. The host, base URL and default model can be set the same way: see [How to set a connection value from the environment](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/configure-the-server.md#set-a-connection-value-from-the-environment).

## Configure it

Create `~/.pi/agent/pi-mlx-models/config.json` to set a port, allowed origins or a log level for every launch, or `.pi/pi-mlx-models.json` in a project to override them there. The next `/mlx-start` picks the change up.

```json
{ "server": { "port": 8090, "logLevel": "INFO" } }
```

Every setting is in the [configuration reference](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/reference/configuration.md), with an [example file](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/reference/configuration.md#file-layout); the [precedence order](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/reference/configuration.md#sources-from-highest-precedence-to-lowest) says which source wins when two of them set the same value.

## Security

`--trust-remote-code` lets a model repository run Python on your machine, and a non-loopback `host` makes the server, which has no authentication, reachable from your network. Both ask for confirmation at every start, and a project file may not turn either on. See [How to allow remote code or network access](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/allow-remote-code-or-network-access.md).

## Documentation

**Tutorials**

- [Get started](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/tutorials/get-started.md): install, build the runtime, start a model and send a first prompt

**How-to guides**

- [How to configure the MLX server](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/configure-the-server.md)
- [How to edit the configuration from inside pi](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/edit-the-config-in-pi.md)
- [How to set model options](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/set-model-options.md) (draft model, adapter, chat template)
- [How to use profiles and sampling](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/use-profiles-and-sampling.md)
- [How to set a model's context window, thinking flag and output limit](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/set-model-limits.md)
- [How to restart, check and re-launch a model](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/restart-check-and-relaunch.md)
- [How to start a model automatically when pi opens](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/start-a-model-automatically.md)
- [How to allow remote code or network access](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/allow-remote-code-or-network-access.md)
- [How to release a new version](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/how-to/release-a-new-version.md) (maintainers)

**Reference**

- [Commands](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/reference/commands.md), including the presets
- [Configuration](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/reference/configuration.md): files, settings, flags, environment variables and precedence

**Explanation**

- [About how a launch is built](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/explanation/how-a-launch-is-built.md)
- [About layered configuration and trust](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/docs/explanation/layered-configuration-and-trust.md)

See the [changelog](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/CHANGELOG.md) for what changed in each release.

## Development

```bash
npm install
npm run build
npm test
```

The pi package manifest is in `package.json`: `pi.extensions` is `["dist/index.js"]`.

## Screenshots

### Startup progress

![Startup progress](https://raw.githubusercontent.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/main/assets/start-progress.png)

### Command menu

![Commands](https://raw.githubusercontent.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/main/assets/commands.png)

### Model selection

![Model selection](https://raw.githubusercontent.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/main/assets/model-selection.png)

## License

[MIT](https://github.com/The-Artificer-of-Ciphers-LLC/pi-mlx-models/blob/main/LICENSE). This project is a fork of [vmarinogg/pi-mlx-models](https://github.com/vmarinogg/pi-mlx-models); the original copyright notice is kept alongside The Artificer of Ciphers LLC's.

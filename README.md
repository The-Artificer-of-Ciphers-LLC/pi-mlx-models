# @taoc/pi-mlx-models

Local MLX model launcher for [pi](https://pi.dev) on Apple Silicon.

<p align="center">
  <img src="./assets/preset-selector.png" alt="Preset selector" width="780" />
</p>

`@taoc/pi-mlx-models` adds a local OpenAI-compatible provider to pi, with a guided startup flow for MLX models.

## What you get

- Interactive preset selector via `/mlx-start`
- Local runtime bootstrap via `/mlx-init` (virtual environment and `mlx-lm`)
- Layered configuration: a global file, a project file, environment variables and flags
- Server and model options: allowed origins, log level, draft model, adapter, chat template
- A permission check for settings that run code or open the network
- Startup progress with stage and status updates and a warm-up timer
- Provider models appear only when the server is actually ready
- Stop and cleanup via `/mlx-stop`

## Requirements

- macOS on Apple Silicon
- Python 3.11 or newer

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

`/mlx-init` builds the runtime the first time. `/mlx-start` with no arguments opens a selector: pick a preset with the arrow keys and Enter.

To start a model directly, give a preset number or key, or any Hugging Face model id:

```
/mlx-start qwen3_4b
/mlx-start mlx-community/Qwen3-4B-Instruct-2507-4bit
```

When the server is ready, pi says so. Use `/model` and pick `pi-mlx-models/...`. Stop it with `/mlx-stop`.

## Configure it

Create `~/.pi/agent/pi-mlx-models/config.json` to set a port, allowed origins or a log level for every launch, or `.pi/pi-mlx-models.json` in a project to override them there. The next `/mlx-start` picks the change up.

```json
{ "server": { "port": 8090, "logLevel": "INFO" } }
```

## Documentation

**Guides**

- [How to configure the MLX server](./docs/how-to/configure-the-server.md)
- [How to set model options](./docs/how-to/set-model-options.md) (draft model, adapter, chat template)
- [How to allow remote code or network access](./docs/how-to/allow-remote-code-or-network-access.md)

**Reference**

- [Commands](./docs/reference/commands.md), including the presets
- [Configuration](./docs/reference/configuration.md): files, settings, flags, environment variables and precedence

**Background**

- [About layered configuration and trust](./docs/explanation/layered-configuration-and-trust.md)

See the [changelog](./CHANGELOG.md) for what changed in each release. Maintainers: [How to release a new version](./docs/how-to/release-a-new-version.md).

## Development

```bash
npm install
npm run build
npm test
```

The pi package manifest is in `package.json`: `pi.extensions` is `["dist/index.js"]`.

## Screenshots

### Startup progress

![Startup progress](./assets/start-progress.png)

### Command menu

![Commands](./assets/commands.png)

### Model selection

![Model selection](./assets/model-selection.png)

## License

[MIT](./LICENSE). This project is a fork of [vmarinogg/pi-mlx-models](https://github.com/vmarinogg/pi-mlx-models); the original copyright notice is kept alongside The Artificer of Ciphers LLC's.

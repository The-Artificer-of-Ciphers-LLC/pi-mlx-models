# How to configure the MLX server

Set how `mlx_lm.server` is launched: its port, who may connect, its log level, how it uses memory, and which mlx-lm version it runs. All settings and their allowed values are in the [configuration reference](../reference/configuration.md).

## Change settings for every launch

1. Create the global file. With `PI_CODING_AGENT_DIR` unset it is `~/.pi/agent/pi-mlx-models/config.json`:

   ```json
   {
     "server": {
       "port": 8090,
       "allowedOrigins": ["http://localhost:3000"],
       "logLevel": "DEBUG"
     }
   }
   ```

2. Run `/mlx-start`. The start message lists what differs from the defaults and where each value came from:

   ```
   flags: --port 8090 (global file), --allowed-origins http://localhost:3000 (global file), --log-level DEBUG (global file)
   ```

3. To check what the server received, run `ps -ww -o args= -p $(pgrep -f mlx_lm.server)`.

Edit the file and run `/mlx-start` again. No reload of pi is needed.

## Override settings for one project

1. Create `.pi/pi-mlx-models.json` in the directory you start pi from:

   ```json
   { "server": { "logLevel": "WARNING" } }
   ```

2. Run `/mlx-start` from that directory. The project value beats the global one, and the other global settings still apply.

Only that directory's own file is read, not a parent's. A project file cannot turn on `trustRemoteCode`, listen on or send prompts to a non-loopback address, or choose the pip index; see [How to allow remote code or network access](allow-remote-code-or-network-access.md) and [Install mlx-lm from a different pip index](#install-mlx-lm-from-a-different-pip-index). It can pin the mlx-lm version.

## Override a setting for a single launch

Type the flags after the command:

```
/mlx-start qwen3_4b --port 8091 --log-level DEBUG
```

These apply to that launch only. To set a connection value for a whole pi session, start pi with the matching flag, for example `pi --mlx-port 8091`.

## Set a connection value from the environment

Export the variable before starting pi:

```bash
export PI_MLX_MODELS_PORT=8091
```

The variables are `PI_MLX_MODELS_PORT`, `PI_MLX_MODELS_HOST`, `PI_MLX_MODELS_BASE_URL` and `PI_MLX_MODELS_DEFAULT_MODEL`. They beat the files and lose to pi flags and `/mlx-start` flags.

## Fix a configuration error

If `/mlx-start` reports an error, nothing was installed or started. The message names each offending key, which file or flag it came from, and what is allowed. Correct the file and run `/mlx-start` again.

Common causes:

- A key written in the wrong place. `baseUrl`, `defaultModel` and `models` are top-level keys; every other key goes inside `server` or `model`.
- A number written as text, such as `"port": "8090"`. Files accept only exact JSON types.
- A flag typed twice, or a flag that needs a value written without one.

## Tune throughput and memory

1. Add the options to the `server` block of the global file:

   ```json
   {
     "server": {
       "decodeConcurrency": 4,
       "promptCacheBytes": 8589934592,
       "kvBits": 4
     }
   }
   ```

2. Run `/mlx-start`. The flags line lists the three options with their source, and because `kvBits` turns batching off, a warning follows:

   ```
   flags: --decode-concurrency 4 (global file), --prompt-cache-bytes 8589934592 (global file), --kv-bits 4 (global file)
   KV quantization (--kv-bits 4, global file): Disables batching, so requests are served one at a time. --decode-concurrency 4 has no effect while --kv-bits is set.
   ```

3. To check what the server received, run `ps -ww -o args= -p $(pgrep -f mlx_lm.server)` and look for `--kv-bits=4`.

Leave `kvBits` out to keep batching. Each option needs a minimum mlx-lm release; an older install skips it with a warning. The releases, the defaults and the limits MLX enforces are in the [configuration reference](../reference/configuration.md#performance-and-kv-cache-options).

## Pin or float the mlx-lm version

1. Set `mlxLm.version` in the global file, or in the project file to pin it for one project:

   ```json
   { "mlxLm": { "version": "0.32.2" } }
   ```

2. Run `/mlx-init`. It shows `Installing mlx-lm 0.32.2 (global file) from https://pypi.org/simple/ (default)` and installs exactly that version, upgrading or downgrading as needed.

3. Check with `<agent dir>/pi-mlx-models/venv/bin/python -m pip show mlx-lm`.

If you change the pin later and do not run `/mlx-init`, every `/mlx-start` warns and launches what is installed:

```
mlx-lm pinned 0.31.1 (project file), installed 0.32.2; run /mlx-init to apply
```

`/mlx-start` never changes the installed mlx-lm. To follow the newest release again, set `"version": "latest"` or remove the key, and run `/mlx-init`. For one run only, type `/mlx-init --mlx-lm-version latest`.

## Install mlx-lm from a different pip index

Use this for a mirror or an internal package index.

1. Set it in the global file:

   ```json
   { "mlxLm": { "pipIndex": "https://mirror.example/simple/" } }
   ```

   Or export `PI_MLX_MODELS_PIP_INDEX` before starting pi, or type `/mlx-init --pip-index https://mirror.example/simple/` for one run.

2. Run `/mlx-init`. The index is named in the first line it prints and in both pip steps.

The index must carry `pip` itself, because `/mlx-init` upgrades pip from it first. Do not put a user name or password in the URL; it is refused, and so is a query string or fragment, which can carry a token too. Use pip's netrc file or keyring for credentials.

A project file cannot set the index: `/mlx-init` and `/mlx-start` refuse it and tell you to move it to the global file. The global file, the environment variable and the flag need no confirmation. For the reason, see [About layered configuration and trust](../explanation/layered-configuration-and-trust.md).

## Use a different Python

Set `PI_MLX_MODELS_PYTHON` to the interpreter, which must be Python 3.11 or newer, and run `/mlx-init`:

```bash
export PI_MLX_MODELS_PYTHON=/opt/homebrew/bin/python3.13
```

## Pick a model without the selector

Start pi with `--mlx-model qwen3_4b` (a preset number, preset key or model id) and run `/mlx-start` with no model. A model typed after `/mlx-start` wins over the flag.

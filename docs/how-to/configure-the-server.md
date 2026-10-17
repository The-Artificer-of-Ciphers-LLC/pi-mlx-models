# How to configure the MLX server

Set how `mlx_lm.server` is launched: its port, who may connect, its log level. All settings and their allowed values are in the [configuration reference](../reference/configuration.md).

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

Only that directory's own file is read, not a parent's. A project file cannot turn on `trustRemoteCode` or listen on, or send prompts to, a non-loopback address; see [How to allow remote code or network access](allow-remote-code-or-network-access.md).

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

## Use a different Python

Set `PI_MLX_MODELS_PYTHON` to the interpreter, which must be Python 3.11 or newer, and run `/mlx-init`:

```bash
export PI_MLX_MODELS_PYTHON=/opt/homebrew/bin/python3.13
```

## Pick a model without the selector

Start pi with `--mlx-model qwen3_4b` (a preset number, preset key or model id) and run `/mlx-start` with no model. A model typed after `/mlx-start` wins over the flag.

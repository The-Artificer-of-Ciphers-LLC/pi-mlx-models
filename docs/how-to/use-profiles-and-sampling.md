# How to use profiles and sampling

Set sampling values such as temperature for a model, group them into named profiles, and start a model with one. The keys and their limits are in the [configuration reference](../reference/configuration.md#sampling-and-profiles).

## Set sampling defaults for every model

Put a `sampling` object in the `model` block of the global file (`~/.pi/agent/pi-mlx-models/config.json`):

```json
{
  "model": {
    "sampling": { "temperature": 0.7, "topP": 0.9, "maxTokens": 2048 }
  }
}
```

Run `/mlx-start`. The start message lists `--temp`, `--top-p` and `--max-tokens` with their source. The same values are written into the requests pi sends to the model.

`repetitionPenalty`, `stop` and `seed` have no server flag. They appear on the `request:` line of the start message and are applied to requests only.

## Define a profile for a model

Add a `profiles` object to the `models` entry of the model, keyed by a preset key or a model id:

```json
{
  "models": {
    "qwen3_4b": {
      "profiles": {
        "careful": {
          "sampling": { "temperature": 0.2, "topP": 0.9, "seed": 42 }
        },
        "wild": {
          "sampling": { "temperature": 1.1 }
        }
      }
    }
  }
}
```

A profile holds the same per-model keys as the `model` block, plus `sampling` and `limits`. It does not hold `server` keys such as `port`. The `limits` object corrects what pi is told about the model (context window, output limit, thinking flag, image input); see [How to set a model's context window, thinking flag and output limit](set-model-limits.md).

## Start a model with a profile

Name the profile after the model:

```
/mlx-start qwen3_4b --profile careful
```

The start message shows `profile: careful (/mlx-start)` and labels each value from the profile, for example `--temp 0.2 (profile careful)`. The profile applies to that launch only. The next `/mlx-start qwen3_4b` is back to the file settings.

## Make a profile the default for a model

Add `defaultProfile` to the `models` entry:

```json
{
  "models": {
    "qwen3_4b": {
      "defaultProfile": "careful",
      "profiles": {
        "careful": { "sampling": { "temperature": 0.2 } }
      }
    }
  }
}
```

`/mlx-start qwen3_4b` now uses `careful`. `/mlx-start qwen3_4b --profile wild` uses `wild` instead. A model with no `defaultProfile` and no `--profile` is started with no profile.

## Turn thinking off for a Qwen3-style model

Set `enable_thinking` to `false` in the `chatTemplateArgs` of a profile:

```json
{
  "models": {
    "qwen3_4b": {
      "profiles": {
        "quick": {
          "chatTemplateArgs": { "enable_thinking": false },
          "sampling": { "temperature": 0.3 }
        }
      }
    }
  }
}
```

Start it:

```
/mlx-start qwen3_4b --profile quick
```

The setting is passed to the server as `--chat-template-args` and is sent with every request to the model. pi's own `chat_template_kwargs` and `reasoning_effort` are removed from those requests, so the profile is the only source.

## Check what the server receives

1. Set the log level to `DEBUG` in the global file:

   ```json
   { "server": { "logLevel": "DEBUG" } }
   ```

2. Start the model with the profile, for example `/mlx-start qwen3_4b --profile quick`.
3. Send a message in pi.
4. Read the server's log output. The request body shows the values of the profile, for example `"temperature": 0.3` and `"chat_template_kwargs": {"enable_thinking": false}`.

## Keep a profile in the project file

Put the same `models` entry in `.pi/pi-mlx-models.json` in the directory pi was started in:

```json
{
  "models": {
    "qwen3_4b": {
      "profiles": {
        "docs": { "sampling": { "temperature": 0.4, "maxTokens": 1024 } }
      }
    }
  }
}
```

A project profile with the same name as a global one wins for the keys it sets. A `chatTemplate` in a project profile must point inside the project directory. Starting with a project profile asks no extra question.

## If a profile is rejected

- **The profile does not exist.** The start stops before anything is installed or started, and the message lists the profiles of that model:

  ```
  profile "nope" (/mlx-start --profile): not defined for mlx-community/Qwen3-4B-Instruct-2507-4bit; available profiles: careful, wild
  ```

  Fix the name, or add the profile to the `models` entry of that model.

- **The profile holds a key it may not hold.** A profile cannot hold `server` keys (`port`, `host`, `logLevel`, `allowedOrigins`, `trustRemoteCode`, and the concurrency, cache and KV cache keys), a nested `profiles` object, or `extends`. The message names the key and the file. Move a `server` key to the `server` block.

- **The name is not allowed.** A profile name is 1 to 64 characters: letters, digits, `.`, `_` and `-`, starting with a letter or digit.

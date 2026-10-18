# How to set a model's context window, thinking flag and output limit

Check what pi is told about a model, then correct it: make a model a thinking model, set its context window by hand, let it take images, limit how much it may think, and list every model instead of only the loaded one. The keys, defaults and rules are in the [configuration reference](../reference/configuration.md#model-metadata-and-the-model-list). Profiles themselves are explained in [How to use profiles and sampling](use-profiles-and-sampling.md).

The four `limits` keys are written inside a profile, in a `models` entry. They are not allowed in the `model` block or anywhere else.

## See what pi was told

1. Run `/mlx-start` with the model, for example `/mlx-start qwen3_4b`.
2. Read the `model:` line in the messages before the ready message:

   ```
   model: context 262144 (config.json), max output 8192 (default), reasoning no (preset), input text (default)
   ```

   Each value is followed by where it came from: `config.json`, `fallback`, `default`, `preset`, `model name` or `profile NAME`.
3. Optionally run `pi --list-models`. The `pi-mlx-models` rows show the same context window, output limit, thinking and image columns. pi may abbreviate the numbers.

Only the model you started is listed, unless you [list every model](#list-every-cached-model).

## Make KAT-Coder a thinking model with a larger answer limit

`mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit` is a model that thinks, but nothing in its id says so, so pi is told it does not think and offers it an output limit of 8192. A profile corrects both.

1. Add a profile to the `models` entry of the model id in the global file (`~/.pi/agent/pi-mlx-models/config.json`):

   ```json
   {
     "models": {
       "mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit": {
         "profiles": {
           "think": {
             "limits": { "reasoning": true, "maxTokens": 16384 },
             "chatTemplateArgs": { "enable_thinking": true }
           }
         }
       }
     }
   }
   ```

2. Start it with the profile:

   ```
   /mlx-start mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit --profile think
   ```

3. Check the `model:` line:

   ```
   model: context 262144 (config.json), max output 16384 (profile think), reasoning yes (profile think), input text (default)
   ```

`limits.reasoning` and `limits.maxTokens` change only what pi is told. `chatTemplateArgs` with `enable_thinking` is what the model's chat template reads; it is passed to the server and sent with every request. A model flagged as reasoning gets neither the `developer` role nor `reasoning_effort` from pi, so pi's thinking-level selector appears but sends nothing, and `enable_thinking` is the only lever.

Without the profile, the same model starts as a plain model with the 8192 default.

## Set the context window by hand

The window is normally read from the model's own `config.json`. Set it yourself when the file cannot be read, or when the window you can use is not the one the file declares (a model extended with rope scaling can declare a smaller `max_position_embeddings` than it handles).

```json
{
  "models": {
    "qwen3_4b": {
      "profiles": {
        "long": { "limits": { "contextWindow": 131072 } }
      }
    }
  }
}
```

Start with `/mlx-start qwen3_4b --profile long`. The `model:` line shows `context 131072 (profile long)`. Setting `limits.contextWindow` also skips reading `config.json`, so nothing is looked up and no notice is shown.

## Let a model take images

Every model is registered as text only, including the gemma-4 preset, because nothing detects image support. If your model and server accept images, say so:

```json
{
  "models": {
    "gemma4_e2b": {
      "profiles": {
        "vision": { "limits": { "input": ["text", "image"] } }
      }
    }
  }
}
```

Start with `/mlx-start gemma4_e2b --profile vision`. The list must include `text`. This only tells pi to offer images; the model and the server have to handle them.

## Limit or switch off thinking

mlx-lm has no thinking-budget setting. One cap covers the thinking and the answer together: a reply ends when the request's `max_completion_tokens` (else `max_tokens`, else the server's `--max-tokens`, which is 512 by default) is reached. A long thought can therefore use the whole cap and leave no answer. The levers are:

- `limits.maxTokens`: the output limit pi is told about. pi asks the server for at most that many tokens per reply.
- `sampling.maxTokens`: the number the server and the requests carry. It is passed as `--max-tokens` and written into each request, replacing pi's value.
- `chatTemplateArgs` with `enable_thinking` set to `false`, for a model whose chat template supports it. This switches thinking off.

To cap the DeepSeek-R1 distill preset at 4096 tokens for thinking and answer together, set both numbers:

```json
{
  "models": {
    "deepseek_r1_1_5b": {
      "profiles": {
        "capped": {
          "limits": { "maxTokens": 4096 },
          "sampling": { "maxTokens": 4096 }
        }
      }
    }
  }
}
```

The two keys are independent. A profile with only `limits.maxTokens` changes what pi is told and adds no `--max-tokens`. A profile with only `sampling.maxTokens` caps the server but leaves pi told the default; when `sampling.maxTokens` is above the output limit pi is told about, every start shows a warning:

```
sampling.maxTokens 20000 is above the output limit pi is told about, 8192 (default); pi sizes its context for 8192. Set limits.maxTokens in the profile to match.
```

Configured `chatTemplateArgs` are also sent with every request to the launched model, not only passed at launch. An open mlx-lm report (issue 1803) says per-request `chat_template_kwargs` may bypass the prompt cache. It is unconfirmed: one commenter could not reproduce it.

## List every cached model

By default pi lists only the model that is loaded. It lists none before the first `/mlx-start`, and none again after `/mlx-stop` or at the end of the session. To list every model the server reports, set `provider.listAllModels` to `true` in the global file or the project file:

```json
{ "provider": { "listAllModels": true } }
```

The next `/mlx-start` registers all of them. mlx-lm lists the models in its Hugging Face cache. The loaded model keeps the values from its start; every other model is read from the local cache only, and one count-only warning says how many fell back to 32768.

If you use a server you started yourself, through `PI_MLX_MODELS_BASE_URL` or `baseUrl`, set `provider.listAllModels` to `true`. The default list is empty until a first `/mlx-start`, so without the key pi shows no model.

## If the context window cannot be read

A model whose `config.json` cannot be found or read still starts, with a window of 32768, and one warning says why:

```
context window unavailable for mlx-community/SmolLM3-3B-4bit (not in the local cache; the Hugging Face Hub could not be reached); using 32768
```

The extension looks in the Hugging Face cache first, and asks the Hub only when the cache has no copy. To fix it:

- **Gated or private repository.** Set `HF_TOKEN` in the environment pi runs in. It is an environment variable only: no config key holds a token, and the extension never stores or shows one. Do not put a token in a config file.
- **Offline.** `HF_HUB_OFFLINE` set to `1`, `true`, `yes` or `on` stops the Hub request, so the cache is the only source.
- **Any other reason, or a window that differs from the file.** Set `limits.contextWindow` in the profile, as shown in [Set the context window by hand](#set-the-context-window-by-hand).

The same notice is shown once per model and reason while pi runs. For the rules and the environment variables see [Model metadata and the model list](../reference/configuration.md#model-metadata-and-the-model-list).

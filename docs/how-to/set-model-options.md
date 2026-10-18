# How to set model options

Give a model a draft model for speculative decoding, a LoRA adapter, or a custom chat template, either for every model or for one. The keys and their limits are in the [configuration reference](../reference/configuration.md#model-options). For sampling values and named profiles, see [How to use profiles and sampling](use-profiles-and-sampling.md).

## Apply an option to every model

Put it in the `model` block of the global file (`~/.pi/agent/pi-mlx-models/config.json`):

```json
{
  "model": {
    "draftModel": "mlx-community/Qwen3-0.6B-4bit",
    "numDraftTokens": 4
  }
}
```

Run `/mlx-start`. The start message shows `--draft-model` and `--num-draft-tokens` with their source.

## Apply an option to one model

Add an entry to `models`, keyed by a preset key or a full model id:

```json
{
  "model": { "numDraftTokens": 4 },
  "models": {
    "qwen3_4b": { "draftModel": "mlx-community/Qwen3-0.6B-4bit" },
    "mlx-community/Llama-3.2-3B-Instruct-4bit": { "numDraftTokens": 2 }
  }
}
```

An entry holds the same keys as the `model` block and wins over it for that model.

## Use a LoRA adapter

```json
{ "model": { "adapterPath": "~/adapters/my-lora" } }
```

`~` is your home directory. A relative path is relative to the directory pi was started in.

## Use a custom chat template

1. Save the template as a Jinja file, for example `./templates/chat.jinja`. It must be UTF-8 text of at most 64 KiB.
2. Point to it:

   ```json
   { "model": { "chatTemplate": "./templates/chat.jinja" } }
   ```

The file is read when you run `/mlx-start`, and its text is passed to the server. A missing, empty or oversized file stops the start with a message naming it.

To pass template variables:

```json
{ "model": { "chatTemplateArgs": { "enable_thinking": false } } }
```

Objects from several sources are merged key by key, so a project file can change one variable and keep the rest.

## Change an option for one launch

Type the flag after the command. `--chat-template-args` takes a JSON string:

```
/mlx-start qwen3_4b --num-draft-tokens 2 --chat-template-args='{"enable_thinking":false}'
```

## Make an option project-specific

Put the same keys in `.pi/pi-mlx-models.json`. A project `model` block beats a global `models` entry, because project settings rank above global ones.

## If the installed mlx-lm does not support an option

The start continues without it and one warning names the skipped flag and the mlx-lm version. Run `/mlx-init` to upgrade mlx-lm.

# About how a launch is built

This page explains how `@taoc/pi-mlx-models` turns "start this model" into a server command line and into the values pi sends with each request. It covers the pieces a launch is assembled from and why a setting only applies to a model it names exactly. For the exact precedence rules see the [configuration reference](../reference/configuration.md#model-options); for why settings come from several files see [About layered configuration and trust](layered-configuration-and-trust.md).

## One model, two names

A model has two names. The **model id** is the Hugging Face id, such as `mlx-community/Qwen3-4B-Instruct-2507-4bit`. It is what the server loads and what pi sends in each request. A **preset key**, such as `qwen3_4b`, is a short name the extension gives to five models it ships with.

You can start a model by saying either, or by the preset's number. The extension settles this first, before it looks at any setting: a number becomes its preset, and a preset key becomes the preset's model id. A model id that happens to be a preset's id is recognised as that preset. Anything else is taken as a model id as typed. So `/mlx-start 4`, `/mlx-start qwen3_4b` and `/mlx-start mlx-community/Qwen3-4B-Instruct-2507-4bit` are the same launch, and a model that is not a preset has only its id.

## The pieces

Settings come in two kinds. Some belong to the server as a whole, such as the port and the log level. They do not depend on which model runs. The rest belong to a model: a draft model, an adapter, a chat template, sampling values. The extension collects those from three places, from the widest to the narrowest:

- The **model block** holds options for every model.
- A **models entry** holds options for one model. It is filed under a key, and the key can be the preset key or the model id, so one model can have an entry under either name. When both exist, the id's entry is the narrower one and wins where they disagree.
- A **profile** is a named set of the same kind of options kept inside a models entry. It is a way to keep two moods of one model, a careful one and a loose one, side by side without editing the file between starts.

A profile is chosen with `--profile` on the command, or, when none is typed, by the entry's **default profile**. If neither names one, the launch uses the model block and the entries alone. A profile name is looked up only among the profiles of the model being started, so the same word can mean different things for different models. A name the model does not have stops the start instead of falling back to something else. That choice is deliberate: a profile that silently did nothing would look like it had worked.

Flags typed on the command come last and beat all of it, for that launch only.

## From settings to a running model

The result of that assembly goes two ways.

Part of it becomes the server's command line: the draft model, the adapter, the template, and the sampling values that have a server flag, such as `--temp`. Those are the defaults of the server.

The sampling values are also kept in memory, and just before pi sends a request to the model it just started, they are written into it. A server flag sets only the launch default of the server, while each request carries its own fields. Writing the configured value into the request makes it replace the value pi would have sent. The same step explains why three values, repetition penalty, stop sequences and seed, appear on the `request:` line of the start message and not on the `flags:` line: the server has no flag for them, so the request is the only place they can reach.

This step is narrow on purpose. It touches only requests to this provider, and only requests that name the model that was launched. A request for another model, or to another provider, passes through unchanged, because the values were chosen for one model and have no claim on the others.

## Why a setting has to match exactly

All of this rests on one rule: a models entry applies when its key is exactly the preset key or the model id of the model being started. The comparison is plain text equality. There is no case folding, no partial match and no guessing from a similar name.

The consequence is easy to see with a mistake. Suppose the file holds an entry under `qwen3_4` instead of `qwen3_4b`. The file is valid, because any text can be the id of a model the extension has never heard of. Nothing is wrong with it as a file. It simply names a model nobody starts, so its settings never apply, and the extension does not check it, because from its point of view the entry is for some other model. The same happens when a profile name is typed where a model key belongs: the entry is filed under a name that no start uses. This is the failure `/mlx-config` tries to catch when it asks "Add anyway?" for a key that is neither a preset key nor shaped like an id.

The alternative would be to match loosely, so that `qwen3_4` reached `qwen3_4b`. That would turn the typo into a working file, but it would do so by deciding on your behalf which model a setting is for. Settings like an adapter or a draft model fit one model's architecture, and applying them to a neighbour with a similar name would produce a server that fails or answers wrongly with nothing in the file to explain why. An exact rule keeps the cost of a typo small and local: the setting does nothing, and checking the start message, which lists each flag with the source it came from, shows at once that it did not apply.

The same reasoning is why a number is not a key. A number given to `/mlx-start` is read as a preset number before any entry is looked up, so an entry filed under `2` cannot be reached by starting a model.

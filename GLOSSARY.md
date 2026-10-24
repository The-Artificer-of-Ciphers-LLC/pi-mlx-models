# pi-mlx-models

The words this project uses for the settings you can change and the places they are stored. This page is reference: it defines the terms and links to the pages that explain or use them. For steps, see the [how-to guides](docs/how-to/edit-the-config-in-pi.md); for every setting, see the [configuration reference](docs/reference/configuration.md).

## Language

### Where settings live

**Global file**:
The config file in the pi agent directory (`pi-mlx-models/config.json`). `/mlx-config` edits this file and no other.
_Avoid_: user config, main config

**Project file**:
The config file in a project (`.pi/pi-mlx-models.json`). It overrides the global file for that project and is edited by hand.
_Avoid_: local config

**Model block**:
The `model` object of a config file. Its keys apply to every model that has no entry of its own.
_Avoid_: defaults, global model options

### Models and profiles

**Preset**:
A model that ships with the extension, named by a preset key such as `qwen3_4b`.
_Avoid_: built-in model

**Model key**:
The text a model entry is stored under: a preset key or a Hugging Face model id such as `org/name`. A start uses an entry only when it starts a model with exactly this text.
_Avoid_: model name

**Model entry**:
The object stored under one model key in `models`. It holds that model's options, its profiles and its default profile.
_Avoid_: model config, model override

**Profile**:
A named set of keys inside a model entry, chosen when a model starts. It can hold every per-model key, including the `limits` keys.
_Avoid_: preset (a preset is a model, not a settings set), mode

**Default profile**:
The profile a model entry names for `/mlx-start` to use when no profile is given.
_Avoid_: active profile

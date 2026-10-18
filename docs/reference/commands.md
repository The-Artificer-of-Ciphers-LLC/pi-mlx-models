# Commands reference

All the commands `@taoc/pi-mlx-models` adds to pi: `/mlx-init`, `/mlx-start`, `/mlx-last`, `/mlx-restart`, `/mlx-stop`, `/mlx-status` and `/mlx-config`. Settings, flags and their precedence are in the [configuration reference](configuration.md).

## /mlx-init

```
/mlx-init [--pip-index url] [--mlx-lm-version latest|X]
```

Creates or updates the local runtime: finds a Python 3.11 or newer interpreter, creates a virtual environment under `<agent dir>/pi-mlx-models/venv`, upgrades pip and installs mlx-lm.

| Flag | Meaning |
|------|---------|
| `--mlx-lm-version latest` | Install the newest mlx-lm, never below 0.24.0. This is the default. |
| `--mlx-lm-version X` | Install exactly version `X`, for example `0.32.2`, upgrading or downgrading as needed. |
| `--pip-index url` | Install from this package index instead of `https://pypi.org/simple/`. |

The flags apply to that run only. What `/mlx-init` installs is decided by the same layers as other settings: the flag, then the environment (`PI_MLX_MODELS_MLX_LM_VERSION`, `PI_MLX_MODELS_PIP_INDEX`), then the project file (version only), then the global file. The rules for both values are in [mlx-lm version and install source](configuration.md#mlx-lm-version-and-install-source).

- It reads the global file, the project file and the environment, and prints what it will install before it starts: `Installing mlx-lm latest (default) from https://pypi.org/simple/ (default)`. Each part names its source.
- It refuses, and installs nothing, when a file is invalid (an unrelated bad key also stops it), when the project file sets an option that runs code, opens the network or chooses the pip index, and while a start is in progress. For the last, run `/mlx-stop` first.
- A failure names the spec and the index, for example `Installing mlx-lm==0.31.1 from https://mirror.example/simple/ failed: ...`, followed by pip's own message.
- Python is chosen from `PI_MLX_MODELS_PYTHON` when set, then from a list of common locations, then from `PATH`, newest version first.
- A virtual environment built on a Python older than 3.11 is recreated.
- `/mlx-start` installs the runtime only when no working install exists, and then with the same index and version setting. It never upgrades or downgrades an existing install. When the installed version is not the pinned one, `/mlx-start` says so and launches what is installed. Use `/mlx-init` to apply the pin.

## /mlx-start

```
/mlx-start [model] [--profile name] [--flag value | --flag=value ...]
```

Starts the local MLX server for a model, waits until it answers a completion, and registers it with pi as the provider `pi-mlx-models`.

| Argument | Meaning |
|----------|---------|
| none | Opens a preset selector. If `--mlx-model` is set, that model starts without the selector. |
| a number from 1 to 5 | The preset at that position in the [preset list](#presets) |
| a preset key | For example `qwen3_4b` |
| a model id | Any Hugging Face model id, for example `mlx-community/Qwen3-4B-Instruct-2507-4bit`. It must not start with `-`. |
| `--profile name` | Starts the model with the named profile for that launch only. The profile must be defined for that model; otherwise the start stops and lists the model's profiles. |

The flags, their syntax and their precedence are in the [configuration reference](configuration.md#mlx-start-arguments). Profiles and the sampling settings are described in [Sampling and profiles](configuration.md#sampling-and-profiles).

Before it starts anything, `/mlx-start` checks the arguments and the configuration. A problem is reported in one message and nothing is installed or started. It may then ask for confirmation of settings that [run code or open the network](configuration.md#settings-that-ask-for-permission).

It can also show these warnings, described in the [configuration reference](configuration.md#what-a-start-shows): the installed mlx-lm is not the pinned version, the installed version could not be read to compare it with the pin, a flag is skipped because the install does not support it, and, after the start message, quantized KV cache turns batching off.

Once the server is ready, pi lists only that model, unless `provider.listAllModels` is `true`. A `model:` line shows the context window, output limit, reasoning flag and input kinds pi was told about it, each with its source. The rules and the warnings that can come with it are in [Model metadata and the model list](configuration.md#model-metadata-and-the-model-list).

When the start has finished and pi lists the model, `/mlx-start` selects it for the current pi session, and the ready message reads "MLX server is ready for prompts. pi-mlx-models/MODEL is now the selected model." (MODEL is the model id). The model is not selected, and the ready message instead reads "MLX server is ready for prompts. Use /model and pick pi-mlx-models/...", when:

- the start was stopped, replaced or lost its server;
- a model was picked in pi (with `/model`, a cycle or a session restore) while the start was running;
- pi does not list the model, or the lookup or the switch fails.

When pi refuses the switch because it has no authentication for the provider, one warning line says so before that hint. The start succeeds in all of these cases.

Starting a model while another is running replaces the running server.

Every successful start is remembered: the model and the profile that applied are kept in a small file, so that [`/mlx-last`](#mlx-last) can start the same model again, also after pi was closed and opened again. See [The remembered launch](configuration.md#the-remembered-launch).

## /mlx-last

```
/mlx-last [--profile name] [--flag value | --flag=value ...]
```

Starts the model and the profile of the last successful start, with no preset selector. It works after pi was closed and opened again, because the launch is remembered in a file.

- It takes `--profile` and the flags of [`/mlx-start`](#mlx-start) and no model. What is typed applies to that launch only and is never remembered. A `--profile` typed here replaces the remembered profile for that launch.
- The launch is resolved through the configuration files and the environment as they are now, so an edit made since the last start takes effect.
- It makes the same checks as `/mlx-start`: an invalid configuration, a project file that asks for something it may not, and the confirmations for [settings that run code or open the network](configuration.md#settings-that-ask-for-permission), which are asked again.
- With nothing remembered it starts nothing and says so, with a pointer to `/mlx-start`.
- When the remembered file cannot be read, it reports that, treats it as nothing remembered and starts nothing. The next successful start replaces the file.
- When the remembered profile is no longer defined for the model, the start is refused with the usual unknown-profile message, which lists the model's profiles. There is no fallback to another profile or to the model without a profile.
- A profile that is kept from the remembered launch is shown on the `profile:` line of the start message as `(previous launch)`. A profile typed here is shown as `(/mlx-last)`.
- The remembered profile is the one that applied to the last start, whether `--profile` or `defaultProfile` chose it. While the record names a profile, a later change of `defaultProfile` does not affect `/mlx-last`. A record without a profile follows `defaultProfile` as it is at that time.

To have the last model start when pi opens, see [Auto-start](configuration.md#auto-start).

## /mlx-restart

```
/mlx-restart [--profile name] [--flag value | --flag=value ...]
```

Starts the model of this session's launch again, with the same profile selection, through the configuration as it is now. The server it replaces is stopped by the new start, not before.

- It takes `--profile` and the flags of [`/mlx-start`](#mlx-start) and no model.
- **Profile.** A profile typed with `--profile` on any launch command, or kept from `/mlx-last`, stays selected. A restart that names none reads `defaultProfile` again. A `--profile` typed on the restart replaces the selection from then on.
- **Flags.** Flags are never kept. Only the flags typed on `/mlx-restart` apply, to that restart only. They are labelled `(/mlx-start)` on the `flags:` line, like flags typed on `/mlx-start`. [`/mlx-status`](#mlx-status) afterwards shows the new flags.
- **Settings.** An edit of a configuration file, by hand or with [`/mlx-config`](#mlx-config), takes effect at the next restart.
- The confirmations for settings that run code or open the network are asked again at every restart. Nothing about an earlier approval is remembered.
- The arguments, the configuration and the confirmations are checked before the running server is touched. A restart that is refused or declined leaves the server running.
- With no launch of this session, it starts the remembered launch and first says `mlx-restart: nothing was running, starting MODEL from the last launch.` With nothing remembered it says `mlx-restart: nothing is running and nothing is remembered. Run /mlx-start to pick a model.` An unreadable remembered file is reported as for `/mlx-last`.

A restart is remembered like any other successful start.

## /mlx-stop

```
/mlx-stop
```

Stops the server, waits for it to exit and for its port to be released, and removes the provider's models from pi. With the default settings the list stays empty until the next `/mlx-start`. It also cancels a start that is still in progress.

Quitting pi stops the server too, waiting a few seconds for it to exit.

A stop is not remembered. The remembered launch stays as it was, so with [auto-start](configuration.md#auto-start) on, the next pi session starts that model again.

## /mlx-status

```
/mlx-status
```

Shows, in one notice, whether the server is down, loading or ready, and what was started. It takes no arguments and changes nothing. It connects to the server's address and asks for the server's model list; it reads nothing else from the network. The notice is current when the command runs; it is not updated afterwards.

For a launch made in this session the block repeats lines the start showed, without working them out again:

```
status: ready (answering on 127.0.0.1:8080)
server: mlx-community/Qwen3-4B-Instruct-2507-4bit (preset qwen3_4b) on 127.0.0.1:8080
profile: careful (/mlx-start)
flags: --port 8080 (global file), --temp 0.2 (profile careful)
model: context 262144 (config.json), max output 8192 (default), reasoning no (preset), input text (default)
```

The `profile:`, `flags:` and `request:` lines are those of the start message, with the sources of the values, and appear only when the start showed them. The `model:` line is the one shown once the start finished; `/mlx-status` repeats it because pi shows it only at that moment. These lines are kept in memory for the life of the launch, so they end with its server (`/mlx-stop`, an exit, quitting pi) and no file or network read is needed for them. Flags typed on a later [`/mlx-restart`](#mlx-restart) or [`/mlx-last`](#mlx-last) show as the new flags.

The first word after `status:` is the health:

| Health | Meaning |
|--------|---------|
| `ready` | The server answers a request for its model list. For a launch of this session, the start also finished. |
| `loading` | A start of this session is under way, even when the server already answers its model list. It is also shown when a start of this session has finished and the server accepts connections but does not answer its model list within a short bound, for example because it is busy with a long reply. The reason in the parentheses is `busy or not answering yet`. |
| `down` | Nothing accepts connections on the address. The block says `nothing is listening`, or that the server this session started is not answering. |
| `not answering` | A server this session did not start accepts connections but does not answer its model list. It is never reported as loading, because nothing says it is starting. |

The address is the one of the launch. With no launch of this session it is the address the configuration gives, read now from the pi flags, the environment, the project file and the global file. The command refuses first, as `/mlx-start` does, when the configuration is invalid or the project file asks for something it may not.

For a server this session did not start (started by hand, by another pi, or by this pi before it was restarted), the block shows the port, the health and the model ids the server reports. The profile and the flags are `unknown`, a note says so, and there is no `model:` line. The ids come from the server: control characters are removed, credentials in a URL are hidden, each id is clipped, and at most 10 are listed.

```
status: ready (answering on 127.0.0.1:8080)
server: 127.0.0.1:8080, not started by this session
models: mlx-community/Qwen3-4B-Instruct-2507-4bit
profile: unknown
flags: unknown
note: the model line is not shown for a server this session did not start
```

While a start is under way the block adds a note that the model details appear after the start finishes.

## /mlx-config

```
/mlx-config
```

Opens a menu in pi to view and edit the global configuration file, without leaving pi. It takes no arguments. It is a menu, not a text editor for the file. It never starts, stops or restarts the server.

| Entry | What it does |
|-------|--------------|
| View the current config | Shows the keys that are set in the global file, the models with their profile names, and the problems the checks find in the file. |
| Edit a general or server setting | The top-level keys and the `server`, `mlxLm` and `provider` blocks. |
| Edit options that apply to every model | The `model` block. |
| Edit options of one model | The keys of one `models` entry, chosen from the entries in the file or added by name. |
| Add, edit or delete a profile | Adds a profile to a model, edits one key of a profile, or deletes a profile. |
| Choose a model's default profile | Sets or clears `defaultProfile` for a model. |
| Delete a model entry | Removes one `models` entry with its options, its profiles and its `defaultProfile`, after a confirmation that lists what is lost. An entry left empty by deleting its last profile is removed this way. |
| Done | Leaves the menu. |

After each action the menu returns to the top. Every setting in the [settings table](configuration.md#settings) can be set or removed in the place where the file accepts it. The `limits` keys are offered inside a profile only. A profile is renamed by adding the new name and deleting the old one.

- **Confirmation.** A setting that runs code, opens the network, chooses the pip index or starts a model when pi opens asks for confirmation before it is saved: `server.trustRemoteCode` set to `true`, a non-loopback `server.host`, `server.allowedOrigins`, a non-loopback `baseUrl`, `mlxLm.pipIndex`, and `autoStart` set to `true`. A dialog that is dismissed or fails counts as no, and nothing is saved. Removing one of these keys, or setting it to a value that is not risky, asks for nothing.
- **Validation.** Each edit reads the file, changes one key, checks the whole file with the checks a hand-edited file gets, and writes it in one atomic step. An edit that would make the file invalid, or larger than 256 KiB, is refused, and the problem lines are shown. A problem that was already in the file also refuses the edit. A model key typed by hand for a new entry is also checked for a way to match a start: a preset key, a key with a slash such as `org/name`, and a local path (absolute, or starting with `./` or `../`) are added without a question, and any other key, for example a profile name typed where the model key belongs, asks "Add anyway?" because no start would ever use it. A no, a dismissed dialog and a dialog that fails each add nothing, and keys already in the file are not asked about.
- **A file that cannot be read.** A file that is not valid JSON or cannot be read is never overwritten. The command says so and stops.
- **Global file only.** The global file is the only file it writes. Project files stay hand-edited. The first edit creates the global file and its directory when they do not exist.
- **Deleting** asks for confirmation. Deleting a profile asks first, and when the profile is the model's `defaultProfile`, that key is cleared in the same write. Deleting a model entry asks too, and the question lists the profiles, options and `defaultProfile` that go with it. A dismissed or failed dialog counts as no for both, and nothing is deleted.
- **After an edit** the notice names the key and says the change takes effect on the next `/mlx-start`. When a server of this session is running, it adds that [`/mlx-restart`](#mlx-restart) applies the change. Nothing is restarted automatically. pi shows the notice as one line in the chat, and the menu that opens next can push that line out of view on a short terminal, so the result of every action (a saved edit, a refusal, a decision not to save) is also repeated at the top of the next menu, labelled "Last result". It is shown once, and a long result is cut to a few lines. The output of "View the current config" stays in the chat only.
- **The view** prints the whole config as one chat notice. The chat may clip that notice on a short terminal (about 24 rows or fewer), and the notice is not repeated in the menu.
- **Without an interactive UI** the command prints the file and says it is a read-only view. It refuses to edit.

## Presets

| Number | Key | Model id | Good for |
|--------|-----|----------|----------|
| 1 | `deepseek_r1_1_5b` | `mlx-community/DeepSeek-R1-Distill-Qwen-1.5B-4bit` | reasoning, math |
| 2 | `gemma4_e2b` | `mlx-community/gemma-4-e2b-it-4bit` | writing, summarization |
| 3 | `llama3_2_3b` | `mlx-community/Llama-3.2-3B-Instruct-4bit` | chat, rewriting |
| 4 | `qwen3_4b` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | coding, reasoning |
| 5 | `smollm3_3b` | `mlx-community/SmolLM3-3B-4bit` | fast chat, quick drafts |

Other models: browse the [MLX Community collections](https://huggingface.co/mlx-community/collections) on Hugging Face and start one by its id.

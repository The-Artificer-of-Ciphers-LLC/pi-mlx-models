# About layered configuration and trust

This page explains why `@taoc/pi-mlx-models` reads settings from several places, why some settings are refused in a project file, and why it checks the installed mlx-lm before passing flags. For the exact rules see the [configuration reference](../reference/configuration.md).

## Why there are layers

A launch has several owners. You have preferences that hold everywhere: a port, a log level. A project has needs of its own: a chat template that lives in the repository, a smaller draft token count. A single launch sometimes needs a one-off change. Each is a different scope, and a setting that can only live in one place forces you to edit it again whenever the scope changes.

So the extension reads from a global file, a project file, environment variables, pi flags and the command itself, and lets the narrower scope win. The order is the one most command-line tools use: the more specific and the more recent the instruction, the higher it ranks. The environment variables that existed before configuration files, `PI_MLX_MODELS_PORT` and the others, keep working and keep their place above the files.

Files are read at every start, not at load. The reason is practical: an edit takes effect on the next `/mlx-start`, and nothing has to be restarted. It also means no stale setting can survive in memory.

Model options follow a slightly different path. A `model` block applies to every model, and a `models` entry applies to one. The extension can only know which applies once you have chosen a model, so these are settled after that choice, still in the same order of precedence.

## Why bad values stop the start

A mistyped port or an unknown key could be ignored, and the server would start with something other than what you wrote. That fails quietly, and the first sign is a server that behaves differently from the file. The extension instead refuses to start, and reports every problem in one message, so one edit fixes them all. Nothing is installed or launched before that point.

The exception is the environment. A bad environment variable is ignored with a warning and the next source down is used. This is how those variables behaved before configuration files existed, and keeping it means an existing setup does not start failing after an upgrade.

## Why a project file cannot turn on certain settings

Opening a repository in pi is not the same as trusting it. A project file is part of that repository, so whoever wrote the repository wrote it.

Three settings are dangerous in untrusted hands:

- `trustRemoteCode` lets a model repository run Python on your machine.
- A non-loopback `host` makes the server reachable from your network, and it has no authentication.
- A non-loopback `baseUrl` sends your conversations to another machine.

A project file may set none of them. The extension refuses the start and says where to move the setting. The same values in your own global file, or typed by you, are fine, but they ask first, at every start. A decision made once and remembered would apply to a different model the next time.

The check looks at the project file on its own, before the layers are merged. It would be easy to say "the value is overridden anyway, so ignore it", but then removing the override later would silently activate the dangerous value. Refusing the file closes that gap.

There is a limit to this protection. The confirmation dialog opens with **Yes** highlighted, because pi's `confirm` offers no way to choose the default, and the extension therefore adds a sentence telling you how to cancel. Pressing Enter without reading still agrees. Confirmations are meant for people who read them.

## Why the working directory is not searched for Python modules

The server is a Python program started from wherever pi runs. By default Python puts the current directory first when it looks for modules, so a repository containing a folder named `mlx_lm` could replace the real one. The extension sets `PYTHONSAFEPATH=1` for the server and for its checks, which stops that. It targets the same kind of risk as the project file rules: a cloned repository should not be able to run code you did not intend to run.

## Why the installed mlx-lm is asked what it supports

New server flags arrive with new mlx-lm releases. A flag an older install does not know makes the server exit at once. Rather than require everyone to be current, the extension asks the install which flags it lists and leaves out the ones it lacks, with one warning naming them. The start still works, and the warning says how to upgrade.

The check runs only when a launch uses optional flags, so a default launch is as fast as before. If the check itself fails, the extension passes everything and says so. A failed check should not become a reason to refuse a launch that might have worked.

## Related

- [How to configure the MLX server](../how-to/configure-the-server.md)
- [How to allow remote code or network access](../how-to/allow-remote-code-or-network-access.md)

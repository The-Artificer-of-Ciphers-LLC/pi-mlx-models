# Get started: run your first local model in pi

In this tutorial we will install `@taoc/pi-mlx-models`, build its runtime, start a small model on your Mac and send it a first prompt from pi. We use one model and the default settings all the way through.

You need a Mac with Apple Silicon, [pi](https://pi.dev) installed, and Python 3.11 or newer on the machine. The first start downloads a few gigabytes of model files, so allow some time and a network connection.

## Install the extension

In a terminal, run:

```bash
pi install npm:@taoc/pi-mlx-models
```

Now open pi in any directory.

## Build the runtime

In pi, type:

```
/mlx-init
```

Notice the first two messages. They say `Installing local MLX runtime...` and then name what is going to be installed, with the source of each part:

```
Installing mlx-lm latest (default) from https://pypi.org/simple/ (default)
```

A progress list shows four steps: find a compatible Python, create a virtual environment, upgrade pip and install mlx-lm. When it is finished, pi says:

```
MLX runtime installed.
```

We only do this once. The runtime stays on your machine.

## Start a model

Type:

```
/mlx-start
```

A list titled `Select MLX model preset` opens. Each line is a number, a preset name and two words about what the model is good for. Use the arrow keys to move to this line and press Enter:

```
4. qwen3_4b — coding, reasoning
```

Pi now shows the model it is starting:

```
Starting MLX server with mlx-community/Qwen3-4B-Instruct-2507-4bit (preset: qwen3_4b)...
```

A progress list follows. It ends with "Download/load model" and "Warm up first inference". The first start downloads the model, so this is the slow part. We wait until the list is complete.

Then pi shows one line that says what it was told about the model, for example:

```
model: context 262144 (config.json), max output 8192 (default), reasoning no (preset), input text (default)
```

The last message is:

```
MLX server is ready for prompts. pi-mlx-models/mlx-community/Qwen3-4B-Instruct-2507-4bit is now the selected model.
```

The model is running and pi has selected it. If your message instead ends with `Use /model and pick pi-mlx-models/...`, type `/model` and pick that entry.

## Send a first prompt

Type a message as you would to any model in pi:

```
Write a haiku about a quiet laptop.
```

The answer comes from the model running on your own machine.

## Stop the model

When you are done, type:

```
/mlx-stop
```

Pi says `MLX server stopped.` The model is unloaded and its port is free again.

We have installed the extension, built the runtime, started a model and talked to it. To start the same model again, run `/mlx-start` and pick it again.

## Where to go next

- [How to configure the MLX server](../how-to/configure-the-server.md) to change the port, the log level and more.
- [Commands reference](../reference/commands.md) for every command and the other presets.

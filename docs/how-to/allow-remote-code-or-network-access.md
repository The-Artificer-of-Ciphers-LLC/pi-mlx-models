# How to allow remote code or network access

Three settings can run code from a model repository or expose your machine or conversation to a network. They are `server.trustRemoteCode`, a non-loopback `server.host` and a non-loopback `baseUrl`. This guide shows how to use them on purpose. For why they are handled this way see [About layered configuration and trust](../explanation/layered-configuration-and-trust.md).

## Let a model run its own Python code

Some models need `--trust-remote-code`. Only do this for repositories you trust.

1. Put it in the global file, `~/.pi/agent/pi-mlx-models/config.json`:

   ```json
   { "server": { "trustRemoteCode": true } }
   ```

   Or ask for it on a single launch:

   ```
   /mlx-start my-org/my-model --trust-remote-code
   ```

2. Run `/mlx-start`. A dialog asks "Allow remote code from the model repository?" and shows which source set it. Choose **Yes** to continue or **No** (or Esc) to cancel; nothing starts on **No**.

The dialog appears at every start. Nothing is remembered.

## Make the server reachable from your network

`mlx_lm.server` has no authentication, so anything that can reach the port can use your model.

1. Set the host in the global file:

   ```json
   { "server": { "host": "0.0.0.0" } }
   ```

2. Run `/mlx-start` and confirm the dialog "Listen on a non-loopback address?".

Loopback means `127.0.0.1`, `localhost` or `::1`. Every other value, including `0.0.0.0` and `::`, asks.

## Send pi's requests to a server on another machine

1. Set `baseUrl` in the global file:

   ```json
   { "baseUrl": "https://models.example.com/v1" }
   ```

2. Run `/mlx-start` and confirm "Send prompts to a non-loopback address?". It shows where your conversation will be sent.

## Do not put these in a project file

A project file, `.pi/pi-mlx-models.json`, is refused if it sets any of the three. The message names each one and says to move it to the global file. This protects you from a repository you have just cloned.

To use one of them for a single project, keep it in the global file and let the dialog appear. Or ask for it for one launch: `--trust-remote-code` and `--host` can be typed after `/mlx-start`, and `PI_MLX_MODELS_BASE_URL` sets `baseUrl` from the environment. Each of these also asks for confirmation.

## Use them without a person present

A start that needs confirmation is refused when pi has no interactive interface. Run `/mlx-start` in an interactive pi session instead.

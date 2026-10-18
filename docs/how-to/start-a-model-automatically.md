# How to start a model automatically when pi opens

Have pi start the model you used last every time a session opens, so it is loading while you type your first prompt. The rules and every skip condition are in the [configuration reference](../reference/configuration.md#auto-start).

## Turn it on

1. Start the model you want once, with `/mlx-start`, `/mlx-last` or `/mlx-restart`. Auto-start launches the [remembered launch](../reference/configuration.md#the-remembered-launch), so it does nothing until one exists.
2. Switch the option on in one of two places:
   - In pi, run `/mlx-config`, choose **Edit a general or server setting**, choose `autoStart`, choose `true` and answer **Yes** to the confirmation.
   - Or put it in the global file, `~/.pi/agent/pi-mlx-models/config.json`:

     ```json
     { "autoStart": true }
     ```

   - Or export the variable before starting pi: `export PI_MLX_MODELS_AUTO_START=true`. It beats the file.
3. Open pi. The model starts in the background, with the same progress display as `/mlx-start`.
4. When the message `MLX server is ready for prompts. Use /model and pick pi-mlx-models/...` appears, run `/model` and pick the model. Auto-start never changes the model that is selected.

## Start a different model at the next opening

Start the model you want now with `/mlx-start`. Every successful start replaces the remembered launch. `/mlx-stop` does not forget it, so with auto-start on the next session starts that model again.

## Turn it off

Set `autoStart` to `false` in `/mlx-config` or in the file, or remove the key. `PI_MLX_MODELS_AUTO_START=false` turns it off whatever the file says.

## If nothing starts

Auto-start stays silent when the option is off, when pi has no interactive interface, when nothing is remembered, or when a start is already under way. Otherwise it shows one notice that starts with `auto-start skipped:`:

- **The runtime is not installed.** Run `/mlx-init`, then `/mlx-start`. Auto-start installs nothing.
- **Something already answers on the port.** Auto-start leaves that server alone and does not adopt it. Free the port or change `server.port`, then run `/mlx-last`.
- **The launch needs a confirmation** (remote code, a non-loopback host or base URL). Auto-start never confirms. Run `/mlx-last` and answer the dialog.
- **The configuration is invalid.** The notice lists the problem lines, as `/mlx-start` would. Fix the file and run `/mlx-last`.
- **The remembered profile is no longer defined for the model.** The notice lists the model's profiles. Run `/mlx-start` to start by hand.
- **The remembered file cannot be read.** Run `/mlx-start`; a successful start replaces the file.

## If a project file sets it

A project file, `.pi/pi-mlx-models.json`, may not contain `autoStart`, with either value: every launch in that project is refused with a message that names the global file and `PI_MLX_MODELS_AUTO_START`. Remove the key from the project file and set it in the global file.

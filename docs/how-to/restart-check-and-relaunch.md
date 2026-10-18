# How to restart, check and re-launch a model

Pick up where you left off, see what the server is doing, and apply a changed setting without choosing the model again. The commands in full are in the [commands reference](../reference/commands.md).

## Start the model you used last

Run `/mlx-last`. It starts the model and the profile of the last successful start, with no preset selector, also after pi was closed and opened again. It reads the configuration as it is now, so an edit made since applies.

- To use another profile for this launch only, type it: `/mlx-last --profile careful`. Flags of `/mlx-start` can be typed too, and apply to this launch only.
- If it says nothing is remembered, run `/mlx-start` once. The next successful start is remembered.
- If it says the remembered profile is not defined for the model, the message lists the model's profiles. Add the profile back to the file, or start the model with one of the listed profiles: `/mlx-start MODEL --profile NAME`.

To have this happen when pi opens, see [How to start a model automatically when pi opens](start-a-model-automatically.md).

## Check the server

Run `/mlx-status`. The first word after `status:` is the health:

- `ready`: the server answers. Send your prompt.
- `loading`: a start is under way, or the server is busy. Wait and run it again.
- `down`: nothing is listening. Run `/mlx-last` or `/mlx-start`.
- `not answering`: a server that this session did not start accepts connections but does not answer. Find out what uses the port, or change `server.port`.

For a launch of this session the notice also repeats the `profile:`, `flags:`, `request:` and `model:` lines the start showed, so you can read which profile and flags are in effect. It changes nothing and takes no arguments.

## Apply a changed setting

1. Edit the config, by hand or with `/mlx-config`.
2. Run `/mlx-restart`.

It starts the running model again with the same profile selection, through the files as they are now. The old server is stopped by the new start, not before, so a restart that is refused (an invalid file, a declined confirmation) leaves the running server as it was.

- To try another profile: `/mlx-restart --profile wild`. That profile stays selected for later restarts.
- To change a flag for this restart only: `/mlx-restart --log-level DEBUG`. Flags are never kept; the next restart is back to the files.
- A dialog for remote code or a non-loopback address is asked again at every restart.
- With nothing running, `/mlx-restart` starts the remembered launch and says so first.

## Stop the server

Run `/mlx-stop`. It stops the server and clears pi's model list. The remembered launch stays, so `/mlx-last` can start it again.

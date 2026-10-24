# How to edit the configuration from inside pi

Change the global config file with the `/mlx-config` menu instead of editing JSON by hand. It writes `<agent dir>/pi-mlx-models/config.json` only; project files stay hand-edited. The menu entries are listed in the [commands reference](../reference/commands.md#mlx-config) and the settings in the [configuration reference](../reference/configuration.md#settings). Words such as model entry and profile are defined in the [glossary](../../GLOSSARY.md).

## Open the menu

1. Type `/mlx-config`. The menu is titled `MLX config`.
2. Choose an entry with the arrow keys and Enter. Choose **Done** (or press Esc on this menu) to leave.
3. Press Esc or choose **Back** to go up one level. A save leaves you where you were, so you can change the next key without opening the menu again; the levels are listed in the [commands reference](../reference/commands.md#mlx-config).

The result of each action is repeated at the top of the next menu as `Last result:`, so it stays readable on a short terminal.

## See what is set

Choose **View the current config**. It prints the keys set in the global file, the models with their profile names and any problems the checks find. The output may be clipped on a terminal of about 24 rows or fewer.

## Change or remove a server or general setting

1. Choose **Edit a general or server setting**.
2. Choose the key. Each line shows its current value, or `(not set)`. After you save, the list is shown again with the new value; press Esc when you are done.
3. For a true/false key, choose `true` or `false`. For any other key, choose **Set a value** and type the value:
   - a list: items separated by commas (`http://localhost:3000, http://localhost:5173`), or a JSON array
   - an object: JSON, for example `{"enable_thinking": false}`
   - a number or text: as it is
4. To take the key out of the file, choose **Remove the key from the file**.
5. If the setting runs code, opens the network, chooses the pip index or starts a model when pi opens, answer the confirmation dialog. **No** or Esc saves nothing.

A value that fails its check is not saved, and the notice says what the key accepts.

## Set an option for every model or for one model

- For every model, choose **Edit options that apply to every model**, then the key as above.
- For one model, choose **Edit options of one model**, then pick its entry in the numbered list, or choose **New model entry...** and type a preset key (such as `qwen3_4b`) or a model id such as `org/name`. Then choose the key.

### If it asks "Add anyway?"

The question appears when the key you typed is not a preset key and has no slash. A start uses the settings stored under a key only when the preset key or the model id it starts is exactly that text. Answer **No** if you meant a profile name, then choose **Add, edit or delete a profile** and pick the model first. Answer **Yes** only when you start that model with exactly this name.

## Add a profile and set its keys

1. Choose **Add, edit or delete a profile**.
2. Pick the model, or **New model entry...**.
3. Choose **New profile...** and type a name: letters, digits, dot, dash or underscore.
4. Choose **Edit a key of this profile**, pick the key and set it. The `limits` keys are offered here only.

The new, empty profile is saved as soon as you name it, and stays in the file if you choose **Back**.

To change a key of an existing profile, pick the model, pick the profile, then **Edit a key of this profile**. To rename a profile, add one under the new name and delete the old one.

## Delete a profile

1. Choose **Add, edit or delete a profile**, pick the model and the profile.
2. Choose **Delete this profile** and answer **Yes**. If it was the model's default profile, the default is cleared in the same write. You return to the model's profile list; **No** or Esc leaves you on the profile's menu.

## Choose a model's default profile

1. Choose **Choose a model's default profile**.
2. Pick the model, then the profile. Choose **(no default profile)** to clear it. The list of models is shown again, so you can set the default of another model.

The model needs at least one profile first.

## Delete a model entry

1. Choose **Delete a model entry** and pick the entry.
2. Read the list of what goes with it (options, profiles, default profile) and answer **Yes**. The list of entries is shown again for the next delete.

## Make the change take effect

A saved edit applies at the next `/mlx-start`. If a server of this session is running, run `/mlx-restart`; the notice for the edit says so. See [How to restart, check and re-launch a model](restart-check-and-relaunch.md).

## If the menu does not work

- **The file is not valid JSON, or cannot be read.** The command says so and stops; the file is never overwritten. Fix it by hand.
- **An edit is refused and problem lines are shown.** The edit would make the file invalid, or a problem was already in the file. Fix the problem lines first.
- **No interactive UI.** The command prints the file as a read-only view and edits nothing.

# OpenCode Linear TODOs

Private OpenCode TUI plugin that keeps up to 5 Linear issues pinned in the session sidebar, under **Linear TODOs**.

- **Pin issues:** click the section (or run `/todos`, or **Pin Linear issues** in the command palette). The modal lists your open assigned issues. Type to search every open issue in the workspace by title or ID. Press Enter or click a row to pin or unpin it.
- **Act on a pin:** click it in the sidebar to mark it done (moves it to the team's first completed state), unpin it, or open it in Linear.
- **Automatic removal:** every 60 seconds, and when the modal closes, pins are checked against Linear. An issue is unpinned when it's completed, canceled, a duplicate, archived, or deleted. Nothing else removes a pin.
- **Overdue:** a pin that has been in the list for 24 hours or more turns bright red and is counted in the header.

Pins are stored in OpenCode's plugin storage and stay in sync across open TUIs.

## API key

The plugin uses a Linear personal API key. It reads `LINEAR_API_KEY` from the environment first. If that isn't set, clicking the section asks for a key, checks it with Linear, and saves it in plugin storage on this machine. **Set Linear API key** in the command palette replaces the saved key.

## Options

To set options, load the plugin from `cli.json` with the object form, instead of through the symlink below:

```json
{ "plugins": [{ "package": "/path/to/opencode-linear-pins", "options": { "max": 5, "position": "bottom" } }] }
```

- `max`: the most issues you can pin. Defaults to 5.
- `position`: `"top"` puts the section first in the sidebar. Defaults to the bottom.

## Install

Symlink this directory into the global plugins directory:

```sh
ln -s /path/to/opencode-linear-pins ~/.config/opencode/plugins/linear-pins
```

OpenCode reloads the plugin when files change. Run `bun test` and `bun run check` after edits.

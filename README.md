# OpenCode Linear TODOs

Private OpenCode plugin that keeps up to 5 Linear issues pinned as your TODOs. They show under **Linear TODOs** in the session sidebar and on the home screen, and OpenCode manages them with tools.

- **Pin and unpin through OpenCode:** sessions get three tools. Ask OpenCode something like "pin ENG-42 to my TODOs" or "what's on my TODOs?".
  - `linear_todos_list` lists the pins.
  - `linear_todos_pin` pins issues by identifier (`ENG-123`) or URL. Closed issues are refused, and so is pinning past the limit.
  - `linear_todos_unpin` unpins issues without changing them in Linear.
- **Act on a pin:** click it in the sidebar or on the home screen to mark it done (moves it to the team's first completed state), unpin it, or open it in Linear.
- **Automatic removal:** every 60 seconds the server checks the pins against Linear. An issue is unpinned when it's completed, canceled, a duplicate, archived, or deleted. Nothing else removes a pin.
- **Overdue:** a pin that has been in the list for 24 hours or more turns bright red and is counted in the header.

The list lives in the OpenCode server's plugin storage, so every directory, session and open TUI shows the same list.

## API key

The plugin uses a Linear personal API key. The server reads `LINEAR_API_KEY` from its environment first. If that isn't set, clicking **Linear TODOs** asks for a key, checks it with Linear, and saves it in plugin storage on this machine. **Set Linear API key** in the command palette replaces the saved key. **Refresh Linear TODOs** syncs with Linear right away.

## Options

To set options, load the plugin with the object form instead of through the symlink below:

- `max` (server, in `opencode.json(c)`): the most issues you can pin. Defaults to 5.
- `position` (TUI, in `cli.json`): `"top"` puts the section first in the sidebar. Defaults to the bottom.

## Files

- `index.ts`: the server part. It stores the pins, syncs them with Linear, and adds the tools.
- `rpc.ts`: the contract the TUI uses to read and change the list.
- `tui.tsx`: the sidebar and home screen views.
- `linear.ts`, `pins.ts`: the Linear client and the list logic, covered by `pins.test.ts`.

## Install

Symlink this directory into the global plugins directory:

```sh
ln -s /path/to/opencode-linear-pins ~/.config/opencode/plugins/linear-pins
```

OpenCode reloads the plugin when files change. Run `bun test` and `bun run check` after edits.

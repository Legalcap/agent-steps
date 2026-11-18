# Changelog

## 0.1.0

First public version.

- Recipe format v2: steps stored by meaning (web: role, name, context, page; desktop: app, window, role, label, path), inputs as `{placeholders}`, and text checks.
- Drivers for agent-browser and Cua; one recipe can mix both.
- `createRecorder`, `replay` with one repair per run, `FileStore` (one JSON file per recipe).
- MCP server: `npx agent-steps mcp` with `steps_start`, `steps_stop`, `steps_list`, `steps_run`, `steps_repair`.
- Safety: final actions, secret fields, unread checkbox flips and pixel positions are never saved; `strict` and `standard` policies.

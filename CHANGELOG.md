# Changelog

## 0.2.0

Safety

- `replay()` checks the recipe again before running anything, and checks each step again after its inputs are filled in. Before, only loading from a store checked.
- Typed text that looks like a key or token is never saved; pass it as an input.
- The final-action word list also covers code, money and account actions (merge, deploy, terminate, revoke, refund, deactivate, cancel order, sign out, block and their like). The README says plainly that it is a word list.
- A step recorded on one page stops when the page cannot be read, instead of running anyway.
- Recipes unused for 60 days are deleted from the folder, not just hidden.
- The pixel-position fallback for Cua (`hints`) is gone.

Recording and replay

- A call that failed while recording is left out instead of discarding the whole recording; so is closing the browser.
- Return in a search box is kept whatever else the page shows.
- `find` with an action is refused (it acted without being recorded); the tools that only look are listed by name.
- A click on an element covered by a banner scrolls it free and tries again.
- Text checks read what the page says, not the labels of links and buttons, and read the whole page.
- `waitMs` (and `agent-steps mcp --wait <seconds>`) for slow pages.

MCP

- Tool calls are answered one at a time, in order; cancellation is honoured; requests time out; a server that exited says why.
- `steps_stop` lists every step the recipe will repeat, and says what to do about each refusal.

Breaking: `cuaDriver(caller, { hints })` and `CuaStep.hint` are removed; `replay()` now enforces its `policy` on the recipe it is given.

## 0.1.0

First public version.

- Recipe format v2: steps stored by meaning (web: role, name, context, page; desktop: app, window, role, label, path), inputs as `{placeholders}`, and text checks.
- Drivers for agent-browser and Cua; one recipe can mix both.
- `createRecorder`, `replay` with one repair per run, `FileStore` (one JSON file per recipe).
- MCP server: `npx agent-steps mcp` with `steps_start`, `steps_stop`, `steps_list`, `steps_run`, `steps_repair`.
- Safety: final actions, secret fields, unread checkbox flips and pixel positions are never saved; `strict` and `standard` policies.

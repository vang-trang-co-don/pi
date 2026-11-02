# Pi verification map

This directory is the maintained source for verifying the user-facing behavior of the `pi` coding assistant. Read this index before driving the app, then follow the matching feature recipe.

## Baseline preconditions

- Monorepo packages are compiled: `packages/coding-agent/dist/cli.js` exists.
- Run `control-pi doctor` to confirm `node`, `screen`, and auth credentials.
- Set a unique `$RUN_ID` per drive so concurrent runs do not collide or mutate user state.
- Scratch directories reside at `/tmp/pi-verify-$RUN_ID`.
- Never drive an instance attached to the user's live `~/.pi/agent` session directory.

## Driving conventions

- Start every recipe from the baseline state.
- Interactive terminal driving uses `./.pi/skills/verify/bin/control-pi` with `screen`.
- Direct CLI execution uses `control-pi cli <run_id> -- <args...>`.
- Headless RPC operations use `control-pi rpc <run_id> <json>`.
- Store all proof artifacts under `artifacts/verify/$RUN_ID/`.
- Clean up instances and scratch directories with `control-pi cleanup <run_id>`, retaining proof artifacts.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-pi` starts with `Preconditions:` and lists step-by-step actions and expected observable results.
4. `Gotchas` lists traps that can invalidate or fail the verification run.

## Features

- [Interactive TUI](./interactive-tui.md) covers interactive terminal startup, greeting banner, context display, and graceful shutdown.
- [CLI print mode](./cli-print-mode.md) covers single-prompt execution, output streaming, and error handling.
- [RPC protocol](./rpc-protocol.md) covers headless JSON-RPC initialization, state queries, model cycling, and prompt execution.
- [Extension management](./extension-management.md) covers extension listing, installation, and removal.
- [Model catalog](./model-catalog.md) covers model discovery, provider listing, and parameter verification.
- [Quota and usage tracking](./quota-usage.md) covers quota inspection, 5-hour and weekly rate limits, multi-account usage, and `/usage` TUI display.

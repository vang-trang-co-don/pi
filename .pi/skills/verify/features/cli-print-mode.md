# CLI print mode

CLI print mode executes single-shot queries and scripted tasks without entering an interactive full-screen terminal interface.

## Sub-features

- `cli-print` runs a prompt passed via `-p` and outputs the result to stdout (or streams JSON events with `--mode json`).
- `cli-offline` disables startup network operations like npm version checks and catalog refreshes without altering provider inference.
- `cli-files` attaches file context via `@file` arguments separated from the prompt.

## How to get to it (user POV)

- Run `pi -p "<prompt>"` in a terminal.
- Run `pi -p --offline "<prompt>"` to disable startup update/catalog checks.
- Run `pi -p @src/cli.ts "explain this file"`.

## Driving it with control-pi

Preconditions:

- `control-pi doctor` succeeds.
- `$RUN_ID` is defined.

- **Offline invocation.** Run a non-network CLI command with `--offline`. Run `./.pi/skills/verify/bin/control-pi cli "$RUN_ID" -- --offline -p "explain current directory" > "artifacts/verify/$RUN_ID/offline-output.txt" 2>&1 || true`.
- **Verify output.** Confirm that stdout/stderr shows the model response or expected offline notice and does not crash with unhandled exceptions.
- **Cleanup.** Run `./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"`.

## Gotchas

- Calling print mode with a live provider requires a valid API key or OAuth credentials in `auth.json`.
- The `@file` argument must be passed as an independent shell argument separated from the prompt text (e.g. `@path "prompt"`, not `"@path prompt"`).

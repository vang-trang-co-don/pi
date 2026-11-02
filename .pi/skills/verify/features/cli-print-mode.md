# CLI print mode

CLI print mode executes single-shot queries and scripted tasks without entering an interactive full-screen terminal interface.

## Sub-features

- `cli-print` runs a prompt passed via `-p` and streams text directly to stdout.
- `cli-offline` verifies local behavior without making network API requests.
- `cli-files` attaches file context via `@file` arguments on the command line.

## How to get to it (user POV)

- Run `pi -p "<prompt>"` in a terminal.
- Run `pi -p --offline "<prompt>"` for local dry-run or mock execution.
- Run `pi -p "@src/cli.ts explain this file"`.

## Driving it with control-pi

Preconditions:

- `control-pi doctor` succeeds.
- `$RUN_ID` is defined.

- **Offline invocation.** Run a non-network CLI command with `--offline`. Run `./.pi/skills/verify/bin/control-pi cli "$RUN_ID" -- --offline -p "explain current directory" > "artifacts/verify/$RUN_ID/offline-output.txt" 2>&1 || true`.
- **Verify output.** Confirm that stdout/stderr shows the model response or expected offline notice and does not crash with unhandled exceptions.
- **Cleanup.** Run `./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"`.

## Gotchas

- Calling print mode with a live provider requires a valid API key in `auth.json`.
- In offline mode, requests expecting live network responses will intentionally stop at the network boundary.

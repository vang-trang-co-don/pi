# Quota and usage tracking

Quota tracking displays real-time model capacity, consumption percentages, and reset countdowns across 5-hour and weekly limits.

## Sub-features

- `usage-cli` checks quota from the command line via `pi usage` or `pi auth usage`.
- `usage-json` outputs structured quota JSON for scripting and monitoring.
- `usage-multi-account` inspects quota across multiple accounts in a pool via `--account all`.
- `usage-tui` queries and renders quota within the interactive terminal via `/usage`.

## How to get to it (user POV)

- Run `pi usage` in the terminal.
- Run `pi usage --json` to get raw JSON output.
- Run `pi usage --account all` to view quota for all accounts in the pool.
- Type `/usage` in the interactive TUI editor.

## Driving it with control-pi

Preconditions:

- `control-pi doctor` succeeds.
- `$RUN_ID` is defined.
- Provider credentials (e.g. Antigravity) are available in `auth.json`.

- **Check CLI usage.** Run `pi usage`. Run `./.pi/skills/verify/bin/control-pi cli "$RUN_ID" -- usage > "artifacts/verify/$RUN_ID/usage-cli.txt"`.
- **Assert output structure.** Confirm stdout contains model group headers (`Gemini Models`, `Claude and GPT models`), window labels (`Weekly`, `5-Hour`), progress bars, and countdown timers.
- **Check JSON output.** Run `pi usage --json`. Run `./.pi/skills/verify/bin/control-pi cli "$RUN_ID" -- usage --json > "artifacts/verify/$RUN_ID/usage.json"`. Confirm output parses as a JSON array of account quota summaries.
- **Drive in interactive TUI.** Launch an interactive session. Run `./.pi/skills/verify/bin/control-pi launch "$RUN_ID"`, send `/usage` with carriage return (`./.pi/skills/verify/bin/control-pi send "$RUN_ID" "/usage"$'\r'`), wait 3 seconds, and capture terminal state (`./.pi/skills/verify/bin/control-pi capture "$RUN_ID" "artifacts/verify/$RUN_ID/tui-usage.txt"`). Confirm the rendered output shows quota progress bars.
- **Cleanup.** Run `./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"`.

## Gotchas

- Unauthenticated providers or missing credentials fail with clear error messages.
- Submitting `/usage` in the interactive TUI requires a carriage return (`$'\r'`) rather than newline (`$'\n'`) when sending keys through `screen`.

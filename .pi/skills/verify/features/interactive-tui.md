# Interactive TUI

Interactive TUI provides the full-screen terminal experience for conversational coding, tool approvals, live progress streaming, and slash command execution.

## Sub-features

- `tui-startup` launches into the interactive terminal, displaying context and status bar.
- `tui-prompt` accepts keyboard input and displays typed text.
- `tui-slash` recognizes slash commands in the editor.
- `tui-exit` quits the session cleanly via command or keybinding.

## How to get to it (user POV)

- Run `pi` in any terminal inside a project repository.
- Run `pi [files...]` to open an interactive session with specific context files pre-attached.

## Driving it with control-pi

Preconditions:

- `control-pi doctor` succeeds.
- `$RUN_ID` is defined.

- **Launch session.** Start an isolated interactive terminal session. Run `./.pi/skills/verify/bin/control-pi launch "$RUN_ID"`.
- **Verify greeting and context.** Capture the initial rendered state. Run `./.pi/skills/verify/bin/control-pi capture "$RUN_ID" "artifacts/verify/$RUN_ID/initial.txt"`. Inspecting the file shows the Pi banner, loaded context files, and the prompt input line with model name `gemini-3.8-flash`.
- **Enter slash command.** Send the `/exit` command to initiate graceful shutdown. Run `./.pi/skills/verify/bin/control-pi send "$RUN_ID" "/exit"$'\r'`.
- **Capture exit.** Verify session terminates. Run `./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"`.

## Gotchas

- If `trust.json` is not pre-seeded in the scratch directory, Pi displays a blocking interactive trust confirmation dialog.
- Terminal multiplexer key injection requires a carriage return (`$'\r'`) to simulate pressing the Enter key.
- Always execute `control-pi cleanup "$RUN_ID"` after runs to avoid orphaned `screen` processes.

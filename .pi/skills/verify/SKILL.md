---
name: verify
description: Drive and verify pi interactive TUI, CLI print mode, RPC interface, extension management, and model catalog in an isolated environment.
---

# Pi Verification Harness

This skill defines the verified procedure to launch, drive, observe, and validate the `pi` coding agent without mutating user sessions or live configurations.

## Launch

For interactive TUI verification:
```bash
RUN_ID=$(date +%s)-$RANDOM
./.pi/skills/verify/bin/control-pi launch "$RUN_ID"
```

Ready detection:
- Poll terminal capture until `~/projects/pi` or the status line `(antigravity) gemini-3.8-flash` appears.
- Teardown:
```bash
./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"
```

For non-interactive CLI and RPC verification:
- CLI mode does not keep a daemon running. Run on-demand:
```bash
./.pi/skills/verify/bin/control-pi cli "$RUN_ID" -- [args...]
```
- RPC mode runs over stdin/stdout:
```bash
./.pi/skills/verify/bin/control-pi rpc "$RUN_ID" '<json_command>'
```

## Doctor

Before starting a drive, verify the build and test prerequisites:
```bash
./.pi/skills/verify/bin/control-pi doctor
```

Doctor guarantees:
1. Node executable is present.
2. Built CLI bundle exists at `packages/coding-agent/dist/cli.js`. If missing, build with `npm run build`.
3. `screen` terminal multiplexer is installed and available.
4. Credentials exist in `~/.pi/agent/auth.json`.

## Drive

All driving operations execute through the `./.pi/skills/verify/bin/control-pi` helper:

1. **Interactive TUI**:
   - Launch: `./.pi/skills/verify/bin/control-pi launch "$RUN_ID"`
   - Send input / commands: `./.pi/skills/verify/bin/control-pi send "$RUN_ID" "your prompt"$'\n'`
   - Send special keys: `./.pi/skills/verify/bin/control-pi send "$RUN_ID" $'\033'` (Escape) or `$'\003'` (Ctrl+C)
   - Capture state: `./.pi/skills/verify/bin/control-pi capture "$RUN_ID" "artifacts/verify/$RUN_ID/screen.txt"`

2. **CLI / Print Mode**:
   - Run: `./.pi/skills/verify/bin/control-pi cli "$RUN_ID" -- --offline -p "prompt" > "artifacts/verify/$RUN_ID/output.txt"`

3. **RPC Mode**:
   - Send JSON-RPC line:
     `./.pi/skills/verify/bin/control-pi rpc "$RUN_ID" '{"id":"1","type":"get_state"}' > "artifacts/verify/$RUN_ID/state.json"`

## Evidence

Every verification run records proof artifacts under `artifacts/verify/$RUN_ID/`:
- **TUI runs**: Terminal hardcopy dumps (`screen.txt`) showing rendered screens, prompts, and status line.
- **CLI runs**: Standard output, standard error, and exit codes.
- **RPC runs**: Formatted JSON response bodies confirming command success and state.
- **Session state**: JSONL logs recorded in `/tmp/pi-verify-$RUN_ID/sessions/`.

Proof artifacts are preserved across teardown.

## Cleanup

Always tear down instances and scratch directories at the end of each drive:
```bash
./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"
```

Cleanup terminates the isolated `screen` session and removes `/tmp/pi-verify-$RUN_ID`, while leaving `artifacts/verify/` intact.

## Helpers

- `control-pi`: Located at `.pi/skills/verify/bin/control-pi`. Provides `doctor`, `launch`, `send`, `capture`, `cli`, `rpc`, and `cleanup` subcommands.

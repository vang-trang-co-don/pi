# RPC protocol

RPC mode exposes Pi's full agent runtime over a newline-delimited JSON-RPC stream on stdin and stdout for IDE integrations and subagents.

## Sub-features

- `rpc-state` retrieves current model, thinking level, session file, and queue parameters via `get_state`.
- `rpc-models` lists all available models configured for the agent runtime via `get_available_models`.
- `rpc-prompt` dispatches a user message and yields response events.

## How to get to it (user POV)

- Run `pi --mode rpc` to start the RPC server.
- Send JSON lines to stdin and read JSON event lines from stdout.

## Driving it with control-pi

Preconditions:

- `control-pi doctor` succeeds.
- `$RUN_ID` is defined.

- **Query agent state.** Send a `get_state` command. Run `./.pi/skills/verify/bin/control-pi rpc "$RUN_ID" '{"id":"req1","type":"get_state"}' > "artifacts/verify/$RUN_ID/rpc-state.json"`.
- **Assert response.** Confirm JSON output has `success: true` and contains the current model (`gemini-3.8-flash`), thinking level (`medium`), and active session file path.
- **Query available models.** Send a `get_available_models` command. Run `./.pi/skills/verify/bin/control-pi rpc "$RUN_ID" '{"id":"req2","type":"get_available_models"}' > "artifacts/verify/$RUN_ID/rpc-models.json"`.
- **Assert models list.** Verify output contains `success: true` and includes `antigravity` and `openai` models.
- **Cleanup.** Run `./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"`.

## Gotchas

- RPC commands must be formatted as single-line JSON; multi-line formatted JSON will fail to parse.
- The prompt command takes `message`, not `prompt`: `{"type":"prompt","message":"..."}`.

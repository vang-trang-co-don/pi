# Model catalog

Model catalog commands allow users to inspect supported AI providers, query available model names, and check token context windows and thinking levels.

## Sub-features

- `model-list` lists all supported models and their attributes across configured providers.
- `model-filter` filters listed models by provider name.

## How to get to it (user POV)

- Run `pi --list-models` to list all models.
- Run `pi --list-models <provider>` to filter models for a specific provider (e.g. `pi --list-models antigravity`).

## Driving it with control-pi

Preconditions:

- `control-pi doctor` succeeds.
- `$RUN_ID` is defined.

- **List provider models.** Run `--list-models antigravity`. Run `./.pi/skills/verify/bin/control-pi cli "$RUN_ID" -- --list-models antigravity > "artifacts/verify/$RUN_ID/models-antigravity.txt"`.
- **Assert output.** Verify the output table contains header columns (`provider`, `model`, `context`, `max-out`, `thinking`, `images`) and lists `claude-opus-4-6`, `claude-sonnet-4-6`, and `gemini-3.8-flash`.
- **Cleanup.** Run `./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"`.

## Gotchas

- Unauthenticated providers will only show models if their static catalog definitions are registered and offline listing is permitted.

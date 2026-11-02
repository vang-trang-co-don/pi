# Model catalog

Model catalog commands allow users to inspect supported AI providers, query available model names, and check token context windows and thinking levels.

## Sub-features

- `model-list` lists all supported models and their attributes across configured providers.
- `model-filter` filters listed models using a fuzzy search pattern matching provider and model ID.

## How to get to it (user POV)

- Run `pi --list-models` to list all models.
- Run `pi --list-models [search]` to filter models with a fuzzy search term (e.g. `pi --list-models antigravity` or `pi --list-models gemini`).

## Driving it with control-pi

Preconditions:

- `control-pi doctor` succeeds.
- `$RUN_ID` is defined.

- **List provider models.** Run `--list-models antigravity`. Run `./.pi/skills/verify/bin/control-pi cli "$RUN_ID" -- --list-models antigravity > "artifacts/verify/$RUN_ID/models-antigravity.txt"`.
- **Assert output.** Verify the output table contains header columns (`provider`, `model`, `context`, `max-out`, `thinking`, `images`) and lists `claude-opus-4-6`, `claude-sonnet-4-6`, and `gemini-3.8-flash`.
- **Cleanup.** Run `./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"`.

## Gotchas

- Models only appear for providers with valid authentication credentials in `auth.json`. Unauthenticated providers are excluded from the output.

# Extension management

Extension management allows users to inspect installed packages and tools, install extensions from npm or git, and remove them cleanly.

## Sub-features

- `ext-list` displays all globally or locally installed packages.
- `ext-install` adds an extension package to `settings.json`.
- `ext-remove` unregisters and removes an installed package (alias `uninstall`).

## How to get to it (user POV)

- Run `pi list` (or `pi list -l` for project-local packages) to view installed packages.
- Run `pi install <source>` to install a package.
- Run `pi remove <source>` (or `pi uninstall <source>`) to uninstall a package.

## Driving it with control-pi

Preconditions:

- `control-pi doctor` succeeds.
- `$RUN_ID` is defined.

- **List extensions.** Run `pi list` in an isolated environment. Run `./.pi/skills/verify/bin/control-pi cli "$RUN_ID" -- list > "artifacts/verify/$RUN_ID/list.txt"`.
- **Assert output.** When no packages are installed, verify stdout reports `No packages installed.`.
- **Cleanup.** Run `./.pi/skills/verify/bin/control-pi cleanup "$RUN_ID"`.

## Gotchas

- Installing third-party packages from npm requires network access unless cached locally.
- In isolated runs, `settings.json` must be seeded with `"packages": []` if not already present.

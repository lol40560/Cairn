# Cairn v2.0.1

## Highlights

- Publishes the redesigned project launcher, dashboard, activity views, editor workspace, and updated product documentation.
- P2P collaboration uses protocol v4 with encrypted peer transport and mutual room authentication.
- Adds security hardening for packaged renderer loading, sensitive-file exclusion, inbound peer connections, and release automation.

## Security & distribution

- Packaged Cairn builds now ignore development renderer URLs and keep privileged IPC bound to the bundled main frame.
- Sync and snapshot operations exclude additional credential formats, including PKCS#12, PFX, JKS, and keystores.
- Incoming peer connections have global and per-address limits before authentication.
- CI scans reachable Git history for secrets and checks production dependency advisories.
- Release jobs use least-privilege GitHub token permissions; release signing and notarization are supported when credentials are configured.
- v2.0.1 artifacts are intentionally unsigned. macOS Gatekeeper and Windows SmartScreen warnings are expected.

## Interface & workflow

- Cairn opens to a dedicated project launcher; use the project menu to return Home or move between recent projects.
- Activity, files, collaboration, checkpoints, and recovery views receive refined motion, layout, keyboard focus, and responsive behavior.
- Dashboard activity reflects watched-folder changes, while empty conflict, checkpoint, and deleted-file states avoid misleading zero labels.

## Known limitations

- Cairn does not claim full-project convergence because the protocol has no acknowledgement model.
- Session rollback remains analysis-only; a safe automatic three-way revert is not implemented.
- Binary conflict comparison remains metadata-only.
- Checkpoints and deleted-file recovery are safeguards, not replacements for independent backups.

# Cairn v2.0.2

## Highlights

- Hardens collaboration edit claims so a received claim is bound to the authenticated room peer that delivered it.
- Adds claim field and storage limits to reduce denial-of-service risk from a compromised collaboration peer.
- Prevents project-local Cairn history, recovery content, and collaboration metadata from being accidentally committed to Git.

## Security & distribution

- Claims still expire after ten minutes without a heartbeat, and only their authenticated owner can update a received claim.
- CI scans reachable Git history for secrets and checks production dependency advisories.
- v2.0.2 artifacts are intentionally unsigned. macOS Gatekeeper and Windows SmartScreen warnings are expected.

## Collaboration & workflow

- Files, activity, collaboration, checkpoints, and recovery remain local-first; sharing stays peer-to-peer with invited room members.
- Edit claims remain advisory by default. Teams may enable strict edit protection to block writes through Cairn's editor when another active claim exists.

## Known limitations

- Cairn does not claim full-project convergence because the protocol has no acknowledgement model.
- Session rollback remains analysis-only; a safe automatic three-way revert is not implemented.
- Binary conflict comparison remains metadata-only.
- Checkpoints and deleted-file recovery are safeguards, not replacements for independent backups.

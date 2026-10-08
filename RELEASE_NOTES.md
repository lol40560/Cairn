# Cairn v2.0.0-rc.1

> Release candidate — not a stable release. RC artifacts are created as GitHub Release drafts for explicit human review before publishing.

## Highlights

- Clearer collaboration awareness with human and AI attribution, grouped work sessions, and early overlap detection.
- Safer recovery with checkpoints, comparison, stale-restore protection, and automatic safety snapshots.
- Truthful Team Health, richer conflict handling, and an isolated Hackathon Mode for reliable demos.

## Protocol and compatibility

- P2P collaboration now uses protocol v4 with encrypted peer transport and mutual room authentication.
- Older Cairn peers are incompatible with this release candidate and cannot join v4 rooms.
- Legacy six-character room invites are rejected. Create and share a newly generated invitation with every teammate.
- Existing v1, v2, and v3 operation history remains readable; no project-history reset is required.

## Safety & reliability

- Cairn protects current state before destructive checkpoint restore and conflict actions.
- Dirty editor content blocks unsafe actions.
- Hackathon Simulation is entirely in memory and never touches a real project, room, checkpoint store, or GitHub export.

## Developer experience

- Quick Open, Command Palette, keyboard navigation, Activity filters/search, file-centric activity, and Monaco diff inspection.

## Known limitations

- Cairn does not claim full convergence because the protocol does not provide acknowledgement-based sync proof.
- Session rollback is analysis-only until a safe three-way revert is implemented.
- Binary conflict comparison remains metadata-only.
- Recovery protects project boundaries and preserves checkpoints, but it is not a substitute for an external backup strategy.
- macOS and Windows artifacts are unsigned. Expect Gatekeeper or SmartScreen warnings during RC testing.

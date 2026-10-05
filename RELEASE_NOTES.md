# Cairn v1.8.0

## Highlights

- Clearer collaboration awareness with human and AI attribution, grouped work sessions, and early overlap detection.
- Safer recovery with checkpoints, comparison, stale-restore protection, and automatic safety snapshots.
- Truthful Team Health, richer conflict handling, and an isolated Hackathon Mode for reliable demos.

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

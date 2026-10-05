# Cairn architecture

Cairn is an Electron application with a renderer that talks to core services only through the preload IPC boundary. Core file watching, operation storage, transport, merge, checkpoint, and GitHub work lives under `electron/core/`.

## Collaboration presentation

The renderer derives collaboration presentation from immutable operation and peer data:

- `activitySessions` groups operations for the Activity screen.
- `collaboration` attributes operations to people or known AI tools.
- `conflictIntelligence` distinguishes recent activity, possible overlap, divergent bases, and persisted conflicts.
- `teamHealth` converts observable peer and watcher state into truthful UI status.

These helpers are presentation/derivation code. They must not create network or filesystem side effects.

## Recovery safety

Real checkpoints are created and restored in the main-process checkpoint core. Restore compares a stored revision with the current workspace and creates a recovery checkpoint before applying files. Renderer controls must pass dirty-editor state so the core can reject unsafe actions.

## Hackathon Simulation isolation

Hackathon Simulation uses `src/lib/demoWorkspace.ts`, an explicit in-memory workspace with its own files, revisions, conflicts, and checkpoints. It can reuse Monaco and pure classifiers, but must never call real mutation boundaries: filesystem save, watcher control, room join/share/broadcast, checkpoint IPC, oplog persistence, project management, trash restore, or GitHub export. Exiting Simulation discards its workspace.

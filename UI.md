# Cairn Design System v2

Cairn is a calm, local-first desktop workspace for developers and their AI tools. The interface should make project state, collaboration, and recovery actions easy to understand without competing with the code.

## Product principles

1. **State before decoration.** Sync, connection, conflict, and save state must be legible at a glance.
2. **Local-first confidence.** Paths, room codes, timestamps, hashes, and file names may use monospace; ordinary interface text should remain human and quiet.
3. **Progressive disclosure.** Direct addresses, room diagnostics, and other networking details are available when needed, not presented as the primary flow.
4. **Files are the unit of work.** Activity groups changes by file, and file-oriented actions remain close to their context.
5. **Recovery is never hidden.** Conflicts, trash, and checkpoints stay reachable from the primary navigation.
6. **Functionality is not styling.** All renderer file and collaboration actions continue through the preload IPC boundary.

## Visual language

- Dark neutral surfaces: `--bg-0`, `--bg-1`, `--bg-2`, and `--bg-hover` define hierarchy without glass effects or large gradients.
- Inter is used for interface text. JetBrains Mono is reserved for technical content.
- Brand coral identifies Cairn navigation and primary actions. It is not the universal error color.
- Success is muted green; warnings are amber; failures and destructive actions are red.
- Buttons use 8px corners; cards use 12px; dialogs use 16px. Pills are reserved for compact status, filters, and tags.
- Motion is short and informative: hover 120ms, expansion 150ms, popovers 160ms, dialogs 180ms. Respect reduced-motion preferences.

## Layout

- The sidebar owns navigation: Project, Collaboration, Recovery, then Settings.
- The top bar owns the active project and compact live sync state.
- Views own their content hierarchy. Do not place every section inside a card; use spacing, section labels, and subtle separators first.
- The Files view keeps Monaco and provides a user-resizable tree/editor split.

## Accessibility

- Every interactive control has a visible keyboard focus state and an accessible name.
- Color never carries state alone; use text, icons, or labels with semantic color.
- Keep disabled controls readable and avoid hover-only access to important status.

## Implementation guardrails

- Prefer existing React components and CSS tokens over adding a UI framework.
- Preserve Electron, Zustand, Monaco, translations, IPC contracts, and collaboration behavior.
- Add a component only when it reduces real duplication or makes interaction semantics clearer.

## Collaboration intelligence

- Activity sessions derive from real operations; people and AI tools remain visually attributable.
- Shared-recent activity, potential overlap, and confirmed conflict are distinct states. A warning is not a claim of conflict.
- Team Health uses only observable states: Watching, Connected, Reconnecting, Offline, and local-only. Do not label a project “Synced” without an acknowledgement protocol.

## Recovery philosophy

- Checkpoint restore always compares against the current revision and creates a recovery checkpoint before mutation.
- Dirty editor content blocks destructive conflict and restore actions.
- Session rollback remains analysis-only until a safe three-way revert exists.

## Power-user interaction

- `Cmd/Ctrl+P` opens files, `Cmd/Ctrl+K` opens commands, and `Cmd/Ctrl+S` saves the active editor.
- The collapsed sidebar must retain accessible labels and visible focus states.
- Hackathon controls support left/right scene navigation outside editable controls.

## Hackathon Simulation

- Simulation is a renderer-memory demo boundary, not a project mode.
- It may reuse pure derivation helpers and product presentation components.
- It must never call filesystem mutation, room/network actions, real checkpoint IPC, oplog persistence, project mutations, sharing, or GitHub export.

# Cairn UI Redesign v3

This document records the v3 interface baseline, the completed design decisions, and the release regression scenarios. It complements `UI.md`, which remains the source of truth for product-level design principles.

## Baseline inventory

Before the v3 pass, Cairn already supported project history, grouped and raw activity, file editing, team rooms, conflict resolution, checkpoints, Trash, settings, onboarding, command search, keyboard shortcuts, and Hackathon Mode. The renderer continued to access file, network, and persistence operations only through the preload IPC boundary.

The main UX gaps were:

- the status-aware top bar existed but was not mounted in the app shell;
- sidebar section labels had styles but were not rendered;
- Home used nested interactive controls and did not clearly identify the page purpose;
- Activity search disappeared in a narrow window;
- Monaco used the generic `vs-dark` theme instead of Cairn surfaces and semantic colors;
- modal implementations handled Escape inconsistently and did not consistently trap or restore focus;
- older documentation screenshots no longer represented the current desktop interface.

## Implemented specification

- Neutral surfaces use `#111216`, `#17191E`, and `#1F2228`, with `#C85A67` reserved for selection and primary interaction.
- The persistent workspace header shows only observable states derived by `deriveTeamHealth` and `derivePrimaryTeamStatus`. It never claims full synchronization.
- Navigation is grouped into Project, Collaboration, and Recovery, with Settings anchored at the bottom. The smallest layout collapses labels while retaining accessible names.
- Project cards keep opening and management controls as separate valid interactive elements. Only the active project displays active operation and peer data.
- Activity retains grouped/raw modes, contributor filters, search, expandable sessions, raw diffs, and the non-disruptive new-change notice.
- Files retains the resizable tree, dirty-state tracking, save protection, remote-change warnings, and keyboard save. Editor and diff surfaces use the Cairn Monaco theme.
- Team, conflicts, checkpoints, Trash, onboarding, settings, command search, and Hackathon Mode keep their existing behavior and safety guards.
- Shared modal focus handling covers initial focus, Escape, Tab containment, and focus restoration for confirmation, search, activity preview, and operation-diff surfaces.
- Reduced-motion behavior remains supported.

## Visual regression scenarios

Check each scenario at 1920×1080, 1440×900, 1280×800, 1024×768, and the supported minimum window (at least 900×650):

- Projects: empty, one project, multiple projects, unavailable directory, active project, long names and paths.
- Activity: empty, grouped, raw, contributor filters, search, active conflict banner, expanded session, new activity while scrolled.
- Files: no selection, deep tree, long path, selected file, dirty file, save error, remote activity warning, unresolved conflict.
- Team: local only, room ready, connected peers, reconnecting, offline, identity mismatch, advanced direct connection.
- Conflicts: empty, active conflict, dirty-file blocked resolution.
- Checkpoints: empty, populated history, comparison, text diff, binary diff, dirty-file blocked restore, delete confirmation.
- Trash: empty, populated, single restore/delete, empty-all confirmation, retention copy.
- Global: Settings, onboarding, command palette, project switcher, Quick Open, dialogs, collapsed sidebar, English and Chinese, Hackathon live/simulation/presentation modes.

## Manual release checklist

- [ ] Add, reopen, switch, relocate, and remove a project.
- [ ] Start and stop local watching.
- [ ] Create and join a team; lose and restore peer connectivity.
- [ ] Search and filter grouped and raw Activity without losing data.
- [ ] Open, edit, save, and switch files with unsaved changes.
- [ ] Review operation, checkpoint, and conflict diffs.
- [ ] Resolve a conflict with all dirty-file safeguards intact.
- [ ] Create, compare, restore, and delete a checkpoint.
- [ ] Restore and permanently remove a Trash item.
- [ ] Complete onboarding and use every documented keyboard shortcut.
- [ ] Enter and exit Hackathon Mode without touching real workspace state in simulation.
- [ ] Run the full suite on macOS and Windows before publishing release artifacts.

## Automated verification

Run:

```bash
npm run lint
npm test
npm run build
```

Passing automated checks is necessary but does not replace the manual desktop and platform checklist above.

# Changelog

All notable changes to Cairn.

## [2.0.0-rc.3] - 2026-10-19

### Added

- Added a dedicated project launcher that opens at startup and keeps the workspace dashboard separate from recent projects.
- Added Home and recent-project navigation to the project dropdown.
- Added restrained motion across navigation, cards, lists, dialogs, feedback, and dashboard charts with reduced-motion support.
- Added packaged MIT-compatible terms and expanded privacy disclosures for recent projects, peer copies, and project removal.

### Changed

- Reworked the dashboard, activity cards, empty counts, feedback messages, editor presentation, project context, and responsive interaction states.
- Made dashboard change data react to real watched-folder activity.
- Deferred Monaco loading until an editor or diff is opened, reduced bundled font subsets, and standardized development and release jobs on Node.js 22 or newer.

### Fixed

- Prevented activity cards from overlapping the Changes heading and controls.
- Corrected checkpoint, conflict, and deleted-file zero-count presentation.
- Corrected weekly change grouping and several focus, dialog, and navigation edge cases.

### Verification

- Made the two-peer sync verification deterministic by using authenticated direct TCP instead of optional mDNS discovery.
- Added legal-artifact and release-document checks to CI and release verification.
- GitHub draft releases now use the reviewed release notes and include a SHA-256 manifest.

## [2.0.0-rc.1] - 2026-10-08

### Release candidate

- P2P collaboration uses protocol v4 with encrypted peer transport and mutual room authentication.
- Older peers are incompatible. Legacy six-character room invites are rejected; generate and share new invitations.
- Existing v1, v2, and v3 operation history remains readable.
- Adds filesystem-boundary, snapshot, recovery, and release hardening completed since v1.8.0.
- macOS and Windows RC artifacts are unsigned and may show platform trust warnings.

## [1.8.0] - 2026-10-05

### Added

- Human and AI attribution, grouped Activity sessions, filters, search, and Quick Open
- Collaboration intelligence for shared activity, potential overlaps, and confirmed conflicts
- Team Health and connection diagnostics with truthful connection terminology
- Checkpoints with comparison, stale-revision protection, automatic recovery snapshots, and safer restore flows
- Hackathon Mode with an isolated in-memory project, Monaco editing, conflicts, and checkpoint recovery

### Changed

- Activity is file-centric and the desktop navigation, settings, and Files workspace received a developer-tool polish pass
- Supported images and fonts can be synchronized as content-addressed blobs

### Safety

- Destructive checkpoint and conflict-resolution flows create automatic safety checkpoints
- Hackathon Simulation never accesses real project files, rooms, checkpoints, oplog storage, or GitHub actions
- `.gitignore`, `.cairnignore`, and sensitive-file rules are respected by watching and snapshots

## [1.0.1] - 2026-10-01

### Fixed

- Preserve empty files during sync and restore files if trash processing fails
- Exclude sensitive files and block project-boundary escapes through symbolic links
- Decode fragmented UTF-8 TCP messages safely and reject oversized messages

## [1.0.0] - 2026-10-01

First public release.

### Added

- Real-time file sync over local network (LAN)
- P2P project download between teammates
- Team invite codes and direct IP:port connection
- File deletion protection (30-day trash)
- Shadow git integration for PR export
- GitHub PR export
- First-run onboarding
- Bilingual UI (English / Chinese)
- Windows and macOS builds via GitHub Actions

### Known limitations

- Automatic mDNS discovery may not work on all networks (use Direct connection)
- Binary files are not synced
- No code signing (see README for first-launch instructions)

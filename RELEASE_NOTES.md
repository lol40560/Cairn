# Cairn v2.0.0-rc.3

> Release candidate — not a stable release. RC artifacts are created as GitHub Release drafts for explicit human review before publishing.

## Highlights

- Cairn now opens to a dedicated project launcher. Choose a recent project to enter its dashboard, then use the project dropdown to return Home or move between recent projects.
- The dashboard, Changes view, project cards, file workspace, dialogs, and feedback now share a calmer visual system with responsive hover, entrance, and state animations.
- Dashboard activity reflects real watched-folder changes, and empty conflict, checkpoint, and deleted-file counts no longer add misleading zero labels.

## Navigation and interface

- Separates the all-projects Home screen from each project’s dashboard.
- Adds Home and recent projects to the current-project dropdown.
- Improves keyboard focus, dialogs, editor loading, responsive activity controls, warm dashboard surfaces, compact bottom-right messages, and reduced-motion support.
- Prevents Changes cards from covering the page heading and filters.

## Protocol and compatibility

- P2P collaboration now uses protocol v4 with encrypted peer transport and mutual room authentication.
- Older Cairn peers are incompatible with this release candidate and cannot join v4 rooms.
- Legacy six-character room invites are rejected. Create and share a newly generated invitation with every teammate.
- Existing v1, v2, and v3 operation history remains readable; no project-history reset is required.

## Safety & reliability

- Cairn protects current state before destructive checkpoint restore and conflict actions.
- Dirty editor content blocks unsafe actions.
- Hackathon Simulation is entirely in memory and never touches a real project, room, checkpoint store, or GitHub export.
- Weekly change grouping, watcher verification, and release-document validation are more deterministic.

## Developer experience

- Quick Open, Command Palette, keyboard navigation, Activity filters/search, file-centric activity, and Monaco diff inspection.
- Refined workspace navigation, persistent project context, keyboard focus handling, and a Cairn-themed editor.
- Production builds defer Monaco until an editor or diff is opened, reducing initial renderer startup work.

## Legal and distribution

- Cairn remains MIT licensed. The new Terms of Use clarify application behavior without reducing MIT rights.
- The privacy policy now covers recent-project metadata, project-list removal, and copies already shared with peers.
- Runtime third-party notices include the bundled Anton and Outfit fonts.
- Release artifacts remain unsigned and now ship with the legal documents; the GitHub draft includes SHA-256 checksums.

## Known limitations

- Cairn does not claim full convergence because the protocol does not provide acknowledgement-based sync proof.
- Session rollback is analysis-only until a safe three-way revert is implemented.
- Binary conflict comparison remains metadata-only.
- Recovery protects project boundaries and preserves checkpoints, but it is not a substitute for an external backup strategy.
- macOS and Windows artifacts are unsigned. Expect Gatekeeper or SmartScreen warnings during RC testing.

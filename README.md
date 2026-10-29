<p align="center">
  <img src="./build/icon.png" width="108" alt="Cairn app icon" />
</p>

<h1 align="center">Cairn</h1>

> **Cairn Next preview:** This branch also includes the independently runnable [Cairn Next app](./cairn-next/README.md), with the bright UI and recoverable project collaboration. The original Cairn app and its root commands remain available. The download links below refer to the original Cairn releases; this branch publishes the Next source, not new installers or a release tag.

<p align="center"><strong>Know what changed. Catch overlap early. Recover with confidence.</strong></p>

<p align="center">
  A local-first desktop workspace for developers and AI coding agents.<br>
  Follow project activity, collaborate peer-to-peer, and restore the work that matters.
</p>

<p align="center">
  <a href="https://github.com/lol40560/Cairn/releases">Download for macOS or Windows</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#quick-start">Get started</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#how-cairn-works">How it works</a>
</p>

<p align="center">
  <a href="https://github.com/lol40560/Cairn/releases/tag/v2.0.3"><img alt="Release v2.0.3" src="https://img.shields.io/badge/release-v2.0.3-222222?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-222222?style=flat-square" /></a>
  <img alt="macOS and Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-222222?style=flat-square" />
  <a href="https://hub.xerj.org/contributors/lol40560"><img alt="XERJ Corpus Hub contributor" src="https://hub.xerj.org/contributors/lol40560/badge.svg" /></a>
</p>

<p align="center">
  <img src="./docs/screenshots/overview.png" width="100%" alt="Cairn's dark desktop dashboard with project activity and recent changes" />
</p>

> **Release status:** Cairn v2.0.3 installers are not code-signed. See [known limitations](#known-limitations) before relying on it for critical work.

## Why Cairn?

Modern development happens across people, editors, and AI coding tools. Several tools may change the same project in minutes, but understanding *what happened*, *where work overlaps*, and *how to recover* still takes effort.

**Cairn keeps those answers close to your files.** It observes local project changes, organizes a readable activity trail, flags possible overlapping edits, and provides file-level recovery tools. When you choose to collaborate, it shares project updates directly with teammates rather than through a Cairn-hosted cloud service.

| See the work | Work together | Keep a way back |
| :--- | :--- | :--- |
| File-grouped activity, search, contributor context, and readable diffs. | Peer-to-peer project sharing and awareness of possible concurrent edits. | Checkpoints, protected restores, conflict review, and deleted-file recovery. |

## Inside Cairn

### A home for every project

See recent activity and project context without jumping between a terminal, a file explorer, and a version-control interface. Cairn's workspace surfaces recent changes while keeping your files central.

### Your files, with the context attached

Browse a project tree, inspect code in the integrated Monaco editor, and save edits from within Cairn. Quick Open, a command palette, keyboard navigation, and change diffs make it easier to move from an activity event to the actual file.

<p align="center">
  <img src="./docs/screenshots/files.png" width="100%" alt="Cairn files workspace with a project tree and syntax-highlighted code editor" />
</p>

### Collaboration without a Cairn account

Create a team for a project, share an invitation, and connect with peers over a reachable network. Cairn uses protocol-v4 authenticated, encrypted peer transport and provides direct-connection troubleshooting when automatic discovery is unavailable.

<p align="center">
  <img src="./docs/screenshots/team.png" width="100%" alt="Cairn Team screen with create-team and join-team options" />
</p>

### Built for the messy moments

Potential overlap is different from a confirmed conflict. Cairn helps distinguish the two, gives you a place to review same-file edits, and retains recovery options when you need to inspect or restore an earlier state.

<table>
  <tr>
    <td width="50%" align="center"><img src="./docs/screenshots/conflicts.png" width="100%" alt="Cairn's same-file edit and conflict review screen" /></td>
    <td width="50%" align="center"><img src="./docs/screenshots/checkpoints.png" width="100%" alt="Cairn checkpoints and restore screen" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Conflict review</strong><br>Inspect same-file edits and resolve confirmed conflicts.</td>
    <td align="center"><strong>Checkpoints</strong><br>Save recoverable snapshots before you need them.</td>
  </tr>
</table>

<details>
  <summary><strong>More screens: deleted files and settings</strong></summary>
  <p>Recover recently deleted files from local trash, configure retention, and access application and GitHub integration settings.</p>
  <p><img src="./docs/screenshots/deleted-files.png" width="100%" alt="Cairn deleted files recovery screen" /></p>
  <p><img src="./docs/screenshots/settings.png" width="100%" alt="Cairn settings screen" /></p>
</details>

## What Cairn can do

- **Readable change history.** Group operations into activity sessions, filter by contributor, search activity, and inspect file diffs.
- **Human + AI context.** Attribute known edits to contributors and AI tools so activity is easier to follow.
- **Overlap and conflict awareness.** Surface potential same-file interference separately from confirmed conflicts and provide review and resolution tools.
- **Recovery by design.** Create checkpoints, compare revisions, safeguard destructive restores, and retrieve deleted files during the configured retention period.
- **Local peer collaboration.** Share a project using invitations, with peer health and direct-connection diagnostics.
- **Developer-focused extras.** Edit files in Monaco, export changes to a GitHub pull request on request, and explore features safely in an isolated Hackathon Simulation.

## Quick start

**1. Download the app.** Get the latest available installer from [GitHub Releases](https://github.com/lol40560/Cairn/releases). Choose the macOS `.dmg` for your architecture or the Windows `Cairn-Setup-*.exe`. Current builds are unsigned.

**2. Open a project.** Launch Cairn and choose a project folder. Its dashboard gives you a place to inspect activity and files.

**3. Share it when needed.** Open **Team**, choose **Start a team**, and give a teammate the invitation. Teammates can choose **Join a team** and retrieve the project into their selected folder.

**4. Use the recovery tools.** Create a checkpoint before a risky change; inspect **Same-file edits** if collaboration produces overlapping work; recover eligible deleted files from **Deleted files**.

> **Network note:** For automatic discovery, collaborators should be on the same reachable Wi-Fi network or hotspot. If discovery is blocked, open the Team screen's advanced direct-connection option and use the host's `IP:port` address. Some campus and corporate networks block device-to-device traffic.

## How Cairn works

```text
Your project folder
       │
       ▼
Local file watcher ──► Local operation history ──► Activity & diffs
       │                        │
       │                        └──► Checkpoints & recovery
       │
       └──► Authenticated, encrypted P2P connection
                              │
                              ▼
                      Invited teammates

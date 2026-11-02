# Cairn

Cairn is a local-first desktop workspace for project collaboration, change history and recovery.

## Which version?

| | Cairn Next | Original Cairn |
| --- | --- | --- |
| Status | **0.2.0-rc.2 source preview**, under development | **v2.0.3**, latest published installers |
| Location | [cairn-next/](cairn-next/README.md) | Repository root |
| Download | No published installer for this preview | [macOS and Windows releases](https://github.com/lol40560/Cairn/releases/tag/v2.0.3) |

The two apps have different protocols and internal data formats. They cannot collaborate with each other, and their databases are not automatically migrated. Keep a backup and import a copy of ordinary project files into a new folder.

## Cairn Next

The preview includes a project file tree and editor, LAN collaboration, activity history, conflict review, checkpoints and recovery. Version 0.2.0-rc.2 refreshes the interface; its collaboration and storage core remains the same as rc.1.

The host app must remain open for a team to connect. Physical two-device LAN, macOS, real OS input methods and live GitHub export remain unverified. Back up projects independently; sharing rules cannot detect every secret inside ordinary files.

For setup, limits and verification details, see the [Cairn Next README](cairn-next/README.md), [changelog](cairn-next/CHANGELOG.md), and [release readiness](cairn-next/docs/release-readiness.md).

## Original Cairn

The root package remains available for maintenance and builds. The published v2.0.3 installers are unsigned. See the [release notes](RELEASE_NOTES.md), [changelog](CHANGELOG.md), and [user manual](docs/USER_MANUAL_zh-TW.md). The root release workflow builds this original app, not Cairn Next.

## License

The root project includes an [MIT license](LICENSE). The separate Cairn Next package declares `UNLICENSED`; its licensing and rights need clarification with its copyright holders before redistribution. Third-party dependency notices are available for the [original app](THIRD_PARTY_NOTICES.md) and [Cairn Next](cairn-next/THIRD_PARTY_NOTICES.md).

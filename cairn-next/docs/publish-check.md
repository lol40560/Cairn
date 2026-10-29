# Source branch validation

Checked on Windows 10 x64 on 2026-10-30. This source preview is added alongside the original Cairn application; it is not a new binary release or a merge into `main`.

## Checks completed from this repository layout

- `pnpm install --frozen-lockfile --offline` succeeded using the pinned dependencies.
- `node scripts/verify.cjs --desktop` in `cairn-next/` passed Node and renderer TypeScript checks, the production build, **163/163 core tests**, **10 actual Electron user flows**, and **two startup-close checks**.
- The actual flows covered folder opening, file operations, two app instances over authenticated WSS, concurrent editing/undo/IME composition, recovery, exports, offline work, restart, and the isolated practice workspace.
- The original root release-document check passed. Its newline handling now accepts Windows CRLF as well as LF while still rejecting a wrong release heading or changelog version. A regression case is included.
- Root test/typecheck paths remain scoped to the original app. Root ESLint excludes the standalone `cairn-next/` package, which runs its own checks. Original application files and release workflows were not replaced.
- Tracked source was checked for credentials, private runtime state, and generated binaries. Credential-like test strings were verified as fixtures. Installers, `node_modules`, app profiles, invitation files, local QA logs and databases are not included.

The original app's full native-module test suite was not rerun as part of this standalone source import. Raw machine-local QA reports are intentionally not committed. The screenshots in this package show only sample/practice data.

## Scope still unverified

These checks used one Windows machine with independent processes/app profiles. They do not establish physical two-device LAN behavior, macOS execution, physical OS IME operation, or live GitHub PR export. Builds remain unsigned. See the user guide and two-device checklist for those checks.

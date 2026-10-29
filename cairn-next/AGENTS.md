# Cairn Next

This directory is a standalone application package added alongside the original Cairn app. Run its commands from this directory. The root app's `src/`, `electron/core/`, npm scripts and native SQLite setup continue to describe the original app.

- Keep renderer code in `ui/`, the restricted IPC bridge in `electron/`, shared contracts in `shared/`, and collaboration/storage logic in `core/`.
- Use the pinned pnpm lockfile and Node 24.x. This package uses Node's built-in SQLite; do not add the root app's `better-sqlite3` rebuild steps here.
- `pnpm check`, `pnpm build`, `pnpm verify`, and `pnpm test:desktop` are the relevant checks. Desktop tests use isolated temporary project folders and profiles.
- Preserve the durable outbox, document identities, revision/generation checks, file projection safeguards, ignore rules, access checks and recovery copies.
- Treat `.cairn-next` state, invitations, credentials and user projects as private. Do not commit runtime state, `node_modules`, generated builds or local QA output.
- Do not automatically migrate or overwrite original Cairn data. The two apps use different collaboration/data formats.
- PC server operations remain a noninteractive Coming Soon item. A creator's app hosts its LAN team only while the app is running.
- Publishing a branch does not authorize a tag, GitHub Release, store submission or automatic merge.

# Cairn

Real-time collaboration for teams using AI coding tools. Work on the same files with your teammates — no git pull, no conflicts.

## Why

When multiple people (and their AI agents like Cursor or Claude Code) edit the same codebase, git becomes painful. Cairn syncs changes in real time over your local network.

- **Local-first** — your code never leaves your computer unless you share it
- **P2P** — no server, no accounts, no cloud
- **AI-friendly** — works with any editor and any AI coding tool

## Features

- Real-time file sync over WiFi
- Zero-config team sharing with invite codes
- One-click project download for new teammates
- Deleted file protection (30-day retention)
- Export to GitHub PR
- Works with any editor

## Screenshots

![Cairn main view](./docs/screenshots/main.png)

_Coming soon — screenshots will be added after v1.0 release._

## Download

### macOS

1. Download the latest `.dmg` from [Releases](https://github.com/lol40560/Cairn/releases)
2. Open the `.dmg` and drag Cairn to Applications
3. First launch: right-click → Open → Confirm (app is not code-signed yet)

### Windows

1. Download the latest `Cairn-Setup-*.exe` from [Releases](https://github.com/lol40560/Cairn/releases)
2. Double-click to install
3. If SmartScreen warns: More info → Run anyway (app is not code-signed yet)

## Requirements

Cairn works over your **local network**. All teammates must be on the same WiFi or the same hotspot.

If automatic discovery doesn't work, use the **Direct connection** feature:

1. The host opens Team view
2. Scroll down to find "Direct connection" showing something like `192.168.1.5:49500`
3. Copy that address
4. Teammates enter it in the "Join a team" input box

## Common issues

**"Cairn.app is damaged and can't be opened" (macOS)**

The app is not code-signed yet. After downloading, run:

```bash
xattr -cr /Applications/Cairn.app
```

Then open the app normally.

**Windows: SmartScreen blocks the app**

Click "More info" → "Run anyway".

**Teammates can't find each other**

- Make sure you're on the same WiFi or hotspot
- Try the Direct connection feature (see above)
- If on a corporate or campus WiFi, AP isolation may block device-to-device traffic — use a phone hotspot instead

## Quick Start

### Start a new team

1. Open Cairn
2. Choose a project folder
3. Click "Start a team"
4. Share the invite code with teammates

### Join a team

1. Open Cairn
2. Click "Join a team"
3. Enter the invite code (or IP:port if discovery fails)
4. Choose where to save the project
5. Click "Get files"

## How it works

Cairn watches your project folder for changes. When a file changes, it generates a change event (diff), stores it locally, and broadcasts it to teammates over the local network.

- Changes are tracked in `.cairn/` inside your project
- Deleted files go to `.cairn/trash/` for 30 days
- A shadow git repo runs in the background — export to GitHub PR anytime

## Development

### Requirements

- Node.js 20+
- npm

### Commands

```bash
npm install         # install dependencies
npm run dev         # run in development
npm test            # run tests
npm run lint        # lint
npm run build       # build for production
npm run dist:mac    # build macOS app
npm run dist:win    # build Windows app (on Windows)
```

## Privacy

Cairn is local-first. We don't collect any data. See [PRIVACY.md](./PRIVACY.md).

## License

MIT — see [LICENSE](./LICENSE).

Third-party attributions are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

# Agent Desktop

Electron + React desktop client for the [pi coding agent](https://github.com/badlogic/pi-mono). It connects to a real `pi --mode rpc` process, shares pi's sessions and credentials, and adds a multi-project desktop UI.

## Features

- Project-grouped session sidebar with per-project search and status filters
- Streaming chat, tool cards, Markdown, thinking blocks, abort/queue
- Model picker and model allow-list per provider
- Provider login (OAuth / API key), custom providers via `models.json`
- Light and dark themes
- Conversation outline and user-message timeline
- Session storage shared with pi, or isolated to the desktop app
- System proxy support (OAuth, updates, and the pi child process)
- Auto update via GitHub Releases (`electron-updater`)

## Development

Requires Node.js 24+.

```bash
npm install
npm run dev      # Electron + Vite HMR
npm start        # build and run
npm run typecheck
npm run build
```

## Packaging

```bash
npm run dist     # NSIS installer in release/
npm run release  # build and publish to GitHub Releases (needs GH_TOKEN)
```

The update feed defaults to `touwaeriol/agent-desktop`. Override it with:

```bash
PI_DESKTOP_UPDATE_REPO=owner/repo
PI_DESKTOP_UPDATE_URL=http://example.com/feed
PI_DESKTOP_RELEASES_URL=https://github.com/owner/repo/releases
```

Tagging `v*` runs `.github/workflows/release.yml`, which builds the Windows installer and publishes the GitHub Release.

## Sessions

By default the app uses pi's session directory (`~/.pi/agent/sessions`). You can switch to an isolated directory in Settings → General. Both modes use pi's JSONL format.

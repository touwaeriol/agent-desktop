# Agent Desktop

Electron + React desktop client for the [pi coding agent](https://github.com/badlogic/pi-mono). It connects to a real `pi --mode rpc` process, shares pi's sessions and credentials, and adds a multi-project desktop UI.

## Features

- Project-grouped session sidebar with per-project search and status filters
- Streaming chat, tool cards, Markdown, thinking blocks, abort/queue
- Paste or drop images into the composer; images are sent to the model and stay viewable in the transcript
- Model picker and model allow-list per provider
- Provider login (OAuth / API key), custom providers via `models.json`
- Light and dark themes
- Conversation outline and user-message timeline
- Session storage shared with pi, or isolated to the desktop app
- MCP settings: master switch, server list, and a built-in desktop tool
- `ask_user_question` tool: agents ask questions in a desktop dialog (single choice, multi-select, free text, answered in order)
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

## Images

Paste a screenshot into the composer (Ctrl+V) or drop image files onto it. Images pasted at the very start of the message are collected in a strip above the input; images pasted in the middle are inserted at the caret as `[图片N]` markers with their thumbnails under the input. Click any thumbnail to open it full size, and click the × to remove it. Sent images are stored in the session and render in the transcript, where clicking one opens the same preview.

## Sessions

By default the app uses pi's session directory (`~/.pi/agent/sessions`). You can switch to an isolated directory in Settings → General. Both modes use pi's JSONL format.

## MCP and the desktop question tool

Settings → MCP controls MCP support: a master switch (pi starts with `--no-mcp` when off), the server list from `~/.pi/agent/mcp.json`, and a built-in desktop tool.

The built-in tool is `mcp__desktop__ask_user_question`. It is registered by a pi extension the app loads with `--extension`, so nothing is written into `mcp.json` and terminal pi sessions are unaffected. Agents call it to ask you something: the question appears in a panel directly above the composer, supports single choice, multi-select, and free-form typing (no need to pick "other" first), and multiple questions are answered one at a time with the option to go back and change earlier answers. The answer goes back to the model as the tool result.

The pieces live in `packages/mcp-ask-user` (stdio MCP server), `apps/desktop/resources/extension` (pi extension that registers it), and `apps/desktop/src/main/bridge.ts` (loopback bridge between the MCP server and the window).

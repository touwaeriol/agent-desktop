# Prophey

Electron + React desktop client for a coding agent. Prophey runs its own engine
(`apps/desktop/src/main/agent/prophey-engine.ts`) and keeps the [pi coding agent](https://github.com/badlogic/pi-mono)
as a swappable engine underneath (`pi --mode rpc`), so pi's sessions and credentials
still work while the app owns the loop, the tools and the session model.

## Features

- Project-grouped session sidebar with per-project search and status filters
- Streaming chat, tool cards, Markdown, thinking blocks, abort/queue
- Paste or drop images into the composer; images are sent to the model and stay viewable in the transcript
- Model picker and model allow-list per provider
- Provider login (OAuth / API key), custom providers via `models.json`
- Light and dark themes
- Conversation outline and user-message timeline
- Session storage shared with pi, or isolated to the desktop app
- Own engine (`prophey`): provider call, tool loop over the root-aware tools, and the app's own session list
- Multi-directory projects: one session can work across several folders, with `root`-scoped tools
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

The update feed defaults to `touwaeriol/prophey`. Override it with:

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

The pieces live in `packages/mcp-core` (stdio MCP server — the core interaction server; new desktop tools go in `packages/mcp-core/tools`), `apps/desktop/resources/extension` (pi extension that registers it), and `apps/desktop/src/main/bridge.ts` (loopback bridge between the MCP server and the window).

### Built-in engines: CodeGraph and WarpGrep

Two optional engines can be enabled per app, both used through the same extension:

| Engine | Setup | What it adds |
| --- | --- | --- |
| CodeGraph | `npm i -g @colbymchenry/codegraph` | Symbol search, call relationships, impact analysis over a project index |
| WarpGrep | Morph API key | Natural-language code search: several rounds of grep/read, then the relevant files |

The app runs a small MCP gateway in its main process — one loopback service with one endpoint per engine (`/mcp/codegraph`, `/mcp/warpgrep`) — and pi connects to those endpoints. The gateway holds the real engine (a stdio MCP server for CodeGraph, an in-process search for WarpGrep) and only lists the tools in its allowlist, so the model sees 8 CodeGraph tools and 1 WarpGrep tool instead of everything the engines offer.

CodeGraph results list symbols, signatures and `file:line` locations; source bodies are only returned when a call sets `includeSource: true`. WarpGrep returns file paths and line ranges the same way, and file excerpts read during a search are sent to the Morph API.

Of those, the core ones (`codegraph_explore/search/callers/impact`, `codebase_search`) are declared directly; the rest load on demand through `tool_search`.

### Subagents

The main agent can start subagents — separate `pi` processes that work on a task in the project — and drive them through eight desktop tools: `search_agents`, `list_models`, `start_subagent`, `get_subagent`, `wait_subagent`, `send_subagent_prompt`, `stop_subagent`, `get_subagent_changes`.

- Results are Markdown and, by default, only the final answer plus a summary of what the subagent touched. The transcript is opt-in (`include: ["messages"]`), because a running subagent's full history is the expensive thing to put in context.
- Four presets ship built in (`explorer`, `reviewer`, `tester`, `worker`) and are stored in `%APPDATA%/agent-desktop/agents.json`; every preset field can be overridden per call.
- Presets are either listed in the system prompt (`agents.exposure: "prompt"`), found through `search_agents` (`"lazy"`), or not mentioned at all (`"hidden"`). There is no loading step: a preset id works as soon as the model knows it.
- Subagents run with `--no-mcp`: they cannot ask the user questions or start further subagents.

Every built-in tool can be switched off individually in Settings → MCP; a disabled tool is registered as `hidden`, so the model never sees it. The CodeGraph index (`.codegraph/`) is built automatically when a project has none — re-indexing stays a manual action, because the running server holds the index lock.


/**
 * Tools of the Agent Desktop core interaction MCP server.
 *
 * Add new desktop tools here: export an object with `name`, `title`, `description`, `inputSchema`
 * and `call(args, context)`. `context` provides `request(method, path, payload, signal)` for the
 * local bridge (plus `post` for POST-only calls), the abort `signal` of the current MCP request, and
 * `log(message)` for stderr.
 *
 * Subagent tools are only listed when the app enables them (`AGENT_DESKTOP_SUBAGENTS=1`).
 * Root-aware file tools are only listed for a session that covers several directories
 * (`AGENT_DESKTOP_ROOTS` with more than one entry); with a single directory pi's own read/grep are
 * better and the extra tools would just duplicate them.
 */
import { askUserQuestion } from './ask-user.mjs'
import { subagentTools } from './subagent.mjs'
import { workspaceTools } from './workspace.mjs'

const subagentsEnabled = process.env.AGENT_DESKTOP_SUBAGENTS === '1'

function multiRoot() {
  try {
    const parsed = JSON.parse(process.env.AGENT_DESKTOP_ROOTS ?? '[]')
    return Array.isArray(parsed) && parsed.length > 1
  } catch {
    return false
  }
}

export const tools = [
  askUserQuestion,
  ...(multiRoot() ? workspaceTools : []),
  ...(subagentsEnabled ? subagentTools : [])
]

/**
 * Tools of the Agent Desktop core interaction MCP server.
 *
 * Add new desktop tools here: export an object with `name`, `title`, `description`, `inputSchema`
 * and `call(args, context)`. `context` provides `request(method, path, payload, signal)` for the
 * local bridge (plus `post` for POST-only calls), the abort `signal` of the current MCP request, and
 * `log(message)` for stderr.
 *
 * Subagent tools are only listed when the app enables them (`AGENT_DESKTOP_SUBAGENTS=1`).
 */
import { askUserQuestion } from './ask-user.mjs'
import { subagentTools } from './subagent.mjs'

const subagentsEnabled = process.env.AGENT_DESKTOP_SUBAGENTS === '1'

export const tools = subagentsEnabled ? [askUserQuestion, ...subagentTools] : [askUserQuestion]

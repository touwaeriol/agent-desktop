/**
 * Tools of the Agent Desktop core interaction MCP server.
 *
 * Add new desktop tools here: export an object with `name`, `title`, `description`, `inputSchema`
 * and `call(args, context)`. `context` provides `post(path, payload, signal)` for the local bridge,
 * the abort `signal` of the current MCP request, and `log(message)` for stderr.
 */
import { askUserQuestion } from './ask-user.mjs'

export const tools = [askUserQuestion]

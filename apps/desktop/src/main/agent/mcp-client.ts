import { pathToFileURL } from 'node:url'
import type { Tool } from '@earendil-works/pi-ai'
import type { CoreTool } from './core-tools'

/**
 * An MCP client for the Prophey engine.
 *
 * pi reaches the app's MCP servers through its own MCP client; the Prophey engine has no such
 * client, which meant codegraph, warpgrep, web and `ask_user_question` were simply unavailable when
 * it ran. The bridge already speaks MCP over streamable HTTP on `/mcp/<key>`, so this is a small
 * client over the same endpoints — not a second gateway.
 */

interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface McpEndpoint {
  /** Server name as the model sees it (`codegraph`, `codegraph__git`, …). */
  name: string
  url: string
  token: string
  description?: string
}

let sequence = 0

async function rpc(
  endpoint: McpEndpoint,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${endpoint.token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
      signal: controller.signal
    })
    const text = await response.text()
    // The bridge answers plain JSON; a server-to-client stream would arrive as SSE, which these
    // endpoints never use (GET answers 405), so one JSON body is the whole reply.
    const payload = text.trim()
    if (!payload) return undefined
    const parsed = JSON.parse(payload) as {
      result?: unknown
      error?: { message?: string }
    }
    if (parsed.error) throw new Error(parsed.error.message ?? 'MCP 调用失败')
    return parsed.result
  } finally {
    clearTimeout(timer)
  }
}

/** List the tools of one endpoint, or an empty list when it is not answering. */
async function listTools(endpoint: McpEndpoint): Promise<McpTool[]> {
  try {
    await rpc(endpoint, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'prophey-engine', version: '0.1.0' }
    })
    const result = (await rpc(endpoint, 'tools/list')) as { tools?: McpTool[] } | undefined
    return result?.tools ?? []
  } catch {
    return []
  }
}

/** Tool results from MCP are content arrays; keep text and images, drop the rest. */
function toContent(result: unknown): Array<{ type: string; text?: string }> {
  const content = (result as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(result ?? {}) }]
  return content
    .filter((block): block is { type?: string; text?: string } => Boolean(block && typeof block === 'object'))
    .map((block) => ({
      type: block.type ?? 'text',
      ...(typeof block.text === 'string' ? { text: block.text } : {})
    }))
}

/**
 * Load every configured endpoint as tools named `mcp__<server>__<tool>`, the same names pi gives
 * them, so a prompt that mentions a tool keeps working when the engine changes.
 */
export async function loadMcpTools(endpoints: McpEndpoint[]): Promise<CoreTool[]> {
  const tools: CoreTool[] = []
  for (const endpoint of endpoints) {
    const listed = await listTools(endpoint)
    for (const tool of listed) {
      const name = `mcp__${endpoint.name}__${tool.name}`
      tools.push({
        name,
        description: tool.description ?? `${endpoint.name} 的 ${tool.name}`,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        call: async (args) => {
          try {
            const result = await rpc(endpoint, 'tools/call', { name: tool.name, arguments: args ?? {} })
            const content = toContent(result)
            const failed = Boolean((result as { isError?: boolean } | undefined)?.isError)
            return { content, ...(failed ? { isError: true } : {}) }
          } catch (error) {
            return {
              content: [
                { type: 'text', text: error instanceof Error ? error.message : String(error) }
              ],
              isError: true
            }
          }
        }
      })
    }
  }
  return tools
}

/** Kept for symmetry with the other loaders; tools are declared the same way. */
export function mcpToolDeclarations(tools: CoreTool[]): Tool[] {
  return tools.map(
    (tool) =>
      ({ name: tool.name, description: tool.description, parameters: tool.parameters as never }) as Tool
  )
}

export { pathToFileURL }

import { pathToFileURL } from 'node:url'
import type { Tool } from '@earendil-works/pi-ai'

/**
 * The root-aware tools, as the own engine sees them.
 *
 * The implementations already exist for pi's side: `packages/mcp-core/tools/workspace.mjs` is plain
 * JS with node builtins only, served over MCP. Loading the same file here means one implementation
 * for both engines instead of a second copy that drifts.
 */
export interface CoreTool {
  name: string
  description: string
  /** JSON schema for the arguments; providers pass it through as-is. */
  parameters: Record<string, unknown>
  call(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }>
}

/** Tools in the shape a provider expects. */
export function toolDeclarations(tools: CoreTool[]): Tool[] {
  return tools.map(
    (tool) =>
      ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as never
      }) as Tool
  )
}

/**
 * The bridge the desktop tools talk to.
 *
 * pi reaches it through the MCP server (`AGENT_DESKTOP_MCP_URL`); the Prophey engine has no MCP
 * server in between, so it speaks the same JSON API directly. Same endpoints, same token, one
 * implementation of the tools.
 */
export interface BridgeOptions {
  url: string
  token: string
}

export function bridgeContext(options: BridgeOptions): Record<string, unknown> {
  const request = async (method: string, target: string, payload?: unknown): Promise<unknown> => {
    const url = new URL(target, options.url)
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const response = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-agent-desktop-token': options.token
      },
      ...(body ? { body } : {})
    })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`桥接返回了无法解析的内容：${text.slice(0, 200)}`)
    }
  }
  return {
    request,
    post: (target: string, payload?: unknown) => request('POST', target, payload),
    signal: undefined,
    log: () => {}
  }
}

/** Import the subagent tools; they drive the app's subagent manager through the bridge. */
export async function loadSubagentTools(
  modulePath: string,
  context: Record<string, unknown>
): Promise<CoreTool[]> {
  const module = (await import(pathToFileURL(modulePath).href)) as {
    subagentTools?: Array<{
      name: string
      description?: string
      inputSchema?: Record<string, unknown>
      call(args?: Record<string, unknown>, ctx?: unknown): Promise<{
        content: Array<{ type: string; text?: string }>
        isError?: boolean
      }>
    }>
  }
  const list = module.subagentTools ?? []
  return list.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.name,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    call: (args) => tool.call(args ?? {}, context)
  }))
}

/** Import the workspace tool module by absolute path (dev checkout or packaged resources). */
export async function loadWorkspaceTools(modulePath: string): Promise<CoreTool[]> {
  const module = (await import(pathToFileURL(modulePath).href)) as {
    workspaceTools?: Array<{
      name: string
      description?: string
      inputSchema?: Record<string, unknown>
      call(args?: Record<string, unknown>, context?: unknown): Promise<{
        content: Array<{ type: string; text?: string }>
        isError?: boolean
      }>
    }>
  }
  const list = module.workspaceTools ?? []
  return list.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.name,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    call: (args) => tool.call(args ?? {}, {})
  }))
}

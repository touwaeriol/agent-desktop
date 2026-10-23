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

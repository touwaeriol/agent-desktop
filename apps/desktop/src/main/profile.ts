import os from 'node:os'
import path from 'node:path'

/** Same configuration directory as pi; explicit overrides also isolate automated tests. */
export const CLI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(os.homedir(), '.pi', 'agent')

let current = CLI_AGENT_DIR

export function agentDir(): string {
  return current
}

export function setAgentDir(dir: string): void {
  current = dir
}

export function authPath(): string {
  return path.join(current, 'auth.json')
}

export function modelsPath(): string {
  return path.join(current, 'models.json')
}

export function settingsPath(): string {
  return path.join(current, 'settings.json')
}

export function mcpPath(): string {
  return path.join(current, 'mcp.json')
}

/** Session root that belongs to this profile. */
export function profileSessionDir(): string {
  return path.join(current, 'sessions')
}

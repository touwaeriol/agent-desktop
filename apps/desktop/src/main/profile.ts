/**
 * Which pi profile this window uses.
 *
 * pi reads everything from one directory (`~/.pi/agent` by default): `auth.json`, `models.json`,
 * `settings.json`, `mcp.json` and `sessions/`. The CLI and the desktop can either share it or the
 * desktop can keep its own copy, which is what `PI_CODING_AGENT_DIR` exists for.
 *
 * This module is the single source of those paths: nothing else may hardcode `~/.pi/agent`, or a
 * switch of profile would silently leave half the app writing to the CLI's files.
 */
import os from 'node:os'
import path from 'node:path'

/** Where the pi CLI keeps its config. Also the source for "import from CLI". */
export const CLI_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent')

let current = CLI_AGENT_DIR

export function agentDir(): string {
  return current
}

export function setAgentDir(dir: string): void {
  current = dir
}

/** True when the window is not using the CLI's directory. */
export function isIsolatedProfile(): boolean {
  return path.resolve(current) !== path.resolve(CLI_AGENT_DIR)
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

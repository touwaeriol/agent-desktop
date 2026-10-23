import { updateJsonFile } from './storage'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { McpServerInfo } from '../shared/types'
import { mcpPath } from './profile'

/** User-level MCP config of the active profile (CLI or desktop). */
function userMcpPath(): string {
  return mcpPath()
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/

interface RawMcpConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

export function projectMcpPath(cwd: string): string {
  return path.join(cwd, '.pi', 'mcp.json')
}

async function readConfig(file: string): Promise<RawMcpConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as RawMcpConfig
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function summarize(entry: Record<string, unknown>): {
  transport: 'stdio' | 'http'
  summary: string
} {
  if (typeof entry.url === 'string' && entry.url) {
    return { transport: 'http', summary: entry.url }
  }
  const command = typeof entry.command === 'string' ? entry.command : '(未配置)'
  const args = Array.isArray(entry.args)
    ? entry.args.filter((arg): arg is string => typeof arg === 'string')
    : []
  const line = [command, ...args].join(' ')
  return { transport: 'stdio', summary: line.length > 160 ? `${line.slice(0, 157)}…` : line }
}

function toInfo(name: string, entry: unknown, source: McpServerInfo['source']): McpServerInfo {
  const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
  const { transport, summary } = summarize(value)
  return {
    name,
    transport,
    summary,
    enabled: value.enabled !== false,
    exposure: typeof value.exposure === 'string' ? value.exposure : undefined,
    description: typeof value.description === 'string' ? value.description : undefined,
    source
  }
}

export async function listUserServers(): Promise<McpServerInfo[]> {
  const config = await readConfig(userMcpPath())
  const servers = config.mcpServers ?? {}
  return Object.entries(servers)
    .map(([name, entry]) => toInfo(name, entry, 'user'))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listProjectServers(cwd: string): Promise<McpServerInfo[]> {
  const config = await readConfig(projectMcpPath(cwd))
  const servers = config.mcpServers ?? {}
  return Object.entries(servers)
    .map(([name, entry]) => toInfo(name, entry, 'project'))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function updateServers(
  mutate: (servers: Record<string, unknown>) => void
): Promise<void> {
  await updateJsonFile<RawMcpConfig>(userMcpPath(), {}, (config) => {
    const servers = { ...(config.mcpServers ?? {}) }
    mutate(servers)
    return { ...config, mcpServers: servers }
  })
}

export async function setServerEnabled(name: string, enabled: boolean): Promise<void> {
  await updateServers((servers) => {
    const entry = servers[name]
    if (!entry || typeof entry !== 'object') return
    const next = { ...(entry as Record<string, unknown>) }
    if (enabled) delete next.enabled
    else next.enabled = false
    servers[name] = next
  })
}

export async function removeServer(name: string): Promise<void> {
  await updateServers((servers) => {
    delete servers[name]
  })
}

export async function addServer(name: string, rawJson: string): Promise<void> {
  if (!SERVER_NAME.test(name)) {
    throw new Error('服务器名称只能包含字母、数字、下划线和短横线')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('服务器配置必须是 JSON 对象')
  }
  const entry = parsed as Record<string, unknown>
  if (typeof entry.command !== 'string' && typeof entry.url !== 'string') {
    throw new Error('需要提供 command（stdio）或 url（HTTP）')
  }
  await updateServers((servers) => {
    servers[name] = entry
  })
}

export async function openConfig(cwd: string, which: 'user' | 'project'): Promise<void> {
  const file = which === 'project' ? projectMcpPath(cwd) : userMcpPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.access(file)
  } catch {
    await updateJsonFile<RawMcpConfig>(file, { mcpServers: {} }, (current) => current)
  }
  await shell.openPath(file)
}

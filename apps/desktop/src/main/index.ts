import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PiRpcClient } from './pi-rpc'
import { listSessions } from './sessions'
import * as providers from './providers'
import * as updates from './updates'
import * as mcp from './mcp'
import * as engines from './engines'
import * as gateway from './gateway'
import * as agents from './agents'
import { SubagentManager, type SubagentRecord } from './subagents'
import { createApiHandler } from './api'
import * as bridge from './bridge'
import { applySystemProxy, getProxyInfo } from './proxy'
import type {
  AppSettings,
  AskAnswer,
  LoginMessage,
  McpEngineId,
  McpEngineState,
  McpServerInfo,
  McpState,
  McpToolInfo,
  PiModel,
  PiStatus,
  PromptImage,
  SessionStats
} from '../shared/types'

const rpc = new PiRpcClient()
let mainWindow: BrowserWindow | null = null
let status: PiStatus = { phase: 'stopped', cwd: process.cwd() }
let starting = false

if (process.env.PI_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PI_DEBUG_PORT)
}

app.setName('agent-desktop')

async function migrateLegacyUserData(): Promise<void> {
  const legacy = path.join(app.getPath('appData'), '@pi-mcps', 'desktop')
  const current = app.getPath('userData')
  if (legacy === current) return
  for (const name of ['config.json', 'device-id', 'updates.json']) {
    const from = path.join(legacy, name)
    const to = path.join(current, name)
    try {
      if (!existsSync(to) && existsSync(from)) {
        await fs.mkdir(current, { recursive: true })
        await fs.copyFile(from, to)
      }
    } catch {
      // ignore migration failures
    }
  }
}

type SessionMode = 'shared' | 'isolated'

interface McpEngineConfig {
  enabled?: boolean
  entry?: string
}

interface SubagentConfig {
  enabled?: boolean
  maxConcurrent?: number
  /** Let subagents use the desktop engines (codegraph / warpgrep). */
  desktopTools?: boolean
  defaultMode?: 'sync' | 'background'
}

interface McpConfig {
  enabled?: boolean
  desktopTool?: boolean
  bridgePort?: number
  bridgeToken?: string
  engines?: Partial<Record<'codegraph' | 'warpgrep', McpEngineConfig>>
  /** Morph API key for WarpGrep. */
  morphApiKey?: string
  /** server -> tool -> enabled. A tool set to false is registered as `hidden`. */
  toolToggles?: Record<string, Record<string, boolean>>
  subagents?: SubagentConfig
}

interface DesktopConfig {
  cwd?: string
  sessionMode?: SessionMode
  mcp?: McpConfig
}

let desktopConfig: DesktopConfig = {}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

async function loadConfig(): Promise<DesktopConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as DesktopConfig
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function saveConfig(patch: Partial<DesktopConfig>): Promise<void> {
  desktopConfig = { ...desktopConfig, ...patch }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify(desktopConfig, null, 2))
}

function currentSessionMode(): SessionMode {
  return desktopConfig.sessionMode === 'isolated' ? 'isolated' : 'shared'
}

function currentSessionDir(): string {
  return currentSessionMode() === 'isolated'
    ? path.join(app.getPath('userData'), 'sessions')
    : path.join(os.homedir(), '.pi', 'agent', 'sessions')
}

function sessionDirArgs(): string[] {
  return currentSessionMode() === 'isolated' ? ['--session-dir', currentSessionDir()] : []
}

function mcpSettings(): { enabled: boolean; desktopTool: boolean } {
  const config = desktopConfig.mcp ?? {}
  return { enabled: config.enabled !== false, desktopTool: config.desktopTool !== false }
}

function engineConfig(): Partial<Record<'codegraph' | 'warpgrep', McpEngineConfig>> {
  return desktopConfig.mcp?.engines ?? {}
}

function toolToggles(): Record<string, Record<string, boolean>> {
  return desktopConfig.mcp?.toolToggles ?? {}
}

function subagentConfig(): Required<SubagentConfig> {
  const config = desktopConfig.mcp?.subagents ?? {}
  return {
    enabled: config.enabled !== false,
    maxConcurrent: config.maxConcurrent ?? 4,
    desktopTools: config.desktopTools === true,
    defaultMode: config.defaultMode ?? 'background'
  }
}

function resourceDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

function searchUp(start: string, relative: string, depth = 6): string | undefined {
  let dir = start
  for (let index = 0; index < depth; index += 1) {
    const candidate = path.join(dir, relative)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function desktopExtensionPath(): string {
  if (app.isPackaged) return path.join(resourceDir(), 'extension', 'desktop-mcp.js')
  return (
    searchUp(app.getAppPath(), path.join('resources', 'extension', 'desktop-mcp.js')) ??
    searchUp(
      app.getAppPath(),
      path.join('apps', 'desktop', 'resources', 'extension', 'desktop-mcp.js')
    ) ??
    path.join(resourceDir(), 'extension', 'desktop-mcp.js')
  )
}

function mcpServerScript(): string {
  if (app.isPackaged) return path.join(resourceDir(), 'mcp', 'server.mjs')
  return (
    searchUp(app.getAppPath(), path.join('packages', 'mcp-core', 'server.mjs')) ??
    path.join(app.getAppPath(), '..', '..', 'packages', 'mcp-core', 'server.mjs')
  )
}

function desktopToolAvailable(): boolean {
  return existsSync(desktopExtensionPath()) && existsSync(mcpServerScript())
}

let agentSettings: agents.AgentSettings = { exposure: 'prompt', promptLimit: 8, presets: [] }
let subagents: SubagentManager | null = null

async function refreshAgents(): Promise<void> {
  agentSettings = await agents.loadAgents(app.getPath('userData'))
}

function subagentManager(): SubagentManager {
  if (!subagents) {
    subagents = new SubagentManager({
      userData: app.getPath('userData'),
      onUpdate: (record) => mainWindow?.webContents.send('subagents:update', serializeSubagent(record))
    })
    subagents.setMaxConcurrent(subagentConfig().maxConcurrent)
  }
  return subagents
}

/** Wire shape of a subagent: no rpc handle, timestamps kept as numbers. */
function serializeSubagent(record: SubagentRecord): Record<string, unknown> {
  return {
    id: record.id,
    label: record.label,
    agent: record.agent,
    mode: record.mode,
    cwd: record.cwd,
    status: record.status,
    model: record.model,
    tools: record.tools,
    messages: record.messages,
    calls: record.calls,
    finalText: record.finalText,
    tokens: record.tokens,
    runtimeMs: record.runtimeMs,
    createdAt: record.createdAt,
    error: record.error
  }
}

/** Any built-in server active, which is when the extension has to be loaded. */
async function mcpLaunch(
  cwd: string
): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const settings = mcpSettings()
  if (!settings.enabled) {
    gateway.stopAll()
    return { args: ['--no-mcp'], env: {} }
  }
  if (!desktopToolAvailable()) return { args: [], env: {} }
  const targets = await engines.buildEngineTargets({
    cwd,
    config: engineConfig(),
    morphApiKey: desktopConfig.mcp?.morphApiKey
  })
  // The endpoints must exist before pi connects to them.
  gateway.configure(targets)
  const core = settings.desktopTool
  if (!core && targets.length === 0) return { args: [], env: {} }
  const url = bridge.getBridgeUrl()
  const env: NodeJS.ProcessEnv = { AGENT_DESKTOP_MCP_TOGGLES: JSON.stringify(toolToggles()) }
  if (url) {
    env.AGENT_DESKTOP_MCP_URL = url
    env.AGENT_DESKTOP_MCP_TOKEN = bridge.getBridgeToken()
  }
  if (core) {
    env.AGENT_DESKTOP_MCP_CORE_SCRIPT = mcpServerScript()
    // The core server only lists the subagent tools when they are enabled.
    env.AGENT_DESKTOP_SUBAGENTS = subagentConfig().enabled ? '1' : '0'
    const section = agents.renderAgentsSection(agentSettings)
    if (section && subagentConfig().enabled) env.AGENT_DESKTOP_AGENTS_SECTION = section
  }
  if (targets.length > 0 && url) {
    env.AGENT_DESKTOP_MCP_ENGINES = JSON.stringify(
      engines.buildEngineRegistrations({
        baseUrl: url,
        token: bridge.getBridgeToken(),
        targets,
        toggles: toolToggles()
      })
    )
  }
  return { args: ['--extension', desktopExtensionPath()], env }
}

/**
 * Tools each built-in server last offered, reported by the extension once its servers connect
 * (`POST /tools` on the bridge). Cached so the settings list survives restarts.
 */
type ToolCache = Record<string, McpToolInfo[]>

function toolCachePath(): string {
  return path.join(app.getPath('userData'), 'mcp-tools.json')
}

let toolCache: ToolCache = {}

async function loadToolCache(): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.readFile(toolCachePath(), 'utf8')) as ToolCache
    toolCache = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    toolCache = {}
  }
}

async function saveToolCache(next: ToolCache): Promise<void> {
  toolCache = next
  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(toolCachePath(), JSON.stringify(next, null, 2))
  } catch {
    // cache only
  }
}

const engineIndexStatus: Record<string, { state: McpEngineState['index']; message?: string }> = {}

function startCodegraphIndex(cwd: string): void {
  const config = engineConfig().codegraph
  if (!config?.enabled) return
  void engines
    .engineEntry('codegraph', config.entry?.trim() || undefined)
    .then((entry) => {
      if (!entry) return
      engines.ensureCodegraphIndex(cwd, entry, (indexState) => {
        engineIndexStatus.codegraph = indexState
        void broadcastMcpState()
      })
    })
    .catch(() => undefined)
}

/** Files under the session directory, for the composer's `@` context picker. */
const WORKSPACE_SKIP = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'release',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.codegraph',
  '.serena',
  'coverage',
  '.venv',
  'venv',
  '__pycache__'
])
const WORKSPACE_MAX_FILES = 4000

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const queue = [root]
  while (queue.length > 0 && files.length < WORKSPACE_MAX_FILES) {
    const dir = queue.pop() as string
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= WORKSPACE_MAX_FILES) break
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (WORKSPACE_SKIP.has(entry.name)) continue
        queue.push(full)
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b))
}

async function broadcastMcpState(): Promise<void> {
  try {
    mainWindow?.webContents.send('mcp:state', await buildMcpState())
  } catch {
    // window gone
  }
}

/** Only ever expose a masked hint of the Morph key, never the key itself. */
function maskKey(key: string | undefined): string | undefined {
  const value = key?.trim()
  if (!value) return undefined
  if (value.length <= 10) return '••••'
  return `${value.slice(0, 5)}…${value.slice(-4)}`
}

async function buildMcpState(): Promise<McpState> {
  const settings = mcpSettings()
  const [userServers, projectServers] = await Promise.all([
    mcp.listUserServers().catch(() => []),
    mcp.listProjectServers(status.cwd).catch(() => [])
  ])
  const servers = [...userServers]
  for (const entry of projectServers) {
    const index = servers.findIndex((server) => server.name === entry.name)
    if (index >= 0) servers[index] = entry
    else servers.push(entry)
  }
  const available = desktopToolAvailable()
  const builtin: McpServerInfo[] = []
  if (settings.enabled && settings.desktopTool && available) {
    builtin.push({
      name: 'desktop',
      transport: 'stdio',
      summary: 'Agent Desktop 内置：ask_user_question',
      enabled: true,
      exposure: 'direct',
      description: '在桌面窗口弹窗向用户提问（单选 / 多选 / 手动输入）',
      source: 'extension',
      builtin: true
    })
  }
  const indexState = engineIndexStatus.codegraph
  const codegraphIndexed = engines.findCodegraphIndex(status.cwd)
  const engineStates = await engines.engineStates({
    config: engineConfig(),
    morphApiKey: desktopConfig.mcp?.morphApiKey,
    toggles: toolToggles(),
    tools: toolCache,
    indexStatus: {
      codegraph:
        indexState ?? { state: codegraphIndexed ? 'indexed' : 'missing' }
    },
    gatewayErrors: {
      codegraph: gateway.gatewayError('codegraph'),
      warpgrep: gateway.gatewayError('warpgrep')
    }
  })
  const baseUrl = bridge.getBridgeUrl()
  for (const engine of engineStates) {
    if (!settings.enabled || !engine.enabled || !engine.available) continue
    const direct = engine.tools.filter((tool) => tool.enabled && tool.direct).length
    builtin.push({
      name: engine.id,
      transport: 'http',
      summary: `${baseUrl}/mcp/${engine.id}`,
      enabled: true,
      exposure: 'deferred',
      description: `经网关转发 · ${engine.tools.length} 个工具（${direct} 个直接声明，其余按需加载）`,
      source: 'extension',
      builtin: true
    })
  }
  servers.unshift(...builtin)
  return {
    enabled: settings.enabled,
    desktopTool: settings.desktopTool,
    desktopToolAvailable: available,
    desktopTools: (toolCache.desktop ?? []).map((tool) => ({
      ...tool,
      enabled: toolToggles().desktop?.[tool.name] !== false
    })),
    engines: engineStates,
    subagents: {
      enabled: subagentConfig().enabled,
      exposure: agentSettings.exposure,
      promptLimit: agentSettings.promptLimit,
      maxConcurrent: subagentConfig().maxConcurrent,
      desktopTools: subagentConfig().desktopTools,
      presets: agentSettings.presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        mode: preset.mode,
        tools: preset.tools,
        model: preset.model,
        appendSystemPrompt: preset.appendSystemPrompt,
        visible: preset.visible,
        timeoutMs: preset.timeoutMs,
        source: preset.source
      })),
      running: subagents?.list().filter((record) => record.status !== 'stopped').length ?? 0,
      configPath: agents.agentsFilePath(app.getPath('userData'))
    },
    morphKeyHint: maskKey(desktopConfig.mcp?.morphApiKey),
    servers,
    userConfigPath: mcp.USER_MCP_PATH,
    projectConfigPath: mcp.projectMcpPath(status.cwd),
    bridge: bridge.getBridgeInfo()
  }
}

let cachedDeviceId: string | undefined

async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId
  const file = path.join(app.getPath('userData'), 'device-id')
  try {
    const stored = (await fs.readFile(file, 'utf8')).trim()
    if (stored) {
      cachedDeviceId = stored
      return stored
    }
  } catch {
    // first login
  }
  const value = randomUUID()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${value}\n`)
  cachedDeviceId = value
  return value
}

function broadcastStatus(): void {
  mainWindow?.webContents.send('pi:status', status)
}

function cancelPendingAsks(reason: string): void {
  bridge.cancelAllAsks(reason)
  mainWindow?.webContents.send('ask:cleared')
}

function setStatus(patch: Partial<PiStatus>): void {
  status = { ...status, ...patch }
  broadcastStatus()
}

function modelFromState(data: Record<string, unknown> | undefined): PiModel | undefined {
  const raw = data?.model as Record<string, unknown> | undefined
  if (!raw) return undefined
  const provider = String(raw.provider ?? '')
  const id = String(raw.id ?? raw.modelId ?? '')
  if (!provider && !id) return undefined
  if (id === 'unknown' || provider === 'unknown') return undefined
  return {
    provider,
    id,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : undefined
  }
}

function applyState(data: Record<string, unknown> | undefined): void {
  if (!data) return
  status = {
    ...status,
    model: modelFromState(data) ?? status.model,
    thinkingLevel: typeof data.thinkingLevel === 'string' ? data.thinkingLevel : status.thinkingLevel,
    sessionName: typeof data.sessionName === 'string' ? data.sessionName : undefined,
    sessionFile: typeof data.sessionFile === 'string' ? data.sessionFile : status.sessionFile,
    isStreaming: Boolean(data.isStreaming)
  }
  broadcastStatus()
}

async function waitForReady(): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!rpc.running) throw new Error(rpc.stderrTail || 'pi 进程已退出')
    try {
      const response = await rpc.request<{ data?: Record<string, unknown> }>('get_state', {}, 3000)
      return response.data ?? {}
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw new Error(
    `pi 未在预期时间内就绪${lastError instanceof Error ? `: ${lastError.message}` : ''}`
  )
}

async function startPi(cwd?: string, extraArgs: string[] = []): Promise<PiStatus> {
  if (starting) return status
  starting = true
  await applySystemProxy()
  cancelPendingAsks('pi 已重启')
  let workspace = cwd ?? status.cwd
  if (!existsSync(workspace)) {
    console.warn(`[pi] workspace does not exist, falling back to home: ${workspace}`)
    workspace = os.homedir()
  }
  rpc.stop()
  setStatus({ phase: 'starting', cwd: workspace, error: undefined, stderrTail: undefined })
  try {
    const launch = await mcpLaunch(workspace)
    rpc.start(workspace, [...extraArgs, ...sessionDirArgs(), ...launch.args], launch.env)
    const data = await waitForReady()
    status = { phase: 'ready', cwd: workspace }
    applyState(data)
    startCodegraphIndex(workspace)
    return status
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status = {
      phase: 'error',
      cwd: workspace,
      error: message,
      stderrTail: rpc.stderrTail || undefined
    }
    broadcastStatus()
    return status
  } finally {
    starting = false
  }
}

function forwardEvent(record: Record<string, unknown>): void {
  if (record.type === 'agent_start') setStatus({ isStreaming: true })
  if (record.type === 'agent_settled' || record.type === 'agent_end') {
    setStatus({ isStreaming: false })
    void refreshState()
  }
  if (record.type === 'thinking_level_changed' && typeof record.level === 'string') {
    setStatus({ thinkingLevel: record.level })
  }
  if (record.type === 'session_info_changed') {
    setStatus({ sessionName: typeof record.name === 'string' ? record.name : undefined })
  }
  mainWindow?.webContents.send('pi:event', record)
}

async function refreshState(): Promise<void> {
  if (!rpc.running) return
  try {
    const response = await rpc.request<{ data?: Record<string, unknown> }>('get_state', {}, 5000)
    applyState(response.data)
  } catch {
    // ignore transient failures
  }
}

function sessionArgs(): string[] {
  return status.sessionFile ? ['--session', status.sessionFile] : []
}

async function reloadPiConfig(): Promise<void> {
  await refreshAgents()
  if (status.isStreaming) {
    mainWindow?.webContents.send('pi:config-pending', true)
    return
  }
  await startPi(status.cwd, sessionArgs())
}

function sendLoginMessage(message: LoginMessage): void {
  mainWindow?.webContents.send('providers:login-message', message)
}

function registerIpc(): void {
  ipcMain.handle('pi:get-status', () => status)

  ipcMain.handle('pi:restart', async (_event, cwd?: string) => {
    if (cwd) await saveConfig({ cwd })
    return startPi(cwd ?? status.cwd, sessionArgs())
  })

  ipcMain.handle('pi:new-project-session', async (_event, cwd: string) => {
    await saveConfig({ cwd })
    return startPi(cwd)
  })

  ipcMain.handle('pi:open-session', async (_event, sessionPath: string, cwd: string) => {
    await saveConfig({ cwd })
    return startPi(cwd, ['--session', sessionPath])
  })

  ipcMain.handle('desktop:config', () => ({
    cwd: status.cwd,
    sessionMode: currentSessionMode(),
    sessionDir: currentSessionDir(),
    sharedSessionDir: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
    isolatedSessionDir: path.join(app.getPath('userData'), 'sessions')
  }))

  ipcMain.handle('updates:snapshot', () => updates.getSnapshot())
  ipcMain.handle('updates:check', () => updates.check())
  ipcMain.handle('updates:install', () => updates.install())
  ipcMain.handle('updates:cancel', () => updates.cancel())
  ipcMain.handle('updates:auto', (_event, enabled: boolean) => updates.setAuto(enabled))
  ipcMain.handle('app:proxy', () => getProxyInfo())

  ipcMain.handle('desktop:set-session-mode', async (_event, mode: SessionMode) => {
    await saveConfig({ sessionMode: mode === 'isolated' ? 'isolated' : 'shared' })
    return startPi(status.cwd)
  })

  ipcMain.handle('pi:choose-workspace', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择目录（将在该目录新建会话）',
      defaultPath: status.cwd,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const cwd = result.filePaths[0]
    await saveConfig({ cwd })
    return startPi(cwd)
  })

  ipcMain.handle(
    'pi:prompt',
    async (
      _event,
      message: string,
      streamingBehavior?: 'steer' | 'followUp',
      images?: PromptImage[]
    ) => {
      if (!rpc.running) return { ok: false, error: 'pi 未运行' }
      try {
        const response = await rpc.request<{ data?: { disposition?: string } }>('prompt', {
          message,
          ...(streamingBehavior ? { streamingBehavior } : {}),
          ...(images && images.length > 0 ? { images } : {})
        })
        return {
          ok: true,
          disposition: response.data?.disposition as 'started' | 'queued' | 'handled' | undefined
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('pi:abort', async () => {
    cancelPendingAsks('用户中止了本次运行')
    if (!rpc.running) return
    try {
      await rpc.request('abort', {}, 30000)
    } catch {
      // ignore
    }
    await refreshState()
  })

  ipcMain.handle('pi:new-session', async () => {
    if (!rpc.running) return { ok: false, error: 'pi 未运行' }
    try {
      const response = await rpc.request<{ data?: { cancelled?: boolean } }>('new_session')
      await refreshState()
      return { ok: true, cancelled: response.data?.cancelled }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('pi:switch-session', async (_event, sessionPath: string) => {
    if (!rpc.running) return { ok: false, error: 'pi 未运行' }
    try {
      const response = await rpc.request<{ data?: { cancelled?: boolean } }>('switch_session', {
        sessionPath
      })
      await refreshState()
      return { ok: true, cancelled: response.data?.cancelled }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('pi:get-messages', async () => {
    if (!rpc.running) return []
    const response = await rpc.request<{ data?: { messages?: unknown[] } }>('get_messages')
    return response.data?.messages ?? []
  })

  ipcMain.handle('pi:list-sessions', () => listSessions(currentSessionDir()))

  ipcMain.handle('pi:session-stats', async () => {
    if (!rpc.running) return {}
    try {
      const response = await rpc.request<{ data?: Record<string, unknown> }>('get_session_stats')
      const data = response.data ?? {}
      return {
        tokens: data.tokens as SessionStats['tokens'],
        cost: typeof data.cost === 'number' ? data.cost : undefined,
        contextUsage: data.contextUsage as SessionStats['contextUsage']
      }
    } catch {
      return {}
    }
  })

  ipcMain.handle('pi:open-agent-dir', async () => {
    const dir = path.join(os.homedir(), '.pi', 'agent')
    await fs.mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })

  ipcMain.handle('app:open-external', async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  ipcMain.handle('app:set-theme', (_event, theme: 'dark' | 'light') => {
    mainWindow?.setTitleBarOverlay({
      color: theme === 'light' ? '#f6f6f7' : '#17181b',
      symbolColor: theme === 'light' ? '#3a3c45' : '#b9bbc2',
      height: 44
    })
  })

  ipcMain.handle('providers:list', () => providers.listProviders())

  ipcMain.handle('ask:answer', (_event, id: string, answers: AskAnswer[]) => {
    bridge.answerAsk(id, Array.isArray(answers) ? answers : [])
  })

  ipcMain.handle('ask:cancel', (_event, id: string, reason?: string) => {
    bridge.cancelAsk(id, reason ?? '用户取消了提问')
  })

  ipcMain.handle('mcp:state', () => buildMcpState())

  ipcMain.handle('workspace:files', () => listWorkspaceFiles(status.cwd))

  ipcMain.handle('mcp:set-enabled', async (_event, enabled: boolean) => {
    await saveConfig({ mcp: { ...desktopConfig.mcp, enabled: Boolean(enabled) } })
    await reloadPiConfig()
    return buildMcpState()
  })

  ipcMain.handle('mcp:set-desktop-tool', async (_event, enabled: boolean) => {
    await saveConfig({ mcp: { ...desktopConfig.mcp, desktopTool: Boolean(enabled) } })
    await reloadPiConfig()
    return buildMcpState()
  })

  ipcMain.handle('mcp:set-engine-enabled', async (_event, id: McpEngineId, enabled: boolean) => {
    const current = engineConfig()
    await saveConfig({
      mcp: {
        ...desktopConfig.mcp,
        engines: { ...current, [id]: { ...current[id], enabled: Boolean(enabled) } }
      }
    })
    await reloadPiConfig()
    return buildMcpState()
  })

  ipcMain.handle('mcp:set-engine-entry', async (_event, id: McpEngineId, entry: string | null) => {
    const current = engineConfig()
    const next = { ...current[id] }
    if (entry && entry.trim()) next.entry = entry.trim()
    else delete next.entry
    engines.invalidateDetection(id)
    await saveConfig({ mcp: { ...desktopConfig.mcp, engines: { ...current, [id]: next } } })
    await reloadPiConfig()
    return buildMcpState()
  })

  ipcMain.handle('mcp:refresh-engines', async () => {
    engines.invalidateDetection()
    return buildMcpState()
  })

  ipcMain.handle('mcp:build-index', async () => {
    const cwd = status.cwd
    const config = engineConfig().codegraph
    engineIndexStatus.codegraph = { state: 'indexing', message: cwd }
    void broadcastMcpState()
    const result = await engines.runCodegraphIndex(cwd, config)
    engineIndexStatus.codegraph = {
      state: result.ok ? 'indexed' : 'failed',
      message: result.message
    }
    void broadcastMcpState()
    return result
  })

  ipcMain.handle(
    'mcp:set-tool',
    async (_event, server: string, tool: string, enabled: boolean) => {
      const toggles = { ...toolToggles() }
      const next = { ...(toggles[server] ?? {}) }
      if (enabled) delete next[tool]
      else next[tool] = false
      if (Object.keys(next).length === 0) delete toggles[server]
      else toggles[server] = next
      await saveConfig({ mcp: { ...desktopConfig.mcp, toolToggles: toggles } })
      await reloadPiConfig()
      return buildMcpState()
    }
  )

  ipcMain.handle('mcp:set-morph-key', async (_event, key: string | null) => {
    const next = { ...desktopConfig.mcp }
    if (key && key.trim()) next.morphApiKey = key.trim()
    else delete next.morphApiKey
    await saveConfig({ mcp: next })
    await reloadPiConfig()
    return buildMcpState()
  })

  ipcMain.handle('mcp:set-subagents', async (_event, enabled: boolean) => {
    await saveConfig({
      mcp: { ...desktopConfig.mcp, subagents: { ...(desktopConfig.mcp?.subagents ?? {}), enabled: Boolean(enabled) } }
    })
    await reloadPiConfig()
    return buildMcpState()
  })

  ipcMain.handle('agents:set-exposure', async (_event, exposure: 'prompt' | 'lazy' | 'hidden') => {
    await agents.saveExposure(app.getPath('userData'), exposure)
    await reloadPiConfig()
    return buildMcpState()
  })

  ipcMain.handle('agents:save-preset', async (_event, draft: agents.PresetDraft) => {
    try {
      await agents.savePreset(app.getPath('userData'), draft)
      await refreshAgents()
      await reloadPiConfig()
      return { ok: true, state: await buildMcpState() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agents:delete-preset', async (_event, id: string) => {
    try {
      await agents.deletePreset(app.getPath('userData'), id)
      await refreshAgents()
      await reloadPiConfig()
      return { ok: true, state: await buildMcpState() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agents:open-config', async () => {
    await agents.ensureAgentsFile(app.getPath('userData'))
    await shell.openPath(agents.agentsFilePath(app.getPath('userData')))
  })

  ipcMain.handle('mcp:choose-engine-entry', async () => {
    const filters =
      process.platform === 'win32'
        ? [{ name: 'CodeGraph', extensions: ['exe', 'cmd', 'js'] }]
        : [{ name: 'Executable', extensions: [''] }]
    const result = await dialog.showOpenDialog({
      title: '选择 CodeGraph 入口',
      properties: ['openFile'],
      filters
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('mcp:set-server-enabled', async (_event, name: string, enabled: boolean) => {
    try {
      await mcp.setServerEnabled(name, Boolean(enabled))
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('mcp:remove-server', async (_event, name: string) => {
    try {
      await mcp.removeServer(name)
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('mcp:add-server', async (_event, name: string, config: string) => {
    try {
      await mcp.addServer(name, config)
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('mcp:open-config', (_event, which: 'user' | 'project') =>
    mcp.openConfig(status.cwd, which === 'project' ? 'project' : 'user')
  )

  ipcMain.handle(
    'providers:start-login',
    async (_event, providerId: string, type: 'api_key' | 'oauth', loginId: string) => {
      await applySystemProxy()
      return providers.startLogin(providerId, type, loginId, sendLoginMessage, () => {
        void reloadPiConfig()
      }, { deviceId: await getDeviceId() })
    }
  )

  ipcMain.handle(
    'providers:answer-login',
    (_event, loginId: string, promptId: string, value: string) => {
      providers.answerLogin(loginId, promptId, value)
    }
  )

  ipcMain.handle('providers:cancel-login', (_event, loginId: string) => {
    providers.cancelLogin(loginId)
  })

  ipcMain.handle('providers:logout', async (_event, providerId: string) => {
    try {
      await providers.logoutProvider(providerId)
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('providers:models-json', () => providers.getModelsJson())

  ipcMain.handle('providers:save-models-json', async (_event, content: string) => {
    try {
      await providers.saveModelsJson(content)
      await reloadPiConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('providers:open-models-json', async () => {
    const file = await providers.getModelsJson()
    await fs.mkdir(path.dirname(file.path), { recursive: true })
    try {
      await fs.access(file.path)
    } catch {
      await fs.writeFile(file.path, file.content)
    }
    await shell.openPath(file.path)
  })

  ipcMain.handle('settings:get', () => providers.getAppSettings())

  ipcMain.handle(
    'settings:save',
    async (
      _event,
      patch: Partial<
        Pick<AppSettings, 'defaultProvider' | 'defaultModel' | 'defaultThinkingLevel'>
      >
    ) => {
      try {
        await providers.saveAppSettings(patch)
        await reloadPiConfig()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('settings:models', () => providers.listModelChoices())

  ipcMain.handle('pi:list-models', async () => {
    if (!rpc.running) return []
    try {
      const response = await rpc.request<{ data?: { models?: Record<string, unknown>[] } }>(
        'get_available_models'
      )
      const names = new Map<string, string>()
      try {
        for (const provider of await providers.listProviders()) {
          names.set(provider.id, provider.name)
        }
      } catch {
        // provider display names are optional
      }
      const patterns = await providers.getEnabledModelPatterns().catch(() => [])
      return (response.data?.models ?? [])
        .map((model) => {
          const provider = String(model.provider ?? '')
          return {
            provider,
            id: String(model.id ?? ''),
            name: typeof model.name === 'string' ? model.name : undefined,
            contextWindow:
              typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
            providerName: names.get(provider) ?? provider,
            reasoning: Boolean(model.reasoning)
          }
        })
        .filter((model) => providers.isModelEnabled(model, patterns))
    } catch {
      return []
    }
  })

  ipcMain.handle('pi:set-model', async (_event, provider: string, modelId: string) => {
    if (!rpc.running) return { ok: false, error: 'pi 未运行' }
    try {
      const response = await rpc.request<{ data?: Record<string, unknown> }>('set_model', {
        provider,
        modelId
      })
      const model = modelFromState({ model: response.data })
      if (model) setStatus({ model })
      await refreshState()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('pi:list-thinking-levels', async () => {
    if (!rpc.running) return []
    try {
      const response = await rpc.request<{ data?: { levels?: string[] } }>(
        'get_available_thinking_levels'
      )
      return response.data?.levels ?? []
    } catch {
      return []
    }
  })

  ipcMain.handle('pi:set-thinking-level', async (_event, level: string) => {
    if (!rpc.running) return { ok: false, error: 'pi 未运行' }
    try {
      await rpc.request('set_thinking_level', { level })
      setStatus({ thinkingLevel: level })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('providers:list-provider-models', (_event, providerId: string) =>
    providers.listProviderModels(providerId)
  )

  ipcMain.handle(
    'providers:set-provider-models',
    async (_event, providerId: string, enabledIds: string[]) => {
      try {
        await providers.setProviderModels(providerId, enabledIds)
        await reloadPiConfig()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#17181b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#17181b',
      symbolColor: '#b9bbc2',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

rpc.on('event', forwardEvent)
rpc.on('exit', () => {
  if (status.phase !== 'stopped') {
    setStatus({ phase: 'error', error: rpc.stderrTail || 'pi 进程已退出', isStreaming: false })
  }
})

app.whenReady().then(async () => {
  registerIpc()
  await migrateLegacyUserData()
  await applySystemProxy()
  desktopConfig = await loadConfig()
  await loadToolCache()
  const cwd = desktopConfig.cwd || process.env.PI_DESKTOP_CWD || process.cwd()
  status = { phase: 'stopped', cwd }
  await startBridge()
  bridge.setAskListener((request) => {
    if (mainWindow) mainWindow.webContents.send('ask:request', request)
    else bridge.cancelAsk(request.id, '桌面窗口未就绪')
  })
  bridge.setToolsListener((servers) => {
    const next: ToolCache = { ...toolCache }
    for (const [server, tools] of Object.entries(servers)) {
      next[server] = tools
    }
    void saveToolCache(next).then(() => broadcastMcpState())
  })
  bridge.setMcpHandler((engine, message) => {
    if (engine !== 'codegraph' && engine !== 'warpgrep') {
      return Promise.reject(new Error(`未知网关端点：${engine}`))
    }
    return gateway.handleMessage(engine, message)
  })
  bridge.setApiHandler(
    createApiHandler({
      agentSettings: () => agentSettings,
      subagents: () => subagentManager(),
      listModels: (options) => providers.listModelChoices({ includeUnconfigured: !options.configuredOnly }),
      defaultMode: () => subagentConfig().defaultMode,
      desktopTools: () => subagentConfig().desktopTools
    })
  )
  createWindow()
  updates.setupUpdates((next) => mainWindow?.webContents.send('app-update', next))
  console.log(
    '[mcp] settings=',
    JSON.stringify(mcpSettings()),
    'available=',
    desktopToolAvailable(),
    'extension=',
    desktopExtensionPath(),
    'script=',
    mcpServerScript()
  )
  // Warm the model runtime in the background so the first Settings open is instant.
  await refreshAgents()
  void providers.listProviders().catch(() => undefined)
  void providers.listModelChoices().catch(() => undefined)
  void startPi(cwd)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

async function startBridge(): Promise<void> {
  const config = desktopConfig.mcp ?? {}
  const token = config.bridgeToken ?? randomUUID()
  try {
    const info = await bridge.startBridge({ preferredPort: config.bridgePort, token })
    if (config.bridgePort !== info.port || config.bridgeToken !== token) {
      await saveConfig({ mcp: { ...desktopConfig.mcp, bridgePort: info.port, bridgeToken: token } })
    }
  } catch (error) {
    console.error('[bridge] failed to start:', error instanceof Error ? error.message : error)
  }
}

app.on('window-all-closed', () => {
  cancelPendingAsks('桌面窗口已关闭')
  rpc.stop()
  gateway.stopAll()
  status = { ...status, phase: 'stopped' }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  bridge.cancelAllAsks('桌面端已退出')
  subagents?.stopAll()
  gateway.stopAll()
  bridge.stopBridge()
  rpc.stop()
})

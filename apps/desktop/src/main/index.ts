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
import * as bridge from './bridge'
import { applySystemProxy, getProxyInfo } from './proxy'
import type {
  AppSettings,
  AskAnswer,
  LoginMessage,
  McpState,
  PiModel,
  PiStatus,
  PromptImage
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

interface McpConfig {
  enabled?: boolean
  desktopTool?: boolean
  bridgePort?: number
  bridgeToken?: string
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
    searchUp(app.getAppPath(), path.join('packages', 'mcp-ask-user', 'server.mjs')) ??
    path.join(app.getAppPath(), '..', '..', 'packages', 'mcp-ask-user', 'server.mjs')
  )
}

function desktopToolAvailable(): boolean {
  return existsSync(desktopExtensionPath()) && existsSync(mcpServerScript())
}

function mcpArgs(): string[] {
  const settings = mcpSettings()
  if (!settings.enabled) return ['--no-mcp']
  if (!settings.desktopTool || !desktopToolAvailable()) return []
  return ['--extension', desktopExtensionPath()]
}

function mcpEnv(): NodeJS.ProcessEnv {
  const settings = mcpSettings()
  const url = bridge.getBridgeUrl()
  if (!settings.enabled || !settings.desktopTool || !url) return {}
  return {
    AGENT_DESKTOP_MCP_URL: url,
    AGENT_DESKTOP_MCP_TOKEN: bridge.getBridgeToken(),
    AGENT_DESKTOP_MCP_SCRIPT: mcpServerScript()
  }
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
  if (settings.enabled && settings.desktopTool && available) {
    servers.unshift({
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
  return {
    enabled: settings.enabled,
    desktopTool: settings.desktopTool,
    desktopToolAvailable: available,
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
    rpc.start(workspace, [...extraArgs, ...sessionDirArgs(), ...mcpArgs()], mcpEnv())
    const data = await waitForReady()
    status = { phase: 'ready', cwd: workspace }
    applyState(data)
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
  const cwd = desktopConfig.cwd || process.env.PI_DESKTOP_CWD || process.cwd()
  status = { phase: 'stopped', cwd }
  await startBridge()
  bridge.setAskListener((request) => {
    if (mainWindow) mainWindow.webContents.send('ask:request', request)
    else bridge.cancelAsk(request.id, '桌面窗口未就绪')
  })
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
  status = { ...status, phase: 'stopped' }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  bridge.cancelAllAsks('桌面端已退出')
  bridge.stopBridge()
  rpc.stop()
})

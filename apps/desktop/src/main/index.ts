import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OwnEngine } from './agent/own-engine'
import { PiEngine } from './agent/pi-engine'
import { listSessions, readSummary } from './sessions'
import { SessionStore, toSummary } from './session-store'
import * as providers from './providers'
import * as updates from './updates'
import * as mcp from './mcp'
import * as engines from './engines'
import * as gateway from './gateway'
import * as web from './web'
import * as agents from './agents'
import { SubagentManager, type SubagentRecord } from './subagents'
import { createApiHandler } from './api'
import * as bridge from './bridge'
import { applySystemProxy, getProxyInfo } from './proxy'
import * as profile from './profile'
import * as repo from './repo'
import * as projects from './projects'
import { realBashPath, withRealBash } from './shell'
import * as speed from './speed'
import type { AgentEngine, AgentWorkspace } from './agent/engine'
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
  PromptResult,
  SessionStats,
  SpeedMode
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
/**
 * The window's view of the run state.
 *
 * The engine owns the state machine; this is the mirror it pushes into, decorated with the app's
 * own facts (compaction percentage, speed tier, repository) by `statusSnapshot()`. Reads here stay
 * cheap, writes must go through `engine.setStatus()`.
 */
let status: PiStatus = { phase: 'stopped', cwd: process.cwd() }
/** An MCP/agent config change arrived mid-run and still has to restart pi. */
let configPending = false

/**
 * pi behind the `AgentEngine` contract.
 *
 * Everything that is app policy stays on this side: MCP servers, `/btw` forks, compaction
 * thresholds, speed tiers, config and profiles. The engine only runs turns and owns the run state.
 */
let projectStore: projects.ProjectStore | undefined

/**
 * The app's own session list.
 *
 * pi's JSONL files are the engine's storage; the window reads this store instead, so swapping the
 * engine will not change how sessions are listed, sorted or grouped.
 */
let sessionStore: SessionStore | undefined

/** One-time import of the sessions that predate the store. */
async function importPiSessions(): Promise<void> {
  if (!sessionStore) return
  const existing = sessionStore.list()
  if (existing.length > 0) return
  const summaries = await listSessions(currentSessionDir()).catch(() => [])
  for (const summary of summaries) {
    await sessionStore
      .upsert({
        path: summary.path,
        cwd: summary.cwd,
        title: summary.title,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt
      })
      .catch(() => undefined)
  }
}

/** Record (or refresh) the session the engine is currently running. */
async function rememberSession(extra: { title?: string } = {}): Promise<void> {
  if (!sessionStore) return
  const file = status.sessionFile
  if (!file) return
  let title = status.sessionName ?? extra.title
  // A brand-new session has no name yet; the first user message is what the sidebar shows, and the
  // engine's file head is the cheapest place to find it.
  const known = sessionStore.byPath(file)
  if (!title && (!known || !known.title)) {
    const summary = await readSummary(file).catch(() => null)
    if (summary) title = summary.title
  }
  await sessionStore
    .upsert({
      path: file,
      cwd: status.cwd,
      ...(title ? { title } : {}),
      additional: engine.workspace().additional,
      ...(desktopConfig.activeProject ? { projectId: desktopConfig.activeProject } : {}),
      updatedAt: Date.now()
    })
    .catch(() => undefined)
}

/** The project the window is working in, when one is selected. */
function activeProject(): projects.Project | undefined {
  const id = desktopConfig.activeProject
  return id ? projectStore?.get(id) : undefined
}

let desktopConfig: DesktopConfig = {}

/** Engine factory: pi stays the default; `own` is the text-only v1. */
function createEngine(): AgentEngine {
  const shared = {
    onStatus: (next: PiStatus) => {
      const previous = status
      status = next
      if (next.sessionFile && next.sessionFile !== previous.sessionFile) void rememberSession()
      else if (next.sessionName && next.sessionName !== previous.sessionName) void rememberSession()
    },
    onEvent: (record: Record<string, unknown>) => {
      // While the /btw panel is open the window must not see the fork's transcript.
      if (btwActive) return
      mainWindow?.webContents.send('pi:event', record)
    },
    onSettled: () => {
      void rememberSession()
      if (!configPending) return
      configPending = false
      void startPi(status.cwd, sessionArgs())
    },
    onAssistantError: (message: string) => noteSpeedRejection(message),
    onExit: () => handleExit()
  }
  if (desktopConfig.engine === 'own') return new OwnEngine(shared)
  return new PiEngine({
    ...shared,
    prepare: async (workspace) => {
      await applySystemProxy()
      cancelPendingAsks('pi 已重启')
      const launch = await mcpLaunch(workspace)
      // An isolated profile is just this variable: pi then reads auth/models/settings/mcp/sessions
      // from the desktop directory instead of the CLI's.
      const env = withRealBash({ ...launch.env })
      // Read by the extension's request hooks; it re-checks the model before touching the payload.
      env.AGENT_DESKTOP_SPEED = speed.resolveSpeedMode(status.model, currentSpeedMode())
      // The root-aware bash tool runs in the core server, which has no idea where Git Bash lives.
      const bash = realBashPath()
      if (bash) env.AGENT_DESKTOP_SHELL = bash
      // Root-aware file tools need the same list the model is told about, so both come from here.
      if (workspace.additional.length > 0) {
        env.AGENT_DESKTOP_ROOTS = JSON.stringify([
          { name: path.basename(workspace.primary), path: workspace.primary, primary: true },
          ...workspace.additional.map((root) => ({ name: path.basename(root), path: root }))
        ])
      }
      // Several directories need to be explained to the model; one directory is just a normal session
      // and gets no section.
      const project = activeProject()
      if (project && workspace.additional.length > 0) {
        env.AGENT_DESKTOP_PROJECT = JSON.stringify({
          id: project.id,
          name: project.name,
          roots: [
            { path: workspace.primary, name: path.basename(workspace.primary), primary: true },
            ...workspace.additional.map((root) => ({ path: root, name: path.basename(root) }))
          ]
        })
      }
      if (profile.isIsolatedProfile()) env.PI_CODING_AGENT_DIR = profile.agentDir()
      return { args: launch.args, env }
    },
    sessionArgs: () => sessionArgs(),
    sessionDirArgs: () => sessionDirArgs()
  })
}

/** Created in `whenReady`, once `config.engine` is known. */
let engine: AgentEngine

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
  engines?: Partial<Record<McpEngineId, McpEngineConfig>>
  /** Morph API key for WarpGrep. */
  morphApiKey?: string
  /** Web search / fetch: Brave key, per-provider native search, budgets. */
  web?: web.WebConfig
  /** server -> tool -> enabled. A tool set to false is registered as `hidden`. */
  toolToggles?: Record<string, Record<string, boolean>>
  subagents?: SubagentConfig
}

interface DesktopConfig {
  cwd?: string
  sessionMode?: SessionMode
  mcp?: McpConfig
  /** Auto-compaction policy; `ratio` is the fraction of the window that triggers it. */
  autoCompact?: { ratio?: number }
  /** Processing tier sent with each request; only applied when the active model offers it. */
  speed?: { mode?: SpeedMode }
  /** Project the window is working in; sessions still start on its primary repository. */
  activeProject?: string
  /** Which engine runs the turn: `pi` (default) or `own` (text-only v1). */
  engine?: 'pi' | 'own'
  /** Repositories the user worked in, most recent first (sidebar "切换仓库" menu). */
  recentRepos?: string[]
  /** Per-repository defaults applied to a new session in that repository. */
  repoDefaults?: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>
  /** `shared` uses the pi CLI's `~/.pi/agent`; `desktop` keeps its own copy under userData. */
  profile?: 'shared' | 'desktop'
}


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

/** Where an isolated profile lives: `auth.json`, `models.json`, `settings.json`, `mcp.json`, sessions. */
function desktopProfileDir(): string {
  return path.join(app.getPath('userData'), 'pi')
}

function currentProfile(): 'shared' | 'desktop' {
  return desktopConfig.profile === 'desktop' ? 'desktop' : 'shared'
}

/** Point every module at the profile the config asks for. Safe to call more than once. */
function applyProfile(): void {
  profile.setAgentDir(
    currentProfile() === 'desktop' ? desktopProfileDir() : profile.CLI_AGENT_DIR
  )
  providers.invalidateCache()
}

/** Auto-compaction starts at this fraction of the model's context window. */
const AUTO_COMPACT_RATIO = 0.9

function autoCompactRatio(): number {
  const ratio = desktopConfig.autoCompact?.ratio
  // An explicit `/autocompact <tokens>` is stored as a ratio, so the accepted range has to cover
  // small thresholds too: rejecting them made the settings row claim 90% right after the user asked
  // for something else, and the next restart silently moved the trigger point back.
  return typeof ratio === 'number' && ratio > 0.005 && ratio < 0.995 ? ratio : AUTO_COMPACT_RATIO
}

/**
 * Free context pi keeps below the window, i.e. the number that makes it compact at `ratio`.
 *
 * pi compacts when `contextTokens > contextWindow - reserveTokens`, so 90% of a 1M window is a
 * 100K reserve.
 */
function reserveFor(window: number, ratio: number): number {
  return Math.max(1000, Math.round(window * (1 - ratio)))
}

/**
 * Keep pi's compaction reserve in step with the active model's window.
 *
 * pi reads `reserveTokens` from settings.json at startup, so a changed window only takes effect
 * after a restart (`reloadPiConfig`, which defers while a run is in flight). Returns the reserve it
 * settled on, or undefined when auto-compaction is off or the model has no window.
 */
async function syncAutoCompact(options: { restart?: boolean } = {}): Promise<number | undefined> {
  const settings = await providers.getAppSettings().catch(() => undefined)
  if (!settings?.compaction?.enabled) return undefined
  const window = status.model?.contextWindow
  if (!window) return undefined
  const reserve = reserveFor(window, autoCompactRatio())
  if (settings.compaction.reserveTokens === reserve) return reserve
  await providers.setCompactionSettings({ enabled: true, reserveTokens: reserve })
  if (options.restart) await reloadPiConfig()
  return reserve
}

/**
 * Session root for "shared" mode. With an isolated profile pi would put its sessions under the
 * profile directory anyway, so the window has to follow it instead of pointing at the CLI's.
 */
function sharedSessionDir(): string {
  return profile.isIsolatedProfile()
    ? profile.profileSessionDir()
    : path.join(os.homedir(), '.pi', 'agent', 'sessions')
}

function currentSessionDir(): string {
  const base =
    currentSessionMode() === 'isolated'
      ? path.join(app.getPath('userData'), 'sessions')
      : sharedSessionDir()
  // A project keeps its conversations together: new sessions land under its own directory, while
  // the list still walks the whole tree so sessions from before the project stay visible.
  const project = activeProject()
  return project ? path.join(base, 'projects', project.id) : base
}

function sessionDirArgs(): string[] {
  // Explicit for both modes: an isolated profile must never write into the CLI's session tree.
  return ['--session-dir', currentSessionDir()]
}

function mcpSettings(): { enabled: boolean; desktopTool: boolean } {
  const config = desktopConfig.mcp ?? {}
  return { enabled: config.enabled !== false, desktopTool: config.desktopTool !== false }
}

function engineConfig(): Partial<Record<McpEngineId, McpEngineConfig>> {
  return desktopConfig.mcp?.engines ?? {}
}

/** Web config with the defaults applied, in the shape `web.ts` expects. */
function webConfig(): web.WebConfig {
  const config = desktopConfig.mcp?.web ?? {}
  return {
    mode: config.mode === 'brave' || config.mode === 'native' ? config.mode : 'auto',
    braveApiKey: config.braveApiKey?.trim() || undefined,
    native: config.native ?? {},
    count: config.count,
    maxChars: config.maxChars
  }
}

function saveWebConfig(patch: Partial<web.WebConfig>): Promise<void> {
  return saveConfig({
    mcp: { ...desktopConfig.mcp, web: { ...(desktopConfig.mcp?.web ?? {}), ...patch } }
  })
}

/** Web tools need at least one backend, otherwise the endpoint stays unregistered. */
function webReady(): boolean {
  const config = webConfig()
  return Boolean(config.braveApiKey) || web.nativeProviderEnabled(config).length > 0
}

/** Which backend the next `web_search` would use, for the settings panel. */
function webRouteLabel(config: web.WebConfig): string {
  const route = web.describeRoute(status.model?.provider, config)
  if (route.backend === 'native') return `${route.provider} 原生搜索`
  // `mode: native` refuses to fall back, so say so instead of pretending Brave will answer.
  if (config.mode === 'native') return `不可用（${route.reason ?? '当前服务商没有原生搜索'}）`
  if (config.mode === 'brave') return config.braveApiKey ? 'Brave Search API' : 'Brave（未配置 Key）'
  if (route.reason) return `Brave（${route.reason}）`
  return config.braveApiKey ? 'Brave Search API' : 'Brave（未配置 Key）'
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
/** Last time the user stopped a run, used to keep subagent notices from restarting it. */
let lastAbortAt = 0

async function refreshAgents(): Promise<void> {
  agentSettings = await agents.loadAgents(app.getPath('userData'))
}

function subagentManager(): SubagentManager {
  if (!subagents) {
    subagents = new SubagentManager({
      userData: app.getPath('userData'),
      onUpdate: (record) => mainWindow?.webContents.send('subagents:update', serializeSubagent(record)),
      onSettle: (record) => {
        bridge.publishEvent({
          type: 'subagent_settled',
          text: subagentNotice(record),
          // Do not restart a run the user just stopped; queue the notice for their next turn.
          wake: record.notify === 'wake' && Date.now() - lastAbortAt > 30_000
        })
      }
    })
    subagents.setMaxConcurrent(subagentConfig().maxConcurrent)
  }
  return subagents
}

/** Three lines at most: the parent reads this inside its own transcript. */
function subagentNotice(record: SubagentRecord): string {
  const changed = new Set(
    record.calls
      .filter(
        (call) =>
          (call.tool === 'edit' || call.tool === 'write' || call.tool === 'apply_patch') &&
          typeof call.summary === 'string' &&
          call.summary
      )
      .map((call) => call.summary as string)
  )
  const head = [
    `子代理 ${record.id}`,
    record.agent ? `· ${record.agent}` : '',
    `· ${record.status}`,
    record.runtimeMs ? `· ${formatSpan(record.runtimeMs)}` : '',
    record.tokens ? `· ${formatTokens(record.tokens)}` : '',
    changed.size > 0 ? `· 改动 ${changed.size} 个文件` : ''
  ]
    .filter(Boolean)
    .join(' ')
  const conclusion = record.error
    ? `错误：${record.error}`
    : (record.finalText ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) || '（没有结论）'
  return [
    head,
    `结论：${conclusion}`,
    `详情用 mcp__desktop__get_subagent（id ${record.id}），不要重复询问。`
  ].join('\n')
}

function formatSpan(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k tokens` : `${count} tokens`
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
    notify: record.notify,
    sessionFile: record.sessionFile,
    parentSession: record.parentSession,
    restored: record.restored === true,
    error: record.error
  }
}

/** Any built-in server active, which is when the extension has to be loaded. */
/**
 * `--extension` for the desktop extension file, or nothing when it is missing.
 *
 * The extension is not only MCP: it also patches provider requests for the speed tier, which has to
 * keep working when the user turns the built-in servers off.
 */
function extensionArgs(): string[] {
  const file = desktopExtensionPath()
  return existsSync(file) ? ['--extension', file] : []
}

async function mcpLaunch(
  workspace: AgentWorkspace
): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const settings = mcpSettings()
  if (!settings.enabled) {
    gateway.stopAll()
    return { args: ['--no-mcp', ...extensionArgs()], env: {} }
  }
  if (!desktopToolAvailable()) return { args: extensionArgs(), env: {} }
  // Several directories mean code search has to run per directory, so each root gets its own
  // endpoint (capped by the engine module).
  const roots = [
    { path: workspace.primary, name: path.basename(workspace.primary) || workspace.primary, primary: true },
    ...workspace.additional.map((root) => ({ path: root, name: path.basename(root) || root }))
  ]
  const targets = await engines.buildEngineTargets({
    roots,
    config: engineConfig(),
    morphApiKey: desktopConfig.mcp?.morphApiKey,
    webAvailable: webReady()
  })
  // The endpoints must exist before pi connects to them.
  gateway.configure(targets)
  const core = settings.desktopTool
  if (!core && targets.length === 0) return { args: extensionArgs(), env: {} }
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
  return { args: extensionArgs(), env }
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

/** Roots already indexed by this process, so a project switch does not re-index from scratch. */
const indexedRoots = new Set<string>()

function startCodegraphIndex(cwd: string): void {
  const config = engineConfig().codegraph
  if (!config?.enabled) return
  const key = path.resolve(cwd)
  if (indexedRoots.has(key)) return
  indexedRoots.add(key)
  void engines
    .engineEntry('codegraph', config.entry?.trim() || undefined)
    .then((entry) => {
      if (!entry) {
        indexedRoots.delete(key)
        return
      }
      engines.ensureCodegraphIndex(cwd, entry, (indexState) => {
        engineIndexStatus.codegraph = indexState
        void broadcastMcpState()
      })
    })
    .catch(() => {
      indexedRoots.delete(key)
    })
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

/**
 * Files for the composer's `@` picker, across the whole project.
 *
 * The primary root keeps relative paths (that is how the model resolves them from its working
 * directory); every other repository is listed with absolute paths, which `read`/`edit` accept, so
 * a mention still works without pretending the other repo is a subdirectory.
 */
async function listWorkspaceFiles(roots: string[]): Promise<string[]> {
  const all = roots.length > 0 ? roots : [status.cwd]
  const primary = path.resolve(status.cwd)
  // The repository pi sits in is what the user is working on: it gets the larger share, and the
  // others split the rest instead of flooding the list (an installed tool directory can hold more
  // files than the whole project).
  const ordered = [primary, ...all.map((root) => path.resolve(root)).filter((root) => root !== primary)]
  const primaryBudget = ordered.length > 1 ? Math.floor(WORKSPACE_MAX_FILES * 0.6) : WORKSPACE_MAX_FILES
  const otherBudget = ordered.length > 1 ? Math.floor((WORKSPACE_MAX_FILES - primaryBudget) / (ordered.length - 1)) : 0
  const files: string[] = []
  for (const [index, absoluteRoot] of ordered.entries()) {
    const budget = index === 0 ? primaryBudget : Math.max(200, otherBudget)
    const queue = [absoluteRoot]
    let count = 0
    while (queue.length > 0 && count < budget) {
      const dir = queue.pop() as string
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (count >= budget) break
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (WORKSPACE_SKIP.has(entry.name)) continue
          queue.push(full)
        } else if (entry.isFile()) {
          count += 1
          files.push(
            absoluteRoot === primary
              ? path.relative(absoluteRoot, full).split(path.sep).join('/')
              : full.split(path.sep).join('/')
          )
        }
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
  const webConf = webConfig()
  const webNatives = web.nativeProviderEnabled(webConf)
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
      warpgrep: gateway.gatewayError('warpgrep'),
      web: gateway.gatewayError('web')
    },
    web: { braveKey: webConf.braveApiKey, nativeProviders: webNatives }
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
    web: {
      enabled: Boolean(engineConfig().web?.enabled),
      available: Boolean(webConf.braveApiKey) || webNatives.length > 0,
      mode: webConf.mode ?? 'auto',
      braveKeyHint: maskKey(webConf.braveApiKey),
      count: webConf.count ?? 8,
      maxChars: webConf.maxChars ?? 6000,
      nativeSupported: [...web.NATIVE_PROVIDERS],
      nativeProviders: webNatives,
      activeProvider: status.model?.provider,
      route: webRouteLabel(webConf),
      error: engineStates.find((engine) => engine.id === 'web')?.error
    },
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
    userConfigPath: profile.mcpPath(),
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
  mainWindow?.webContents.send('pi:status', statusSnapshot())
}

/** pi's own default is on, so the window starts assuming 90% until settings say otherwise. */
let autoCompactEnabled = true

/** Status as the window should see it: the compaction target belongs with the model info. */
function statusSnapshot(): PiStatus {
  return {
    ...status,
    autoCompactPercent: autoCompactEnabled ? Math.round(autoCompactRatio() * 100) : undefined,
    speed: speed.speedState(status.model, currentSpeedMode()),
    repo: currentRepo
  }
}

/**
 * Repository of the active session.
 *
 * Kept next to the status instead of being fetched per render: `git` is a process launch, and the
 * composer plus the sidebar both want the branch. Refreshed when pi starts on a directory and when
 * the window asks for it explicitly.
 */
let currentRepo: repo.RepoInfo | undefined

async function refreshRepo(dir: string): Promise<void> {
  const info = await repo.repoInfo(dir)
  if (status.cwd !== dir) return
  currentRepo = info
  broadcastStatus()
}

/** Tier saved in the config; the model still decides whether it can be used (see `speed.ts`). */
function currentSpeedMode(): SpeedMode {
  const mode = desktopConfig.speed?.mode
  return mode === 'fast' || mode === 'ultrafast' ? mode : 'standard'
}

function cancelPendingAsks(reason: string): void {
  bridge.cancelAllAsks(reason)
  mainWindow?.webContents.send('ask:cleared')
}

/**
 * `/btw` parks the process on a fork of the current session. While that is true the window must not
 * see the fork at all (no `pi:event`), and everything that switches sessions has to close it first.
 */
let btwActive = false
/** Session to return to when the side chat closes. */
let btwOriginal: string | undefined
/** File of the fork that is currently being talked to. */
let btwFork: string | undefined
/** Bumped on every start/close so a start that is still waiting for the run to settle gives up. */
let btwGeneration = 0

function setStatus(patch: Partial<PiStatus>): void {
  engine.setStatus(patch)
  // While the side-chat panel is open the window keeps showing the main session's status.
  if (btwActive) return
  broadcastStatus()
}

/**
 * The directories this session works on.
 *
 * A session started inside a project covers the whole project: its own directory is the primary one
 * and the rest become additional roots. Outside a project there is exactly one root, which is the
 * behaviour every session had before projects existed.
 */
function currentWorkspace(cwd?: string): AgentWorkspace {
  const primary = cwd ?? status.cwd
  const project = activeProject()
  if (!project) return { primary, additional: [] }
  const key = path.resolve(primary)
  if (!project.roots.some((root) => path.resolve(root.path) === key)) {
    return { primary, additional: [] }
  }
  return {
    primary,
    additional: project.roots
      .map((root) => root.path)
      .filter((root) => path.resolve(root) !== key)
  }
}

/** Start or restart the session; the engine hands the in-flight promise to a second caller. */
async function startPi(cwd?: string, extraArgs: string[] = []): Promise<PiStatus> {
  const next = await engine.start(currentWorkspace(cwd), extraArgs)
  if (next.phase === 'ready') await afterStart(next.cwd, extraArgs)
  return next
}

/**
 * Work that follows every successful start: remember the repository, and put a fresh session on
 * the repository's own defaults.
 *
 * A restart (`--session …`, crash recovery, config reload) must keep whatever the user has chosen,
 * so the defaults only apply when there is no session file to restore.
 */
async function afterStart(workspace: string, extraArgs: string[]): Promise<void> {
  // The engine owns the start now, so the app refreshes the repository facts here.
  void refreshRepo(workspace)
  // Index every repository of the project, not just the one pi is sitting in: code search that
  // silently only covered the primary root would be worse than no index at all.
  const roots = activeProject()?.roots.map((root) => root.path) ?? [workspace]
  for (const root of new Set([workspace, ...roots])) startCodegraphIndex(root)
  const recent = [workspace, ...(desktopConfig.recentRepos ?? []).filter((dir) => dir !== workspace)]
  await saveConfig({ recentRepos: recent.slice(0, 12) })
  if (extraArgs.includes('--session')) return
  const defaults = desktopConfig.repoDefaults?.[workspace]
  if (!defaults) return
  if (defaults.provider && defaults.model) {
    await engine
      .request('set_model', { provider: defaults.provider, modelId: defaults.model }, 10_000)
      .catch(() => undefined)
  }
  if (defaults.thinkingLevel) {
    await engine
      .request('set_thinking_level', { level: defaults.thinkingLevel }, 10_000)
      .catch(() => undefined)
  }
  await engine.refresh()
}

/** Vendor wording for "this account may not use that processing tier". */
const TIER_REJECTED =
  /unsupported service_tier|service_tier[^"]{0,40}(not supported|invalid)|unsupported[^"]{0,20}speed|fast.?mode[^"]{0,30}(not available|not supported)|invalid.*anthropic-beta/i

/**
 * A tier the account cannot use is a 400 that kills the turn, so fall back instead of letting the
 * user resend into the same wall.
 *
 * Measured on a ChatGPT subscription login: `{"detail":"Unsupported service_tier: fast"}` — fast and
 * ultrafast need API billing or a plan that includes them. Nothing advertises that up front, so the
 * first rejection is the signal: drop back to `standard`, restart pi without the tier, and say why.
 */
function noteSpeedRejection(errorMessage: string): void {
  if (currentSpeedMode() === 'standard' || !TIER_REJECTED.test(errorMessage)) return
  void saveConfig({ speed: { mode: 'standard' } })
  broadcastStatus()
  mainWindow?.webContents.send('pi:event', {
    type: 'speed_unsupported',
    detail: errorMessage.slice(0, 200)
  })
  void reloadPiConfig()
}

function sessionArgs(): string[] {
  // While a `/btw` side chat is open the process sits on a fork; a restart must land back on the
  // real session, not on the throwaway branch.
  const file = btwActive ? btwOriginal ?? status.sessionFile : status.sessionFile
  const args = file ? ['--session', file] : []
  // A session that has no messages yet has no file on disk, so the restart would otherwise come
  // back on the default model from settings.json — a model switch or a speed change would look
  // like it silently reverted.
  if (status.model) args.push('--provider', status.model.provider, '--model', status.model.id)
  return args
}

/**
 * Park the pi process back on the main session and throw the `/btw` fork away.
 *
 * Every path that switches or restarts the session calls this first: a follow-up question must never
 * be delivered to whatever session happened to be active after the switch.
 */
async function closeSideChat(): Promise<void> {
  // A start that is still waiting for the current run to settle must not fork afterwards.
  btwGeneration += 1
  if (!btwActive) return
  const original = btwOriginal
  const fork = btwFork
  btwActive = false
  btwOriginal = undefined
  btwFork = undefined
  try {
    if (engine.busy() && engine.running()) {
      await engine.abort().catch(() => undefined)
      await engine.waitForSettle(15_000)
    }
    if (original && engine.running()) {
      await engine.switchSession(original)
    }
  } catch {
    // `refreshState` below re-syncs whatever pi ended up on.
  }
  if (fork && fork !== original) await fs.unlink(fork).catch(() => undefined)
  await engine.refresh()
  broadcastStatus()
}

/** One turn on the session pi is currently parked on (the `/btw` fork while a side chat is open). */
async function btwPrompt(message: string): Promise<{ text: string; settled: boolean }> {
  // Arm the waiter first: a short answer can settle before the prompt response even arrives.
  const settling = engine.waitForSettle(300_000)
  await engine.send(message)
  const settled = await settling
  const text = (await engine.lastAssistantText()) ?? ''
  if (text.trim()) return { text, settled }
  return { text: settled ? '（没有回答）' : '（超过 5 分钟仍未结束，可以关闭窗口）', settled }
}

/** The engine owns the turn; the app only forwards the window's request. */
function submitPrompt(
  message: string,
  behavior?: 'steer' | 'followUp',
  images?: PromptImage[]
): Promise<PromptResult> {
  return engine.prompt(message, { behavior, images })
}

async function reloadPiConfig(): Promise<void> {
  if (btwActive) await closeSideChat()
  await refreshAgents()
  if (engine.busy()) {
    // pi cannot pick up new MCP servers mid-run; remember it and restart when the run settles,
    // otherwise the switch the user just flipped would silently never apply.
    configPending = true
    mainWindow?.webContents.send('pi:config-pending', true)
    return
  }
  configPending = false
  await startPi(status.cwd, sessionArgs())
}

function sendLoginMessage(message: LoginMessage): void {
  mainWindow?.webContents.send('providers:login-message', message)
}

function registerIpc(): void {
  ipcMain.handle('pi:get-status', () => statusSnapshot())

  ipcMain.handle('pi:restart', async (_event, cwd?: string) => {
    if (btwActive) await closeSideChat()
    if (cwd) await saveConfig({ cwd })
    return startPi(cwd ?? status.cwd, sessionArgs())
  })

  ipcMain.handle('pi:new-project-session', async (_event, cwd: string) => {
    if (btwActive) await closeSideChat()
    // A session belongs to one repository: a subdirectory lands on the repo root instead, so the
    // sidebar groups by repository and the agent's cwd is the repo it is working on.
    const workspace = await repo.repoRoot(cwd).then((root) => root ?? cwd)
    await saveConfig({ cwd: workspace })
    return startPi(workspace)
  })

  ipcMain.handle('pi:repo-info', async (_event, dir?: string) => {
    const target = dir ?? status.cwd
    const info = await repo.repoInfo(target)
    // The window's own lookup doubles as a refresh of the active repository (branch/dirty move).
    if (path.resolve(target) === path.resolve(status.cwd)) {
      currentRepo = info
      broadcastStatus()
    }
    return info
  })

  ipcMain.handle('pi:repos', (_event, dirs: string[]) => repo.repoInfos(dirs))

  ipcMain.handle('projects:list', async () => {
    if (!projectStore) return []
    await projectStore.load()
    return projectStore.list()
  })

  ipcMain.handle(
    'projects:create',
    async (_event, input: { name: string; roots: string[]; primary?: string }) => {
      if (!projectStore) return { ok: false, error: '项目存储未就绪' }
      try {
        // A project is a set of repositories: normalise whatever the picker returned to git roots.
        const roots = await Promise.all(
          input.roots.map(async (dir) => (await repo.repoRoot(dir)) ?? dir)
        )
        const project = await projectStore.create({ ...input, roots })
        return { ok: true, project }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'projects:update',
    async (
      _event,
      id: string,
      patch: { name?: string; roots?: string[]; primary?: string }
    ) => {
      if (!projectStore) return { ok: false, error: '项目存储未就绪' }
      try {
        const roots = patch.roots
          ? await Promise.all(patch.roots.map(async (dir) => (await repo.repoRoot(dir)) ?? dir))
          : undefined
        const project = await projectStore.update(id, { ...patch, roots })
        if (!project) return { ok: false, error: '项目不存在' }
        return { ok: true, project }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /** Create a project from a folder picker; the first repository becomes the primary root. */
  ipcMain.handle('projects:create-from-dialog', async () => {
    if (!projectStore) return { ok: false, error: '项目存储未就绪' }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '新建项目：选择仓库（可多选）',
      defaultPath: status.cwd,
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: '已取消' }
    try {
      const roots = await Promise.all(
        result.filePaths.map(async (dir) => (await repo.repoRoot(dir)) ?? dir)
      )
      const project = await projectStore.create({
        name: path.basename(roots[0]),
        roots,
        primary: roots[0]
      })
      return { ok: true, project }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** Add another repository to a project (the primary root stays where it is). */
  ipcMain.handle('projects:add-root', async (_event, id: string) => {
    const project = projectStore?.get(id)
    if (!projectStore || !project) return { ok: false, error: '项目不存在' }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: `向「${project.name}」添加仓库`,
      defaultPath: status.cwd,
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: '已取消' }
    try {
      const added = await Promise.all(
        result.filePaths.map(async (dir) => (await repo.repoRoot(dir)) ?? dir)
      )
      const updated = await projectStore.update(id, {
        roots: [...project.roots.map((root) => root.path), ...added]
      })
      return updated ? { ok: true, project: updated } : { ok: false, error: '项目不存在' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('projects:remove', async (_event, id: string) => {
    await projectStore?.remove(id)
    if (desktopConfig.activeProject === id) await saveConfig({ activeProject: undefined })
    return { ok: true }
  })

  /**
   * Work in a project: restart pi on its primary repository. The other roots reach the model
   * through the extension's `<project>` section (see `prepare`).
   */
  ipcMain.handle('projects:activate', async (_event, id?: string) => {
    const project = id ? projectStore?.get(id) : undefined
    if (id && !project) return { ok: false, error: '项目不存在' }
    await saveConfig({ activeProject: project?.id })
    if (btwActive) await closeSideChat()
    const primary = project?.roots.find((root) => root.primary) ?? project?.roots[0]
    return startPi(primary?.path ?? status.cwd)
  })

  ipcMain.handle('repos:recent', () => desktopConfig.recentRepos ?? [])

  /** Folder picker without side effects, resolved to git roots; used by the project editor. */
  ipcMain.handle('repos:pick-folders', async (_event, title?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: title ?? '选择仓库',
      defaultPath: status.cwd,
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map(async (dir) => (await repo.repoRoot(dir)) ?? dir))
  })

  /** Store the current model/thinking level as this repository's default for new sessions. */
  ipcMain.handle('repos:save-defaults', async () => {
    const defaults = {
      ...(desktopConfig.repoDefaults ?? {}),
      [status.cwd]: {
        provider: status.model?.provider,
        model: status.model?.id,
        thinkingLevel: status.thinkingLevel
      }
    }
    await saveConfig({ repoDefaults: defaults })
    return { ok: true }
  })

  ipcMain.handle('pi:open-session', async (_event, sessionPath: string, cwd: string) => {
    if (btwActive) await closeSideChat()
    await saveConfig({ cwd })
    return startPi(cwd, ['--session', sessionPath])
  })

  ipcMain.handle('desktop:config', () => ({
    cwd: status.cwd,
    sessionMode: currentSessionMode(),
    sessionDir: currentSessionDir(),
    sharedSessionDir: sharedSessionDir(),
    isolatedSessionDir: path.join(app.getPath('userData'), 'sessions'),
    profile: currentProfile(),
    profileDir: desktopProfileDir(),
    cliDir: profile.CLI_AGENT_DIR,
    activeProject: desktopConfig.activeProject
  }))

  /**
   * Switch between the CLI's profile and the desktop's own.
   *
   * Nothing is moved: the window simply starts reading the other directory. Switching to `desktop`
   * leaves it empty until `providers:import-cli` copies the CLI's files in.
   */
  ipcMain.handle('desktop:set-profile', async (_event, next: 'shared' | 'desktop') => {
    if (btwActive) await closeSideChat()
    await saveConfig({ profile: next === 'desktop' ? 'desktop' : 'shared' })
    applyProfile()
    if (next === 'desktop') await fs.mkdir(profile.agentDir(), { recursive: true })
    await startPi(status.cwd)
    return { ok: true, profile: currentProfile(), profileDir: desktopProfileDir() }
  })

  ipcMain.handle('providers:import-cli', async () => {
    try {
      const result = await providers.importFromCli()
      if (result.error) return { ok: false, error: result.error }
      await reloadPiConfig()
      return { ok: true, copied: result.copied, skipped: result.skipped }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('updates:snapshot', () => updates.getSnapshot())
  ipcMain.handle('updates:check', () => updates.check())
  ipcMain.handle('updates:install', () => updates.install())
  ipcMain.handle('updates:cancel', () => updates.cancel())
  ipcMain.handle('updates:auto', (_event, enabled: boolean) => updates.setAuto(enabled))
  ipcMain.handle('app:proxy', () => getProxyInfo())

  ipcMain.handle('desktop:set-session-mode', async (_event, mode: SessionMode) => {
    if (btwActive) await closeSideChat()
    await saveConfig({ sessionMode: mode === 'isolated' ? 'isolated' : 'shared' })
    return startPi(status.cwd)
  })

  ipcMain.handle('pi:choose-workspace', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择一个 git 仓库（将在该仓库新建会话）',
      defaultPath: status.cwd,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // Picking a subdirectory is normal (people browse to `src/`); the session still belongs to the
    // repository, so start at its root and keep the grouping honest.
    const cwd = (await repo.repoRoot(result.filePaths[0])) ?? result.filePaths[0]
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
    ) => submitPrompt(message, streamingBehavior, images)
  )

  ipcMain.handle('pi:abort', async () => {
    cancelPendingAsks('用户中止了本次运行')
    // A subagent that settles right after a manual stop must not start a new turn behind the
    // user's back; the notice is queued instead (see subagentManager onSettle).
    lastAbortAt = Date.now()
    if (!engine.running()) return
    try {
      await engine.abort()
    } catch {
      // ignore
    }
    await engine.refresh()
  })

  ipcMain.handle('pi:new-session', async () => {
    if (!engine.running()) return { ok: false, error: 'pi 未运行' }
    if (btwActive) await closeSideChat()
    try {
      const response = await engine.newSession()
      return { ok: true, cancelled: response.cancelled }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('pi:switch-session', async (_event, sessionPath: string) => {
    if (!engine.running()) return { ok: false, error: 'pi 未运行' }
    if (btwActive) await closeSideChat()
    try {
      await engine.switchSession(sessionPath)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('pi:get-messages', async () => {
    if (!engine.running()) return []
    return engine.messages()
  })

  ipcMain.handle('pi:list-sessions', async () => {
    if (!sessionStore) return listSessions(currentSessionDir())
    await sessionStore.load()
    await importPiSessions()
    // A session deleted from disk (or by another window) must not stay in the list.
    await sessionStore.prune((file) => !existsSync(file)).catch(() => undefined)
    return sessionStore.list().map(toSummary)
  })

  ipcMain.handle('pi:session-stats', async () => {
    if (!engine.running()) return {}
    try {
      return (await engine.stats()) as SessionStats
    } catch {
      return {}
    }
  })

  ipcMain.handle('pi:open-agent-dir', async () => {
    const dir = profile.agentDir()
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

  ipcMain.handle('subagents:list', () =>
    subagentManager().list().map((record) => serializeSubagent(record))
  )
  ipcMain.handle('subagents:get', (_event, id: string) => {
    const record = subagentManager().get(id)
    return record ? serializeSubagent(record) : null
  })
  ipcMain.handle('subagents:stop', async (_event, id: string) => {
    try {
      await subagentManager().stop(id)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle(
    'subagents:prompt',
    async (_event, id: string, text: string, mode: 'interrupt' | 'steer' | 'follow-up') => {
      try {
        await subagentManager().prompt(id, text, mode)
        return true
      } catch {
        return false
      }
    }
  )
  ipcMain.handle('subagents:reveal', (_event, file: string) => {
    if (typeof file !== 'string' || !existsSync(file)) return false
    shell.showItemInFolder(file)
    return true
  })

  ipcMain.handle('workspace:files', () => {
    // A project's picker covers every repository, not just the one pi sits in.
    const roots = activeProject()?.roots.map((root) => root.path) ?? [status.cwd]
    return listWorkspaceFiles(roots)
  })

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

  ipcMain.handle('mcp:set-brave-key', async (_event, key: string | null) => {
    await saveWebConfig({ braveApiKey: key && key.trim() ? key.trim() : undefined })
    await reloadPiConfig()
    return buildMcpState()
  })

  ipcMain.handle(
    'mcp:set-web-mode',
    async (_event, mode: 'auto' | 'brave' | 'native') => {
      const next = mode === 'brave' || mode === 'native' ? mode : 'auto'
      // The route is resolved per call, so no restart is needed here.
      await saveWebConfig({ mode: next })
      void broadcastMcpState()
      return buildMcpState()
    }
  )

  ipcMain.handle(
    'mcp:set-provider-web-search',
    async (_event, providerId: string, enabled: boolean) => {
      if (typeof providerId !== 'string' || !providerId.trim()) return buildMcpState()
      const before = webReady()
      const current = webConfig().native ?? {}
      const native = { ...current }
      if (enabled) native[providerId.trim()] = true
      else delete native[providerId.trim()]
      await saveWebConfig({ native })
      // Turning the last backend on/off changes whether the gateway registers `/mcp/web` at all, so
      // that transition needs the same restart as any other registration change.
      if (webReady() !== before) await reloadPiConfig()
      else void broadcastMcpState()
      return buildMcpState()
    }
  )

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

  ipcMain.handle('pi:compact', async (_event, instructions?: string) => {
    // Compacting the fork would summarize the throwaway branch and leave the real session alone.
    if (btwActive) await closeSideChat()
    try {
      const result = await engine.compact(instructions)
      return { ok: true, summary: result.summary }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * Auto-compaction toggle. Turning it on also writes the reserve that makes pi compact at
   * `AUTO_COMPACT_RATIO` of the current model's window, then restarts pi so it reads that value.
   */
  ipcMain.handle('pi:set-auto-compact', async (_event, enabled: boolean) => {
    try {
      await engine.setAutoCompaction({ enabled })
      await providers.setCompactionSettings({ enabled })
      autoCompactEnabled = enabled
      broadcastStatus()
      if (!enabled) return { ok: true }
      const reserveTokens = await syncAutoCompact({ restart: true })
      const percent = Math.round(autoCompactRatio() * 100)
      if (reserveTokens === undefined) {
        return {
          ok: true,
          percent,
          warning: '当前模型没有上下文窗口信息，自动压缩沿用 pi 的默认余量（16K tokens）'
        }
      }
      return { ok: true, percent, contextWindow: status.model?.contextWindow, reserveTokens }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * `/autocompact 500000`: compact once the context passes that many tokens.
   *
   * The number is stored as a ratio of the window, so a later model switch recomputes it instead of
   * keeping a token count that no longer means anything. Setting a threshold also turns compaction
   * back on: the window's meter and the settings row read `autoCompactPercent`, so leaving
   * `autoCompactEnabled` false here made the UI keep claiming "已关闭 / 90%".
   */
  ipcMain.handle('pi:set-compact-threshold', async (_event, tokens: number) => {
    try {
      const contextWindow = status.model?.contextWindow
      if (!contextWindow) {
        return { ok: false, error: '当前模型没有上下文窗口信息，无法换算阈值' }
      }
      const target = Math.max(1000, Math.round(tokens))
      const reserveTokens = Math.max(0, contextWindow - target)
      await providers.setCompactionSettings({ enabled: true, reserveTokens })
      const ratio = Math.min(0.99, target / contextWindow)
      await saveConfig({ autoCompact: { ratio } })
      autoCompactEnabled = true
      broadcastStatus()
      if (btwActive) await closeSideChat()
      await startPi(status.cwd, sessionArgs())
      return {
        ok: true,
        contextWindow,
        reserveTokens,
        percent: Math.round(autoCompactRatio() * 100)
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * The settings row: auto-compaction starts at this percentage of the model's window.
   *
   * Stored as a ratio (like `/autocompact`) so switching to a model with a different window keeps
   * the same *proportion*; the reserve is recomputed with it. A threshold is only meaningful while
   * compaction is on, so setting one turns it back on.
   */
  ipcMain.handle('pi:set-auto-compact-ratio', async (_event, percent: number) => {
    const value = Math.round(Number(percent))
    if (!Number.isFinite(value) || value < 10 || value > 99) {
      return { ok: false, error: '自动压缩阈值要在 10% 和 99% 之间' }
    }
    try {
      await saveConfig({ autoCompact: { ratio: value / 100 } })
      autoCompactEnabled = true
      await providers.setCompactionSettings({ enabled: true })
      // `syncAutoCompact` only restarts when the reserve changes, so make the switch effective for
      // the process that is running right now (it may have been left with compaction off).
      if (engine.running()) {
        await engine.setAutoCompaction({ enabled: true }).catch(() => undefined)
      }
      broadcastStatus()
      const reserveTokens = await syncAutoCompact({ restart: true })
      if (reserveTokens === undefined) {
        return {
          ok: true,
          percent: value,
          warning: '当前模型没有上下文窗口信息，阈值会在切到有窗口的模型后生效'
        }
      }
      return { ok: true, percent: value, contextWindow: status.model?.contextWindow, reserveTokens }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * `/btw <question>`: open a side chat on a *fresh fork* of the current branch.
   *
   * `clone` duplicates the session at its current position, so the fork starts exactly at the branch
   * node the user is looking at — same as asking a subagent, except the fork carries this
   * conversation's context. The fork stays alive while the panel is open (follow-ups keep talking to
   * it) and is thrown away when the panel closes.
   *
   * `/btw` is a local command, so it is never queued behind the run: if pi is still working, the
   * fork is taken as soon as it settles, and a second `/btw` replaces the previous fork with a new
   * branch from the node the user is on now.
   */
  ipcMain.handle('pi:btw-start', async (_event, question: string) => {
    const trimmed = question.trim()
    if (!trimmed) return { ok: false, error: '缺少问题' }
    if (!engine.running()) return { ok: false, error: 'pi 未运行' }
    if (btwActive) await closeSideChat()
    const generation = ++btwGeneration
    if (engine.busy() && !(await engine.waitForIdle(600_000))) {
      return { ok: false, error: '当前回合还没结束，稍后再问' }
    }
    if (generation !== btwGeneration) return { ok: false, error: '侧边提问已取消' }
    const original = status.sessionFile
    if (!original) return { ok: false, error: '当前会话还没有保存到文件，先发一条消息' }
    btwActive = true
    btwOriginal = original
    try {
      // `fork` requires a specific entry id and rejects the leaf; `clone` is the snapshot we want.
      const forkPath = await engine.clone()
      if (forkPath) btwFork = forkPath
      const answer = await btwPrompt(trimmed)
      return { ok: true, answer: answer.text, settled: answer.settled, forkPath: btwFork }
    } catch (error) {
      await closeSideChat()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** Follow-up turn inside the open side chat: same fork, same context. */
  ipcMain.handle('pi:btw-ask', async (_event, question: string) => {
    const trimmed = question.trim()
    if (!trimmed) return { ok: false, error: '缺少问题' }
    if (!btwActive) return { ok: false, error: '侧边提问已经关闭了' }
    if (engine.busy() && !(await engine.waitForIdle(600_000))) {
      return { ok: false, error: '上一轮还在回答，稍等一下' }
    }
    if (!btwActive) return { ok: false, error: '侧边提问已经关闭了' }
    try {
      const answer = await btwPrompt(trimmed)
      return { ok: true, answer: answer.text, settled: answer.settled }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('pi:btw-close', async () => {
    await closeSideChat()
    return { ok: true }
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
    if (!engine.running()) return []
    try {
      const models = await engine.models()
      const names = new Map<string, string>()
      try {
        for (const provider of await providers.listProviders()) {
          names.set(provider.id, provider.name)
        }
      } catch {
        // provider display names are optional
      }
      const patterns = await providers.getEnabledModelPatterns().catch(() => [])
      return models
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
    if (!engine.running()) return { ok: false, error: 'pi 未运行' }
    try {
      await engine.setModel(provider, modelId)
      // A different window means a different 90% point; pi only reads the reserve at startup, so
      // this restarts when (and only when) the number actually changed.
      await syncAutoCompact({ restart: true }).catch(() => undefined)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('pi:list-thinking-levels', async () => {
    if (!engine.running()) return []
    try {
      return engine.thinkingLevels()
    } catch {
      return []
    }
  })

  ipcMain.handle('pi:set-thinking-level', async (_event, level: string) => {
    if (!engine.running()) return { ok: false, error: 'pi 未运行' }
    try {
      await engine.setThinkingLevel(level)
      setStatus({ thinkingLevel: level })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * Speed / processing tier: OpenAI `service_tier`, Anthropic `speed: fast`.
   *
   * The extension reads it from the environment at load, so the switch restarts pi (deferred while a
   * run is in flight, like every other setting that changes the child's env).
   */
  ipcMain.handle('pi:set-speed-mode', async (_event, mode: SpeedMode) => {
    const support = speed.speedSupport(status.model)
    if (!support.available.includes(mode)) {
      return {
        ok: false,
        error: support.note ?? `${status.model?.id ?? '当前模型'} 不支持这个速度档位`
      }
    }
    await saveConfig({ speed: { mode } })
    broadcastStatus()
    await reloadPiConfig()
    return { ok: true, speed: speed.speedState(status.model, mode) }
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

  /**
   * Custom endpoint for a built-in provider, stored as `models.json.providers.<id>.baseUrl`.
   *
   * pi reads that file at startup, so the session is restarted; the web engine resolves the same
   * value through `providers.getRuntime()`, which `setProviderBaseUrl` already invalidated.
   */
  ipcMain.handle(
    'providers:set-base-url',
    async (_event, providerId: string, baseUrl: string | null) => {
      try {
        await providers.setProviderBaseUrl(providerId, baseUrl)
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

/** Bounded restarts: an extension that crashes on every start must not loop forever. */
let crashRestarts = 0
let crashWindowStart = 0
let shuttingDown = false

function handleExit(): void {
  if (status.phase === 'stopped') return
  setStatus({ phase: 'error', error: engine.stderrTail() || 'pi 进程已退出', isStreaming: false })
  if (shuttingDown) return
  // pi died on its own (a crashing extension, an OOM kill). Leaving the window dead means the next
  // message is lost with "pi 未运行", so bring it back on the same session.
  const now = Date.now()
  if (now - crashWindowStart > 120_000) {
    crashWindowStart = now
    crashRestarts = 0
  }
  if (crashRestarts >= 3) return
  crashRestarts += 1
  console.warn(`[pi] exited unexpectedly, restarting (${crashRestarts}/3)`)
  setTimeout(() => {
    if (!shuttingDown && !engine.running() && !engine.starting()) {
      void startPi(status.cwd, sessionArgs())
    }
  }, 1000)
}

app.whenReady().then(async () => {
  registerIpc()
  await migrateLegacyUserData()
  await applySystemProxy()
  desktopConfig = await loadConfig()
  // Projects live beside the config, in userData; the store reads the file on first use.
  projectStore = new projects.ProjectStore(path.join(app.getPath('userData'), 'projects.json'))
  await projectStore.load().catch(() => undefined)
  // The window's session list: ids, titles and workspaces we own; pi's files are engine storage.
  sessionStore = new SessionStore(path.join(app.getPath('userData'), 'sessions.json'))
  await sessionStore.load().catch(() => undefined)
  engine = createEngine()
  if (engine instanceof PiEngine) engine.watch()
  // Before anything reads a provider, model list or MCP config: point the modules at the profile.
  applyProfile()
  await loadToolCache()
  // Web tools resolve their backend per call, so a model switch or a config edit needs no restart.
  web.configure({
    config: () => webConfig(),
    provider: () => status.model?.provider,
    model: () => status.model?.id
  })
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
    // Endpoints are `codegraph`, `codegraph__<repo>`, `warpgrep`, … — a project adds one per root.
    if (!gateway.isConfigured(engine)) {
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
      desktopTools: () => subagentConfig().desktopTools,
      parentSession: () => status.sessionFile,
      resolveModel: (provider, id) => providers.resolveModelChoice(provider, id)
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
  // Restores the subagent records of previous runs, so the panel and the tools can query them.
  subagentManager()
  void providers.listProviders().catch(() => undefined)
  void providers.listModelChoices().catch(() => undefined)
  // Keep the compaction reserve matched to whatever model the session restores.
  void providers
    .getAppSettings()
    .then((settings) => {
      autoCompactEnabled = settings.compaction?.enabled !== false
      broadcastStatus()
    })
    .catch(() => undefined)
  void startPi(cwd).then(() => syncAutoCompact())

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
  shuttingDown = true
  cancelPendingAsks('桌面窗口已关闭')
  engine.dispose()
  subagents?.stopAll(true)
  gateway.stopAll(true)
  status = { ...status, phase: 'stopped' }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  shuttingDown = true
  bridge.cancelAllAsks('桌面端已退出')
  subagents?.stopAll(true)
  gateway.stopAll(true)
  bridge.stopBridge()
  // A `/btw` fork is a throwaway branch: do not leave it behind as an orphan session.
  if (btwFork) {
    try {
      unlinkSync(btwFork)
    } catch {
      // already gone
    }
  }
  engine.dispose()
})

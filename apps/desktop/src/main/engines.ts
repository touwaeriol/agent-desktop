/**
 * Built-in MCP engines: CodeGraph (local code index) and WarpGrep (Morph code search).
 *
 * CodeGraph is an external CLI: the app resolves its entry point, spawns it as a stdio MCP server
 * behind the gateway, and keeps its index in sync with the session directory. WarpGrep is a hosted
 * API, so it needs an API key instead of a binary and runs inside the gateway itself.
 *
 * Nothing here writes to `~/.pi/agent/mcp.json`: engines are registered by the extension the app
 * passes with `--extension`, so terminal pi sessions stay untouched.
 */
import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpEngineId, McpEngineState, McpToolInfo } from '../shared/types'

/** Tools declared to the model directly; every other tool of the server is loaded via tool_search. */
export const DIRECT_TOOLS: Record<McpEngineId, string[]> = {
  codegraph: ['codegraph_explore', 'codegraph_search', 'codegraph_callers', 'codegraph_impact'],
  warpgrep: ['codebase_search']
}

/**
 * Tools the gateway exposes at all. Everything else the engine offers is dropped before pi sees it,
 * which is how the tool count stays bounded.
 */
export const ALLOWED_TOOLS: Record<McpEngineId, string[]> = {
  codegraph: [
    'codegraph_explore',
    'codegraph_search',
    'codegraph_callers',
    'codegraph_callees',
    'codegraph_impact',
    'codegraph_node',
    'codegraph_status',
    'codegraph_files'
  ],
  warpgrep: ['codebase_search']
}

/** CodeGraph only exposes the tools named here (its own default is `explore` alone). */
const CODEGRAPH_TOOLS = 'explore,search,callers,callees,impact,node,status,files'

const TIMEOUT_MS: Record<McpEngineId, number> = {
  codegraph: 120_000,
  warpgrep: 120_000
}

const DETECT_TIMEOUT_MS = 20_000
const CACHE_MS = 60_000

interface EngineEntry {
  /** Absolute path to an executable, or to the JS entry that must run under node. */
  path: string
  kind: 'node' | 'binary'
}

interface CachedDetection {
  entry?: EngineEntry
  version?: string
  error?: string
  /** Explicit entry the detection was made for, so the cache key matches the config value. */
  explicit?: string
  at: number
}

const detectionCache = new Map<McpEngineId, CachedDetection>()

export function invalidateDetection(id?: McpEngineId): void {
  if (id) detectionCache.delete(id)
  else detectionCache.clear()
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeout ?? DETECT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

/** First `*.js` path mentioned by an npm shim script, so `.cmd` shims never need a shell. */
async function jsEntryFromShim(file: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(file, 'utf8')
    const matches = text.match(/[^\s"'`)]+\.(?:js|cjs|mjs)/g)
    if (!matches) return undefined
    const relative = matches.find((match) => match.includes('node_modules'))
    if (!relative) return undefined
    const resolved = path.resolve(path.dirname(file), relative.replace(/[\\/]+/g, path.sep))
    return existsSync(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

function npmGlobalRoots(): string[] {
  const roots: string[] = []
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  roots.push(
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules')
  )
  return roots
}

function pathCandidates(binary: string): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const names =
    process.platform === 'win32'
      ? [`${binary}.exe`, `${binary}.cmd`, binary]
      : [binary]
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)))
}

async function resolveCodegraph(explicit?: string): Promise<EngineEntry | undefined> {
  if (explicit) {
    if (explicit.endsWith('.js') || explicit.endsWith('.cjs') || explicit.endsWith('.mjs')) {
      return { path: explicit, kind: 'node' }
    }
    const shim = await jsEntryFromShim(explicit)
    if (shim) return { path: shim, kind: 'node' }
    if (explicit.endsWith('.exe')) return { path: explicit, kind: 'binary' }
    return undefined
  }
  const packagePath = path.join('@colbymchenry', 'codegraph', 'npm-shim.js')
  for (const root of npmGlobalRoots()) {
    const candidate = path.join(root, packagePath)
    if (existsSync(candidate)) return { path: candidate, kind: 'node' }
  }
  for (const candidate of pathCandidates('codegraph')) {
    if (!existsSync(candidate)) continue
    const shim = await jsEntryFromShim(candidate)
    if (shim) return { path: shim, kind: 'node' }
    if (candidate.endsWith('.exe')) return { path: candidate, kind: 'binary' }
  }
  return undefined
}

async function detect(id: McpEngineId, explicit?: string): Promise<CachedDetection> {
  const cached = detectionCache.get(id)
  if (cached && Date.now() - cached.at < CACHE_MS && cached.explicit === explicit) return cached
  if (id === 'warpgrep') {
    // WarpGrep is a hosted API: availability is the API key, checked in `engineStates`.
    const result: CachedDetection = { explicit, at: Date.now() }
    detectionCache.set(id, result)
    return result
  }
  const entry = await resolveCodegraph(explicit)
  if (!entry) {
    const result: CachedDetection = {
      explicit,
      at: Date.now(),
      error: explicit
        ? `指定的入口不可用：${explicit}`
        : '未找到 CodeGraph（npm 全局安装 codegraph，或手动指定入口）'
    }
    detectionCache.set(id, result)
    return result
  }
  const probe =
    entry.kind === 'node'
      ? await run(process.execPath, [entry.path, '--version'], { env: { ELECTRON_RUN_AS_NODE: '1' } })
      : await run(entry.path, ['--version'])
  const output = `${probe.stdout}\n${probe.stderr}`.trim()
  const version = output.split('\n').map((line) => line.trim()).find(Boolean)
  const valid = probe.code === 0 && /\d+\.\d+\.\d+/.test(output)
  const result: CachedDetection = valid
    ? { explicit, at: Date.now(), entry, version }
    : {
        explicit,
        at: Date.now(),
        entry,
        error: output
          ? `入口无法运行：${output.slice(0, 200)}`
          : '入口无法运行（--version 失败）'
      }
  detectionCache.set(id, result)
  return result
}

/** Resolved entry path of an engine, or undefined when it cannot be found. */
export async function engineEntry(id: McpEngineId, explicit?: string): Promise<string | undefined> {
  return (await detect(id, explicit)).entry?.path
}

/** What the gateway needs to serve one engine. */
export interface EngineTargetSpec {
  id: McpEngineId
  kind: 'upstream' | 'warpgrep'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd: string
  /** Upstream tool names to expose; everything else is dropped. */
  allowlist: string[]
  timeoutMs: number
  /** WarpGrep only. */
  apiKey?: string
}

/** What the extension registers with pi: one HTTP endpoint per engine. */
export interface EngineRegistration {
  name: string
  url: string
  headers: Record<string, string>
  exposure: 'deferred'
  toolExposure: Record<string, string>
  timeout: number
  description: string
}

function exposureFor(
  id: McpEngineId,
  toggles: Record<string, Record<string, boolean> | undefined>
): Record<string, string> {
  const toolExposure: Record<string, string> = {}
  for (const tool of DIRECT_TOOLS[id]) toolExposure[tool] = 'direct'
  for (const [tool, enabled] of Object.entries(toggles[id] ?? {})) {
    if (!enabled) toolExposure[tool] = 'hidden'
  }
  return toolExposure
}

/** Engines that are enabled and usable, in the shape the gateway consumes. */
export async function buildEngineTargets(options: {
  cwd: string
  config: Record<string, { enabled?: boolean; entry?: string } | undefined>
  morphApiKey?: string
}): Promise<EngineTargetSpec[]> {
  const targets: EngineTargetSpec[] = []
  for (const id of ['codegraph', 'warpgrep'] as McpEngineId[]) {
    const engine = options.config[id]
    if (!engine?.enabled) continue
    if (id === 'warpgrep') {
      targets.push({
        id,
        kind: 'warpgrep',
        cwd: options.cwd,
        allowlist: ALLOWED_TOOLS[id],
        timeoutMs: TIMEOUT_MS[id],
        apiKey: options.morphApiKey?.trim() || undefined
      })
      continue
    }
    const detection = await detect(id, engine.entry?.trim() || undefined)
    if (!detection.entry) continue
    targets.push({
      id,
      kind: 'upstream',
      command: process.execPath,
      args: [detection.entry.path, 'serve', '--mcp', '--path', options.cwd],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        // No CODEGRAPH_NO_DAEMON: that makes the server take CodeGraph's single writer lock, and a
        // second client (the user's IDE or terminal) then either refuses to start or serves a
        // reduced tool set. Letting it proxy to the shared daemon keeps them coexisting.
        CODEGRAPH_MCP_TOOLS: CODEGRAPH_TOOLS
      },
      cwd: options.cwd,
      allowlist: ALLOWED_TOOLS[id],
      timeoutMs: TIMEOUT_MS[id]
    })
  }
  return targets
}

/** Endpoint registrations for the extension; each URL is a gateway on the loopback bridge. */
export function buildEngineRegistrations(options: {
  baseUrl: string
  token: string
  targets: EngineTargetSpec[]
  toggles: Record<string, Record<string, boolean> | undefined>
}): EngineRegistration[] {
  return options.targets.map((target) => ({
    name: target.id,
    url: `${options.baseUrl}/mcp/${target.id}`,
    headers: { authorization: `Bearer ${options.token}` },
    exposure: 'deferred',
    toolExposure: exposureFor(target.id, options.toggles),
    timeout: Math.round(target.timeoutMs / 1000),
    description:
      target.id === 'codegraph'
        ? `CodeGraph 网关：符号搜索、调用关系、影响面分析（${ALLOWED_TOOLS.codegraph.length} 个工具，默认只返回位置不返回源码）`
        : 'WarpGrep 网关：Morph 的自然语言代码搜索（codebase_search，默认只返回文件与行号）'
  }))
}

export async function engineStates(options: {
  config: Record<string, { enabled?: boolean; entry?: string } | undefined>
  morphApiKey?: string
  toggles: Record<string, Record<string, boolean> | undefined>
  tools: Record<string, McpToolInfo[] | undefined>
  indexStatus: Record<string, { state: McpEngineState['index']; message?: string } | undefined>
  gatewayErrors?: Record<string, string | undefined>
}): Promise<McpEngineState[]> {
  const states: McpEngineState[] = []
  const hasKey = Boolean(options.morphApiKey?.trim())
  for (const id of ['codegraph', 'warpgrep'] as McpEngineId[]) {
    const engine = options.config[id] ?? {}
    const detection = await detect(id, engine.entry?.trim() || undefined)
    const known = options.tools[id] ?? []
    const available = id === 'warpgrep' ? hasKey : Boolean(detection.entry) && !detection.error
    const error =
      options.gatewayErrors?.[id] ??
      detection.error ??
      (id === 'warpgrep' && !hasKey ? '未配置 Morph API Key' : undefined)
    states.push({
      id,
      name: id === 'codegraph' ? 'CodeGraph' : 'WarpGrep',
      enabled: Boolean(engine.enabled),
      available,
      entry: id === 'warpgrep' ? 'api.morphllm.com/v1' : engine.entry?.trim() || detection.entry?.path,
      version: detection.version,
      error,
      index: id === 'codegraph' ? (options.indexStatus[id]?.state ?? 'unknown') : undefined,
      indexMessage: id === 'codegraph' ? options.indexStatus[id]?.message : undefined,
      tools: known.map((tool) => ({
        ...tool,
        enabled: options.toggles[id]?.[tool.name] !== false,
        direct: DIRECT_TOOLS[id].includes(tool.name)
      }))
    })
  }
  return states
}

/** `.codegraph` at or above `cwd`, which is where CodeGraph looks for its index. */
export function findCodegraphIndex(cwd: string): string | undefined {
  let dir = path.resolve(cwd)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, '.codegraph')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const indexRuns = new Map<string, Promise<{ ok: boolean; message: string }>>()

/**
 * Build the index when the project has none. Runs in the background: the MCP server connects right
 * away and reports missing-index results until the run finishes.
 *
 * An existing index is left alone on purpose. The running MCP server holds CodeGraph's file lock, so
 * an automatic `sync` would fail with "database is locked"; re-indexing stays a manual action
 * (Settings → 立即索引), which is also when the user expects it to take a while.
 */
export function ensureCodegraphIndex(
  cwd: string,
  entry: string | undefined,
  onStatus: (status: { state: McpEngineState['index']; message?: string }) => void
): void {
  if (!entry) return
  if (indexRuns.get(cwd)) return
  if (findCodegraphIndex(cwd)) {
    onStatus({ state: 'indexed', message: '使用现有索引' })
    return
  }
  onStatus({ state: 'indexing', message: `codegraph init ${cwd}` })
  const task = run(process.execPath, [entry, 'init', cwd], {
    cwd,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    timeout: 0
  }).then((result) => {
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (result.code !== 0) {
      const message = output.split('\n').filter(Boolean).slice(-3).join(' ') || 'codegraph init 失败'
      onStatus({ state: 'failed', message })
      return { ok: false, message }
    }
    onStatus({ state: 'indexed', message: 'codegraph init 完成' })
    return { ok: true, message: output.split('\n').filter(Boolean).slice(-1)[0] ?? '' }
  })
  indexRuns.set(cwd, task)
  void task.finally(() => indexRuns.delete(cwd))
}

export async function runCodegraphIndex(
  cwd: string,
  config: { enabled?: boolean; entry?: string } | undefined
): Promise<{ ok: boolean; message: string }> {
  const detection = await detect('codegraph', config?.entry?.trim() || undefined)
  if (!detection.entry) return { ok: false, message: detection.error ?? '未找到 CodeGraph' }
  const action = findCodegraphIndex(cwd) ? 'sync' : 'init'
  const result = await run(process.execPath, [detection.entry.path, action, cwd], {
    cwd,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    timeout: 0
  })
  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (result.code !== 0) {
    if (/locked/i.test(output)) {
      return {
        ok: false,
        message:
          '索引被运行中的 CodeGraph 服务器锁定：先关闭 CodeGraph 引擎（或重启 pi）再索引，' +
          '或在项目里运行 codegraph unlock'
      }
    }
    return { ok: false, message: output.split('\n').filter(Boolean).slice(-3).join(' ') || '索引失败' }
  }
  invalidateDetection('codegraph')
  return { ok: true, message: `codegraph ${action} 完成` }
}

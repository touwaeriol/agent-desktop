/**
 * Subagent runtime: one `pi --mode rpc` child process per subagent.
 *
 * The main agent drives these through the desktop MCP tools; this module owns the processes, the
 * state machine, the collected messages/tool calls and the limits (concurrency, runtime, idle).
 *
 * Subagents run with `--no-mcp` by default: they must not ask the user questions or start nested
 * subagents. Their sessions live in their own directory so they never show up in the sidebar.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PiRpcClient } from './pi-rpc'
import type { AgentMode, AgentPreset } from './agents'

export type SubagentStatus = 'starting' | 'idle' | 'streaming' | 'error' | 'stopped'

/**
 * How the parent agent learns that a subagent finished a turn.
 *
 * - `queue`: append a notice to the parent session; the parent reads it on its next turn
 * - `wake`: also start a parent turn right away
 * - `none`: only the `get_subagent` / `wait_subagent` tools can see the result
 */
export type NotifyMode = 'queue' | 'wake' | 'none'

export interface SubagentMessage {
  role: 'assistant' | 'user'
  text: string
  ts: number
  toolCalls?: string[]
}

export interface SubagentCall {
  tool: string
  ts: number
  ok: boolean
  summary?: string
}

export interface SubagentRecord {
  id: string
  label?: string
  agent?: string
  mode: AgentMode
  cwd: string
  status: SubagentStatus
  createdAt: number
  startedAt?: number
  settledAt?: number
  error?: string
  model?: { provider: string; id: string }
  tools?: string[]
  messages: SubagentMessage[]
  calls: SubagentCall[]
  finalText?: string
  tokens?: number
  runtimeMs?: number
  timeoutMs: number
  notify: NotifyMode
}

export interface StartOptions {
  task: string
  preset?: AgentPreset
  mode?: AgentMode
  provider?: string
  model?: string
  thinking?: string
  tools?: string[]
  cwd?: string
  label?: string
  timeoutMs?: number
  waitMs?: number
  desktopTools?: boolean
  notify?: NotifyMode
}

export interface StartResult {
  record: SubagentRecord
  resolved: {
    agent?: string
    mode: AgentMode
    tools?: string[]
    model?: { provider: string; id: string }
    cwd: string
  }
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_WAIT_MS = 120 * 1000
const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const READY_TIMEOUT_MS = 30_000
const MAX_KEPT = 40

interface PendingCall {
  tool: string
  target?: string
}

interface Internal {
  record: SubagentRecord
  rpc: PiRpcClient
  pendingCalls: Map<string, PendingCall>
  waiters: Array<(record: SubagentRecord) => void>
  totalTimer?: NodeJS.Timeout
  idleTimer?: NodeJS.Timeout
  settled: boolean
  /** Incremented per turn, so one settle is reported once even though two events fire. */
  runId: number
  notifiedRun: number
}

export class SubagentManager {
  private readonly items = new Map<string, Internal>()
  private maxConcurrent = 4

  constructor(
    private readonly options: {
      userData: string
      /** Called when a record changes, for the settings/UI side. */
      onUpdate?: (record: SubagentRecord) => void
      /** Called once per finished turn when `notify` is not `none`. */
      onSettle?: (record: SubagentRecord) => void
      resolveModel?: (provider: string, id: string) => Promise<boolean>
    }
  ) {}

  setMaxConcurrent(value: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(value))
  }

  private sessionDir(): string {
    return path.join(this.options.userData, 'subagents')
  }

  private emit(record: SubagentRecord): void {
    this.options.onUpdate?.(record)
  }

  private runningCount(): number {
    let count = 0
    for (const item of this.items.values()) {
      if (item.record.status === 'starting' || item.record.status === 'streaming' || item.record.status === 'idle') {
        count += 1
      }
    }
    return count
  }

  list(): SubagentRecord[] {
    return [...this.items.values()].map((item) => item.record)
  }

  get(id: string): SubagentRecord | undefined {
    return this.items.get(id)?.record
  }

  /** Start a subagent and, in sync mode, wait up to `waitMs` for its first answer. */
  async start(options: StartOptions): Promise<StartResult> {
    if (this.runningCount() >= this.maxConcurrent) {
      throw Object.assign(new Error(`已有 ${this.maxConcurrent} 个子代理在运行，先 stop_subagent 或等其结束`), {
        code: 'SUBAGENT_LIMIT'
      })
    }
    const preset = options.preset
    const mode: AgentMode = options.mode ?? preset?.mode ?? 'background'
    const cwd = options.cwd ?? process.cwd()
    if (!existsSync(cwd)) {
      throw Object.assign(new Error(`工作目录不存在：${cwd}`), { code: 'BAD_CWD' })
    }
    const tools = options.tools ?? preset?.tools
    const model =
      options.provider && options.model
        ? { provider: options.provider, id: options.model }
        : preset && preset.model && preset.model !== 'inherit'
          ? preset.model
          : undefined
    const id = `sa_${randomUUID().slice(0, 8)}`
    const record: SubagentRecord = {
      id,
      label: options.label,
      agent: preset?.id,
      mode,
      cwd,
      status: 'starting',
      createdAt: Date.now(),
      model,
      tools,
      messages: [],
      calls: [],
      timeoutMs: options.timeoutMs ?? preset?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Sync mode already returns the answer, so only background runs notify by default.
      notify: options.notify ?? (mode === 'background' ? 'queue' : 'none')
    }
    const rpc = new PiRpcClient()
    const internal: Internal = {
      record,
      rpc,
      pendingCalls: new Map(),
      waiters: [],
      settled: false,
      runId: 0,
      notifiedRun: 0
    }
    this.items.set(id, internal)
    this.prune()

    rpc.on('event', (event: Record<string, unknown>) => this.onEvent(internal, event))
    rpc.on('exit', () => {
      if (record.status === 'stopped' || record.status === 'error') return
      record.status = 'error'
      record.error = record.error ?? `子代理进程退出（${rpc.stderrTail.slice(-200) || '无输出'}）`
      this.finish(internal)
    })

    const args = ['--session-dir', this.sessionDir()]
    if (!options.desktopTools) args.push('--no-mcp')
    if (tools && tools.length > 0) args.push('--tools', tools.join(','))
    if (model) args.push('--provider', model.provider, '--model', options.thinking ? `${model.id}:${options.thinking}` : model.id)
    const appendPrompt = preset?.appendSystemPrompt
    if (appendPrompt) args.push('--append-system-prompt', appendPrompt)

    await fs.mkdir(this.sessionDir(), { recursive: true })
    rpc.start(cwd, args, {})
    record.startedAt = Date.now()
    this.emit(record)

    internal.totalTimer = setTimeout(() => {
      void this.stop(id, true, `超过 ${Math.round(record.timeoutMs / 1000)}s 运行上限`)
    }, record.timeoutMs)

    await this.waitReady(internal)
    if (record.status === 'error') {
      throw Object.assign(new Error(record.error ?? '子代理启动失败'), { code: 'SUBAGENT_START_FAILED' })
    }
    record.status = 'idle'
    this.emit(record)

    await rpc.request('prompt', { message: options.task }, 30_000).catch((error: unknown) => {
      record.status = 'error'
      record.error = error instanceof Error ? error.message : String(error)
      this.finish(internal)
    })

    const resolved = { agent: preset?.id, mode, tools, model, cwd }
    if (mode === 'background') {
      return { record, resolved, timedOut: false }
    }
    const waitMs = Math.min(options.waitMs ?? DEFAULT_WAIT_MS, 300_000)
    const timedOut = await this.waitFor(internal, waitMs)
    return { record, resolved, timedOut }
  }

  private async waitReady(internal: Internal): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < READY_TIMEOUT_MS) {
      try {
        await internal.rpc.request('get_state', {}, 3000)
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    internal.record.status = 'error'
    internal.record.error = '子代理未在 30s 内就绪'
    internal.rpc.stop()
    this.finish(internal)
  }

  private onEvent(internal: Internal, event: Record<string, unknown>): void {
    const record = internal.record
    switch (event.type) {
      case 'agent_start':
        internal.runId += 1
        record.status = 'streaming'
        this.emit(record)
        return
      case 'tool_execution_start': {
        const callId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        const tool = typeof event.toolName === 'string' ? event.toolName : 'tool'
        if (callId) internal.pendingCalls.set(callId, { tool, target: callTarget(tool, event.args) })
        return
      }
      case 'tool_execution_end': {
        const callId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
        const tool = typeof event.toolName === 'string' ? event.toolName : 'tool'
        const pending = callId ? internal.pendingCalls.get(callId) : undefined
        if (callId) internal.pendingCalls.delete(callId)
        record.calls.push({
          tool,
          ts: Date.now(),
          ok: event.isError !== true,
          ...(pending?.target ? { summary: pending.target } : {})
        })
        return
      }
      case 'agent_settled':
      case 'agent_end':
        void this.collect(internal)
        return
      default:
    }
  }

  /** Pull the transcript after a turn settles; only assistant text is kept. */
  private async collect(internal: Internal): Promise<void> {
    const record = internal.record
    try {
      const response = await internal.rpc.request<{ data?: { messages?: Array<Record<string, unknown>> } }>(
        'get_messages',
        {},
        10_000
      )
      const messages = response.data?.messages ?? []
      record.messages = []
      for (const message of messages) {
        const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : undefined
        if (!role) continue
        const text = extractText(message)
        const toolCalls = extractToolCalls(message)
        if (!text && toolCalls.length === 0) continue
        record.messages.push({
          role,
          text,
          ts: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
          ...(toolCalls.length > 0 ? { toolCalls } : {})
        })
      }
      const lastAssistant = [...record.messages].reverse().find((message) => message.role === 'assistant')
      if (lastAssistant?.text) record.finalText = lastAssistant.text
    } catch {
      // transcript is best effort
    }
    try {
      const stats = await internal.rpc.request<{ data?: { tokens?: { total?: number } } }>(
        'get_session_stats',
        {},
        5000
      )
      const total = stats.data?.tokens?.total
      if (typeof total === 'number') record.tokens = total
    } catch {
      // stats are optional
    }
    if (record.status !== 'stopped' && record.status !== 'error') record.status = 'idle'
    record.settledAt = Date.now()
    record.runtimeMs = record.startedAt ? Date.now() - record.startedAt : undefined
    this.emit(record)
    this.notifySettle(internal)
    this.resetIdle(internal)
    this.releaseWaiters(internal)
  }

  /** Tell the parent agent that a turn finished, once per run. */
  private notifySettle(internal: Internal): void {
    const record = internal.record
    if (record.notify === 'none') return
    if (internal.notifiedRun === internal.runId) return
    internal.notifiedRun = internal.runId
    this.options.onSettle?.(record)
  }

  private resetIdle(internal: Internal): void {
    if (internal.idleTimer) clearTimeout(internal.idleTimer)
    if (internal.record.status !== 'idle') return
    internal.idleTimer = setTimeout(() => {
      void this.stop(internal.record.id, true, '空闲超时，已自动回收')
    }, IDLE_TIMEOUT_MS)
  }

  private releaseWaiters(internal: Internal): void {
    if (internal.record.status === 'streaming' || internal.record.status === 'starting') return
    for (const waiter of internal.waiters.splice(0)) waiter(internal.record)
  }

  private finish(internal: Internal): void {
    if (internal.settled) return
    internal.settled = true
    if (internal.totalTimer) clearTimeout(internal.totalTimer)
    if (internal.idleTimer) clearTimeout(internal.idleTimer)
    this.emit(internal.record)
    if (internal.record.status === 'error') this.notifySettle(internal)
    this.releaseWaiters(internal)
  }

  /** Resolve when the subagent is no longer running, or after `timeoutMs`. */
  waitFor(internal: Internal, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), timeoutMs)
      internal.waiters.push(() => {
        clearTimeout(timer)
        resolve(false)
      })
    })
  }

  async wait(id: string, timeoutMs: number): Promise<{ record: SubagentRecord; timedOut: boolean }> {
    const internal = this.items.get(id)
    if (!internal) throw Object.assign(new Error(`未知子代理：${id}`), { code: 'UNKNOWN_SUBAGENT' })
    if (internal.record.status === 'idle' || internal.record.status === 'stopped' || internal.record.status === 'error') {
      return { record: internal.record, timedOut: false }
    }
    const timedOut = await this.waitFor(internal, Math.min(Math.max(timeoutMs, 1000), 300_000))
    return { record: internal.record, timedOut }
  }

  async prompt(id: string, text: string, mode: 'interrupt' | 'steer' | 'follow-up'): Promise<SubagentRecord> {
    const internal = this.items.get(id)
    if (!internal) throw Object.assign(new Error(`未知子代理：${id}`), { code: 'UNKNOWN_SUBAGENT' })
    if (internal.record.status === 'stopped' || internal.record.status === 'error') {
      throw Object.assign(new Error(`子代理已结束（${internal.record.status}）`), { code: 'SUBAGENT_NOT_RUNNING' })
    }
    if (mode === 'interrupt' && internal.record.status === 'streaming') {
      await internal.rpc.request('abort', {}, 10_000).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const behavior = mode === 'steer' ? 'steer' : mode === 'follow-up' ? 'followUp' : undefined
    await internal.rpc.request(
      'prompt',
      behavior ? { message: text, streamingBehavior: behavior } : { message: text },
      30_000
    )
    if (internal.record.status !== 'streaming') internal.record.status = 'streaming'
    this.emit(internal.record)
    return internal.record
  }

  async stop(id: string, keepMessages = true, reason?: string): Promise<SubagentRecord> {
    const internal = this.items.get(id)
    if (!internal) throw Object.assign(new Error(`未知子代理：${id}`), { code: 'UNKNOWN_SUBAGENT' })
    if (internal.record.status === 'stopped') return internal.record
    try {
      await internal.rpc.request('abort', {}, 5000)
    } catch {
      // already idle
    }
    internal.rpc.stop()
    internal.record.status = 'stopped'
    internal.record.runtimeMs = internal.record.startedAt ? Date.now() - internal.record.startedAt : undefined
    if (reason) internal.record.error = reason
    if (!keepMessages) {
      internal.record.messages = []
      internal.record.calls = []
      internal.record.finalText = undefined
    }
    this.finish(internal)
    return internal.record
  }

  stopAll(sync = false): void {
    for (const internal of this.items.values()) {
      if (internal.record.status === 'stopped') continue
      if (sync) internal.rpc.killNow()
      else internal.rpc.stop()
      internal.record.status = 'stopped'
      this.finish(internal)
    }
  }

  /** Keep the newest records, dropping the oldest finished ones. */
  private prune(): void {
    if (this.items.size <= MAX_KEPT) return
    const finished = [...this.items.values()]
      .filter((item) => item.record.status === 'stopped' || item.record.status === 'error')
      .sort((a, b) => a.record.createdAt - b.record.createdAt)
    for (const item of finished) {
      if (this.items.size <= MAX_KEPT) break
      this.items.delete(item.record.id)
    }
  }
}

function extractText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const value = block as Record<string, unknown>
      return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractToolCalls(message: Record<string, unknown>): string[] {
  const content = message.content
  if (!Array.isArray(content)) return []
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const value = block as Record<string, unknown>
      return value.type === 'toolCall' && typeof value.name === 'string' ? value.name : ''
    })
    .filter(Boolean)
}

/** What a call touched, taken from its arguments rather than its output. */
function callTarget(_tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const value = args as Record<string, unknown>
  const path = value.path ?? value.file ?? value.filePath ?? value.target
  if (typeof path === 'string') return path.slice(0, 160)
  const command = value.command ?? value.cmd
  if (typeof command === 'string') return command.slice(0, 160)
  const pattern = value.pattern ?? value.query
  if (typeof pattern === 'string') return pattern.slice(0, 120)
  return undefined
}

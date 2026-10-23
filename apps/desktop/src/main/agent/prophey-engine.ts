import type { Model } from '@earendil-works/pi-ai'
import type { PiModel, PiStatus, PromptImage, PromptResult } from '@shared/types'
import * as providers from '../providers'
import * as speed from '../speed'
import type { TranscriptStore } from '../transcript-store'
import { loadMcpTools } from './mcp-client'
import {
  bridgeContext,
  loadAskTool,
  loadSubagentTools,
  loadWorkspaceTools,
  toolDeclarations,
  type CoreTool
} from './core-tools'
import type { AgentEngine, AgentWorkspace } from './engine'

/**
 * Prophey — our own engine, v1.
 *
 * This is the first step of replacing pi's loop: the same contract, driven by our own call to the
 * provider layer (`ModelRuntime.streamSimple`) instead of a child process speaking JSONL. It exists
 * so the seam is real rather than theoretical; it is **not** a replacement yet:
 *
 * - no tool execution (pi's tools and our root-aware tools are not wired in)
 * - no compaction, retries, subagents, `/btw`, sessions or extensions
 * - no persistence: the transcript lives in memory for the life of the process
 *
 * Everything it cannot do throws a clear "not implemented" instead of pretending, and it is only
 * selected when `config.engine` is `own`. The default engine stays pi.
 */
export class PropheyEngine implements AgentEngine {
  readonly id = 'prophey'

  private snapshot: PiStatus = { phase: 'stopped', cwd: process.cwd() }
  private roots: AgentWorkspace = { primary: process.cwd(), additional: [] }
  private isBusy = false
  private model: Model<string> | undefined
  private transcript: Array<Record<string, unknown>> = []
  private tools: CoreTool[] | undefined
  private sessionId: string | undefined
  /** Auto-compaction: enabled plus the percentage of the window that triggers it. */
  private autoCompact: { enabled: boolean; percent: number } = { enabled: false, percent: 50 }
  private loaded = false

  constructor(
    private readonly options: {
      onStatus(next: PiStatus): void
      onEvent(record: Record<string, unknown>): void
      onSettled(): void
      /** Absolute path of `tools/workspace.mjs`; the tools are shared with pi's MCP server. */
      toolModulePath?: string
      /** Where our own transcripts live; without it the conversation stays in memory. */
      transcripts?: TranscriptStore
      /** Current session id; the app allocates and rotates it. */
      sessionId?: () => string | undefined
      /** The app's auto-compaction setting (same value the threshold dropdown writes). */
      autoCompact?: () => { enabled: boolean; percent: number }
      /** Bridge URL/token: how the subagent tools reach the app's manager. */
      bridge?: () => { url: string; token: string } | undefined
      /** Directory holding `subagent.mjs`; absent when subagents are off. */
      subagentModulePath?: string
      /** Path of `ask-user.mjs`; the desktop question dialog. */
      askModulePath?: string
      /** The processing tier the window selected; resolved per model. */
      speedMode?: () => 'standard' | 'fast' | 'ultrafast'
      /** The app's MCP endpoints (`/mcp/<key>` on the bridge), configured for this workspace. */
      mcpEndpoints?: (
        workspace: AgentWorkspace
      ) => Promise<Array<{ name: string; url: string; token: string; description?: string }>>
    }
  ) {}

  state(): PiStatus {
    return this.snapshot
  }

  busy(): boolean {
    return this.isBusy
  }

  compacting(): boolean {
    return false
  }

  running(): boolean {
    return this.snapshot.phase === 'ready'
  }

  stderrTail(): string {
    return ''
  }

  workspace(): AgentWorkspace {
    return { primary: this.roots.primary, additional: [...this.roots.additional] }
  }

  starting(): boolean {
    return false
  }

  async start(workspace?: string | AgentWorkspace): Promise<PiStatus> {
    const wanted =
      typeof workspace === 'string'
        ? { primary: workspace, additional: [] }
        : workspace ?? this.roots
    this.roots = { primary: wanted.primary, additional: [...wanted.additional] }
    this.snapshot = { phase: 'ready', cwd: wanted.primary, isStreaming: false, compacting: false }
    this.options.onStatus(this.snapshot)
    // Pick a model up front: the window reads it from the status, and an unset model shows as
    // "未登录 / 无可用模型" even though the engine is perfectly able to run.
    if (!this.model) await this.pickModel().catch(() => undefined)
    const compaction = this.options.autoCompact?.()
    if (compaction) this.autoCompact = compaction
    await this.resume()
    this.setStatus({ sessionFile: this.transcriptPath() })
    return this.snapshot
  }

  stop(): void {
    this.isBusy = false
    this.snapshot = { ...this.snapshot, phase: 'stopped' }
    this.options.onStatus(this.snapshot)
  }

  dispose(): void {
    this.stop()
  }

  setStatus(patch: Partial<PiStatus>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.options.onStatus(this.snapshot)
  }

  async refresh(): Promise<void> {
    // Nothing external to ask: the state lives here.
  }

  async waitForSettle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.isBusy && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return !this.isBusy
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    return this.waitForSettle(timeoutMs)
  }

  // --- not implemented yet ---------------------------------------------------------------------
  // Each of these is a real gap, not an oversight: they are what pi still provides.

  private unimplemented(what: string): never {
    throw new Error(`Prophey 引擎 v1 还不支持${what}（请切回 pi 引擎）`)
  }

  request<T = Record<string, unknown>>(): Promise<T> {
    this.unimplemented('引擎命令通道')
  }

  models(): Promise<Record<string, unknown>[]> {
    this.unimplemented('模型目录查询')
  }

  async setModel(provider: string, modelId: string): Promise<PiModel | undefined> {
    const runtime = await providers.getRuntime()
    const model = runtime.getModel(provider, modelId) as Model<string> | undefined
    if (!model) throw new Error(`找不到模型 ${provider}/${modelId}`)
    this.model = model
    const info = modelInfo(model)
    this.setStatus({ model: info })
    return info
  }

  thinkingLevels(): Promise<string[]> {
    this.unimplemented('思考等级')
  }

  setThinkingLevel(): Promise<void> {
    this.unimplemented('思考等级')
  }

  /**
   * Usage as far as we can tell it.
   *
   * The provider reports usage per response, but the transcript is what fills the window, so the
   * number that matters for the meter is an estimate of the whole conversation (~4 characters per
   * token, which is close enough for a percentage and never blocks on a round trip).
   */
  async stats(): Promise<{
    tokens?: { input?: number; output?: number; total?: number }
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }
  }> {
    const tokens = estimateTokens(this.transcript)
    const contextWindow = this.model?.contextWindow
    return {
      tokens: { input: tokens, output: 0, total: tokens },
      contextUsage: {
        tokens,
        contextWindow,
        percent: contextWindow ? Math.min(100, (tokens / contextWindow) * 100) : null
      }
    }
  }

  async messages(): Promise<unknown[]> {
    return [...this.transcript]
  }

  lastAssistantText(): Promise<string | null> {
    const last = [...this.transcript].reverse().find((entry) => entry.role === 'assistant')
    const content = Array.isArray(last?.content) ? (last?.content as unknown[]) : []
    const text = content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
      .join('')
    return Promise.resolve(text || null)
  }

  async setAutoCompaction(options: { enabled: boolean; reserveTokens?: number }): Promise<void> {
    // Nothing to configure in the engine: the limit comes from the model window and the app's ratio.
    this.autoCompact = { ...this.autoCompact, enabled: options.enabled }
    this.setStatus({ autoCompactPercent: options.enabled ? this.autoCompact.percent : undefined })
  }

  /**
   * Rewrite the context: the model summarizes the conversation, and the summary replaces it.
   *
   * Same idea as pi's compaction — the transcript becomes a single "here is what happened" message,
   * so the next turn starts with room to work instead of replaying everything.
   */
  async compact(instructions?: string): Promise<{ summary?: string }> {
    const model = this.model ?? (await this.pickModel())
    if (!model) throw new Error('没有可用的模型，无法压缩')
    if (this.transcript.length === 0) return {}
    const runtime = await providers.getRuntime()
    this.setStatus({ compacting: true })
    this.options.onEvent({ type: 'compaction_start', reason: 'manual' })
    try {
      const stream = runtime.streamSimple(
        model,
        {
          systemPrompt:
            '你在压缩一段编码会话的上下文。输出一段中文摘要，保留：用户的目标、已做出的决定、' +
            '改过/读过的文件与其作用、未完成的工作、以及继续工作需要的具体事实（路径、命令、' +
            '错误信息）。不要寒暄，不要复述工具输出全文。' +
            (instructions?.trim() ? `

用户额外要求：${instructions.trim()}` : ''),
          messages: this.transcript as never
        },
        {}
      )
      let text = ''
      let partial: Record<string, unknown> | undefined
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        if (event.type === 'text_delta') {
          partial = event.partial as Record<string, unknown>
        }
        if (event.type === 'text_end') text = String((event as { content?: unknown }).content ?? text)
        if (event.type === 'error') throw new Error(describeError(event.error))
      }
      if (!text.trim() && partial) text = textOf(partial)
      if (!text.trim()) throw new Error('压缩没有返回内容')
      this.transcript = [
        {
          role: 'user',
          content: `【此前对话摘要】
${text.trim()}`,
          timestamp: Date.now()
        }
      ]
      this.persist()
      this.options.onEvent({ type: 'compaction_end', summary: text.trim() })
      return { summary: text.trim() }
    } finally {
      this.setStatus({ compacting: false })
    }
  }

  newSession(): Promise<{ cancelled?: boolean }> {
    this.transcript = []
    // A new session means a new transcript file: ask the app for the id it just allocated.
    this.sessionId = this.options.sessionId?.() ?? this.sessionId
    this.persist()
    return Promise.resolve({ cancelled: false })
  }

  /**
   * Fork the conversation for `/btw`: a copy of the transcript under a new id.
   *
   * The side chat then talks to that copy, and closing it switches back to the original, so the
   * real session never sees the throwaway branch.
   */
  async clone(): Promise<string | undefined> {
    const store = this.options.transcripts
    if (!store) this.unimplemented('会话克隆')
    const original = this.sessionId
    const forkId = `s_${Math.random().toString(16).slice(2, 14)}`
    await store.save(forkId, this.roots, this.transcript)
    this.sessionId = forkId
    this.setStatus({ sessionFile: this.transcriptPath() })
    // The original id is only needed by the app, which remembers it before cloning.
    void original
    return this.transcriptPath()
  }

  async switchSession(sessionPath: string): Promise<void> {
    const store = this.options.transcripts
    if (!store) this.unimplemented('切换会话')
    const id = sessionPath.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '')
    if (!id) throw new Error(`无法识别的会话：${sessionPath}`)
    const stored = await store.load(id)
    this.sessionId = id
    this.transcript = stored?.messages ?? []
    this.setStatus({ sessionFile: this.transcriptPath() })
    for (const message of this.transcript) {
      this.options.onEvent({ type: 'message_end', message })
    }
  }

  abort(): Promise<void> {
    this.isBusy = false
    this.setStatus({ isStreaming: false })
    return Promise.resolve()
  }

  async send(message: string): Promise<void> {
    await this.prompt(message)
  }
  // --- the turn --------------------------------------------------------------------------------

  /** True when auto-compaction is on and the transcript is past the trigger point. */
  private shouldCompact(): boolean {
    const window = this.model?.contextWindow
    if (!this.autoCompact.enabled || !window || this.transcript.length === 0) return false
    return estimateTokens(this.transcript) >= (window * this.autoCompact.percent) / 100
  }

  /** First configured model, published to the status so the window shows it. */
  private async pickModel(): Promise<Model<string> | undefined> {
    const runtime = await providers.getRuntime()
    const choices = await providers.listModelChoices({ includeUnconfigured: false })
    const first = choices[0]
    if (!first) return undefined
    const model = runtime.getModel(first.provider, first.id) as Model<string> | undefined
    if (model) {
      this.model = model
      this.setStatus({ model: modelInfo(model) })
    }
    return model
  }

  /** Restore the stored conversation for this session, once per process. */
  private async resume(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    this.sessionId = this.options.sessionId?.()
    const store = this.options.transcripts
    if (!store || !this.sessionId) return
    const stored = await store.load(this.sessionId).catch(() => undefined)
    if (!stored) return
    this.transcript = stored.messages
    // The window draws the transcript from the engine, so it has to hear about the restored one.
    for (const message of this.transcript) {
      this.options.onEvent({ type: 'message_end', message })
    }
  }

  /** Where this session lives; the window and `/btw` treat it as the session file. */
  private transcriptPath(): string | undefined {
    const store = this.options.transcripts
    if (!store || !this.sessionId) return undefined
    return store.pathFor(this.sessionId)
  }

  private persist(): void {
    const store = this.options.transcripts
    if (!store || !this.sessionId) return
    void store.save(this.sessionId, this.roots, this.transcript).catch(() => undefined)
  }

  /** Tools are loaded once; the module is the same one pi's MCP server serves. */
  private async toolSet(): Promise<CoreTool[]> {
    if (this.tools) return this.tools
    const modulePath = this.options.toolModulePath
    if (!modulePath) return []
    // The module reads these from the environment: the same contract the MCP server gets.
    process.env.AGENT_DESKTOP_ROOTS = JSON.stringify([
      { name: basename(this.roots.primary), path: this.roots.primary, primary: true },
      ...this.roots.additional.map((root) => ({ name: basename(root), path: root }))
    ])
    const workspace = await loadWorkspaceTools(modulePath).catch(() => [])
    // Subagents are app-level (they spawn their own processes); the tools just call the bridge.
    const bridge = this.options.bridge?.()
    const subagentPath = this.options.subagentModulePath
    const context = bridge ? bridgeContext(bridge) : undefined
    const subagents =
      context && subagentPath ? await loadSubagentTools(subagentPath, context).catch(() => []) : []
    const askPath = this.options.askModulePath
    const ask = context && askPath ? await loadAskTool(askPath, context).catch(() => []) : []
    // MCP servers (codegraph / warpgrep / web) over the same bridge endpoints pi connects to.
    const endpoints = await this.options.mcpEndpoints?.(this.workspace()).catch(() => [])
    const mcp = endpoints && endpoints.length > 0 ? await loadMcpTools(endpoints).catch(() => []) : []
    this.tools = [...workspace, ...subagents, ...ask, ...mcp]
    return this.tools
  }

  private systemPrompt(): string {
    const roots = [
      `主目录：${this.roots.primary}`,
      ...this.roots.additional.map((root) => `附加目录：${root}`)
    ]
    return [
      '你是 Prophey 内置引擎的助手。',
      '工具都带 `root` 参数（目录名），路径相对该目录；越界会被拒绝。用 workspace_roots 查目录名。',
      '改文件前先读，改完再读回确认；命令用 run_bash 并指明目录。',
      ...roots
    ].join('\n')
  }

  async prompt(
    message: string,
    options: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] } = {}
  ): Promise<PromptResult> {
    if (this.snapshot.phase !== 'ready') return { ok: false, error: '引擎未就绪' }
    if (this.isBusy) return { ok: false, error: '上一轮还没结束' }
    const runtime = await providers.getRuntime()
    let model = this.model
    if (!model) {
      // No model chosen yet: take the first one whose provider actually has credentials, so the
      // engine does not fail on an unconfigured provider's catalogue entry.
      const choices = await providers.listModelChoices({ includeUnconfigured: false })
      const first = choices[0]
      if (!first) return { ok: false, error: '没有已配置的服务商，请先在设置里登录' }
      model = runtime.getModel(first.provider, first.id) as Model<string> | undefined
      if (model) {
        this.model = model
        // The window reads the model from the status; without this it shows "无可用模型".
        this.setStatus({ model: modelInfo(model) })
      }
    }
    if (!model) return { ok: false, error: '没有可用的模型' }
    const tools = await this.toolSet()
    // Auto-compaction happens before the turn, never in the middle of one: a summary request in the
    // middle of a tool loop would throw away the results the model is about to use.
    if (this.shouldCompact()) {
      await this.compact().catch(() => undefined)
    }

    const user: Record<string, unknown> = {
      role: 'user',
      content: options.images?.length
        ? [
            { type: 'text', text: message },
            ...options.images.map((image) => ({
              type: 'image',
              mimeType: image.mimeType,
              data: image.data
            }))
          ]
        : message,
      timestamp: Date.now()
    }
    this.transcript.push(user)
    this.persist()
    this.isBusy = true
    this.setStatus({ isStreaming: true })
    this.options.onEvent({ type: 'agent_start' })
    this.options.onEvent({ type: 'message_start', message: user })

    try {
      // One round = one model response. A round that asks for tools is followed by another round,
      // which is the whole loop: think, call, read the result, continue.
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const answer = await this.streamRoundWithRetry(runtime, model, tools)
        if (!answer.ok) {
          this.finishWithError(answer.error)
          return { ok: false, error: answer.error }
        }
        const calls = toolCallsOf(answer.message)
        if (calls.length === 0) break
        for (const call of calls) {
          this.transcript.push(await this.runTool(call, tools))
          this.persist()
        }
      }
      this.isBusy = false
      this.setStatus({ isStreaming: false })
      this.options.onEvent({ type: 'agent_end' })
      this.options.onEvent({ type: 'agent_settled' })
      this.options.onSettled()
      return { ok: true, disposition: 'started' }
    } catch (error) {
      const text = describeError(error)
      this.finishWithError(text)
      return { ok: false, error: text }
    }
  }

  /**
   * One model call with a small retry budget.
   *
   * Provider streams fail for transient reasons (connection reset, 429, 5xx). pi retries these too;
   * a turn that dies on the first blip is worse than one that waits two seconds.
   */
  private async streamRoundWithRetry(
    runtime: Awaited<ReturnType<typeof providers.getRuntime>>,
    model: Model<string>,
    tools: CoreTool[]
  ): Promise<{ ok: true; message: Record<string, unknown> } | { ok: false; error: string }> {
    let lastError = ''
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      const result = await this.streamRound(runtime, model, tools)
      if (result.ok) return result
      lastError = result.error
      if (!isRetryable(lastError)) return result
      this.options.onEvent({
        type: 'auto_retry_start',
        attempt: attempt + 1,
        delayMs: RETRY_DELAYS_MS[attempt],
        error: lastError
      })
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
      this.options.onEvent({ type: 'auto_retry_end', success: false })
    }
    return { ok: false, error: lastError }
  }

  /** One model call; appends the assistant message and streams its deltas to the window. */
  private async streamRound(
    runtime: Awaited<ReturnType<typeof providers.getRuntime>>,
    model: Model<string>,
    tools: CoreTool[]
  ): Promise<{ ok: true; message: Record<string, unknown> } | { ok: false; error: string }> {
    const tier = speed.resolveSpeedMode(modelInfo(model), this.options.speedMode?.() ?? 'standard')
    // Fast tiers are a request-level knob with two different shapes: OpenAI takes `service_tier` in
    // the body, Anthropic takes `speed` plus a beta header. `onPayload`/`transformHeaders` are the
    // SDK's hooks for exactly this, so no global fetch patching is needed.
    const fastOptions =
      tier === 'standard'
        ? {}
        : {
            onPayload: (payload: unknown) => {
              if (!payload || typeof payload !== 'object') return undefined
              const body = payload as Record<string, unknown>
              return model.api === 'anthropic-messages'
                ? { ...body, speed: 'fast' }
                : { ...body, service_tier: tier }
            },
            ...(model.api === 'anthropic-messages'
              ? {
                  transformHeaders: (headers: Record<string, string>) => ({
                    ...headers,
                    'anthropic-beta': mergeBeta(headers['anthropic-beta'], 'fast-mode-2026-02-01')
                  })
                }
              : {})
          }
    const stream = runtime.streamSimple(
      model,
      {
        systemPrompt: this.systemPrompt(),
        messages: this.transcript as never,
        tools: toolDeclarations(tools)
      },
      fastOptions
    )
    let partial: Record<string, unknown> | undefined
    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      if (
        event.type === 'text_delta' ||
        event.type === 'thinking_delta' ||
        event.type === 'text_end' ||
        event.type === 'thinking_end'
      ) {
        partial = event.partial as Record<string, unknown>
        this.options.onEvent({ type: 'message_update', message: partial })
      }
      if (event.type === 'error') {
        return { ok: false, error: describeError(event.error) }
      }
      if (event.type === 'done' && event.message) {
        partial = event.message as Record<string, unknown>
      }
    }
    const message = (partial ?? { role: 'assistant', content: [] }) as Record<string, unknown>
    this.transcript.push(message)
    this.options.onEvent({ type: 'message_end', message })
    this.persist()
    return { ok: true, message }
  }

  /** Execute one tool call and report it the way the window expects tool cards to arrive. */
  private async runTool(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    tools: CoreTool[]
  ): Promise<Record<string, unknown>> {
    const tool = tools.find((entry) => entry.name === call.name)
    const started = Date.now()
    this.options.onEvent({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments
    })
    let result: { content: Array<{ type: string; text?: string }>; isError?: boolean }
    if (!tool) {
      result = { content: [{ type: 'text', text: `未知工具：${call.name}` }], isError: true }
    } else {
      try {
        result = await tool.call(call.arguments ?? {})
      } catch (error) {
        result = { content: [{ type: 'text', text: describeError(error) }], isError: true }
      }
    }
    this.options.onEvent({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      result: { content: result.content, isError: Boolean(result.isError) },
      durationMs: Date.now() - started
    })
    return {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      isError: Boolean(result.isError),
      timestamp: Date.now()
    }
  }

  private finishWithError(text: string): void {
    this.isBusy = false
    this.setStatus({ isStreaming: false })
    this.options.onEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'error' }
    })
    this.options.onEvent({ type: 'agent_end' })
    this.options.onEvent({ type: 'agent_settled' })
    this.options.onSettled()
  }
}

/** Rough token count of the transcript; good enough for a meter and a compaction trigger. */
function estimateTokens(messages: Array<Record<string, unknown>>): number {
  let characters = 0
  for (const message of messages) {
    characters += JSON.stringify(message).length
  }
  return Math.ceil(characters / 4)
}

/** Concatenated text blocks of a message. */
function textOf(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .map((block) =>
      block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : ''
    )
    .join('')
}

/** Rounds per turn: a tool-using answer rarely needs more, and it bounds a runaway loop. */
const MAX_ROUNDS = 16

/** Backoff before each retry; length is the retry budget. */
const RETRY_DELAYS_MS = [1500, 4000, 9000]

/** Only transient failures are worth another attempt: a bad key or a bad request never recovers. */
function isRetryable(message: string): boolean {
  return /rate.?limit|429|overloaded|timeout|timed out|ECONNRESET|socket hang up|network|fetch failed|502|503|504|stream (ended|closed)|premature close/i.test(
    message
  )
}

/** Merge a beta flag into an existing `anthropic-beta` header value without duplicating it. */
function mergeBeta(existing: string | undefined, flag: string): string {
  const flags = (existing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (!flags.includes(flag)) flags.push(flag)
  return flags.join(',')
}

/** The status shape the window expects for the current model. */
function modelInfo(model: Model<string>): PiModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    api: model.api
  }
}

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') return JSON.stringify(error).slice(0, 400)
  return String(error)
}

/** Tool calls the model asked for in one assistant message. */
function toolCallsOf(message: Record<string, unknown>): Array<{
  id: string
  name: string
  arguments: Record<string, unknown>
}> {
  const content = Array.isArray(message.content) ? message.content : []
  const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const entry = block as { type?: string; id?: unknown; name?: unknown; arguments?: unknown }
    if (entry.type !== 'toolCall' || typeof entry.name !== 'string') continue
    calls.push({
      id: typeof entry.id === 'string' ? entry.id : `call_${calls.length}`,
      name: entry.name,
      arguments:
        entry.arguments && typeof entry.arguments === 'object'
          ? (entry.arguments as Record<string, unknown>)
          : {}
    })
  }
  return calls
}


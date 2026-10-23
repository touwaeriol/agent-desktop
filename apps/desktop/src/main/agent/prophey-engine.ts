import type { Model } from '@earendil-works/pi-ai'
import type { PiModel, PiStatus, PromptImage, PromptResult } from '@shared/types'
import * as providers from '../providers'
import { loadWorkspaceTools, toolDeclarations, type CoreTool } from './core-tools'
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

  constructor(
    private readonly options: {
      onStatus(next: PiStatus): void
      onEvent(record: Record<string, unknown>): void
      onSettled(): void
      /** Absolute path of `tools/workspace.mjs`; the tools are shared with pi's MCP server. */
      toolModulePath?: string
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

  stats(): Promise<{ tokens?: { input?: number; output?: number; total?: number } }> {
    this.unimplemented('用量统计')
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

  compact(): Promise<{ summary?: string }> {
    this.unimplemented('上下文压缩')
  }

  setAutoCompaction(): Promise<void> {
    this.unimplemented('自动压缩')
  }

  newSession(): Promise<{ cancelled?: boolean }> {
    this.transcript = []
    return Promise.resolve({ cancelled: false })
  }

  switchSession(): Promise<void> {
    this.unimplemented('切换会话')
  }

  clone(): Promise<string | undefined> {
    this.unimplemented('会话克隆')
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
    this.tools = await loadWorkspaceTools(modulePath).catch(() => [])
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
    this.isBusy = true
    this.setStatus({ isStreaming: true })
    this.options.onEvent({ type: 'agent_start' })
    this.options.onEvent({ type: 'message_start', message: user })

    try {
      // One round = one model response. A round that asks for tools is followed by another round,
      // which is the whole loop: think, call, read the result, continue.
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const answer = await this.streamRound(runtime, model, tools)
        if (!answer.ok) {
          this.finishWithError(answer.error)
          return { ok: false, error: answer.error }
        }
        const calls = toolCallsOf(answer.message)
        if (calls.length === 0) break
        for (const call of calls) this.transcript.push(await this.runTool(call, tools))
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

  /** One model call; appends the assistant message and streams its deltas to the window. */
  private async streamRound(
    runtime: Awaited<ReturnType<typeof providers.getRuntime>>,
    model: Model<string>,
    tools: CoreTool[]
  ): Promise<{ ok: true; message: Record<string, unknown> } | { ok: false; error: string }> {
    const stream = runtime.streamSimple(
      model,
      {
        systemPrompt: this.systemPrompt(),
        messages: this.transcript as never,
        tools: toolDeclarations(tools)
      },
      {}
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

/** Rounds per turn: a tool-using answer rarely needs more, and it bounds a runaway loop. */
const MAX_ROUNDS = 16

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
  const parts = dir.split(/[\/]/).filter(Boolean)
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


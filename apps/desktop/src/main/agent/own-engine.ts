import type { Model } from '@earendil-works/pi-ai'
import type { PiModel, PiStatus, PromptImage, PromptResult } from '@shared/types'
import * as providers from '../providers'
import type { AgentEngine, AgentWorkspace } from './engine'

/**
 * Our own engine — v1, text only.
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
export class OwnEngine implements AgentEngine {
  readonly id = 'own'

  private snapshot: PiStatus = { phase: 'stopped', cwd: process.cwd() }
  private roots: AgentWorkspace = { primary: process.cwd(), additional: [] }
  private isBusy = false
  private model: Model<string> | undefined
  private transcript: Array<Record<string, unknown>> = []

  constructor(
    private readonly options: {
      onStatus(next: PiStatus): void
      onEvent(record: Record<string, unknown>): void
      onSettled(): void
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
    throw new Error(`own 引擎 v1 还不支持${what}（请切回 pi 引擎）`)
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
    const info: PiModel = {
      provider,
      id: modelId,
      name: model.name,
      contextWindow: model.contextWindow,
      api: model.api
    }
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
      if (model) this.model = model
    }
    if (!model) return { ok: false, error: '没有可用的模型' }

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
      const stream = runtime.streamSimple(
        model,
        {
          systemPrompt: [
            '你是 Agent Desktop 内置引擎（v1，文本模式）的助手。',
            '当前还没有接入工具，只能对话；需要读写文件、执行命令时请说明你需要切回 pi 引擎。',
            `工作目录：${this.roots.primary}`,
            ...this.roots.additional.map((root) => `附加目录：${root}`)
          ].join('\n'),
          messages: this.transcript as never
        },
        {}
      )
      let partial: Record<string, unknown> | undefined
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          partial = event.partial as Record<string, unknown>
          this.options.onEvent({ type: 'message_update', message: partial })
        }
        if (event.type === 'error') {
          const error = String((event as { error?: unknown }).error ?? '模型调用失败')
          this.finishWithError(error)
          return { ok: false, error }
        }
      }
      const finalMessage = (partial ?? { role: 'assistant', content: [] }) as Record<string, unknown>
      this.transcript.push(finalMessage)
      this.options.onEvent({ type: 'message_end', message: finalMessage })
      this.isBusy = false
      this.setStatus({ isStreaming: false })
      this.options.onEvent({ type: 'agent_end' })
      this.options.onEvent({ type: 'agent_settled' })
      this.options.onSettled()
      return { ok: true, disposition: 'started' }
    } catch (error) {
      // Provider failures are not always Error instances; keep the useful part either way.
      const text =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null
            ? JSON.stringify(error).slice(0, 400)
            : String(error)
      this.finishWithError(text)
      return { ok: false, error: text }
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

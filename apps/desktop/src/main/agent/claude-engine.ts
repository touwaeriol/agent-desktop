import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PiModel, PiStatus, PromptImage, PromptResult } from '@shared/types'
import type { AgentEngine, AgentWorkspace, EngineCapabilities } from './engine'

/**
 * Claude Code as an engine.
 *
 * `claude -p --output-format stream-json` runs the whole agent loop itself — its own tools, its own
 * session, its own subscription auth — and streams JSONL we translate into the same events the
 * window already understands. We are the host, not the loop: nothing here re-implements a turn.
 *
 * Deliberately v1: text, tool activity, multi-directory through `--add-dir`, and session resume.
 * Compaction, `/btw` and `ask_user_question` are the CLI's business and are reported as unsupported
 * rather than faked.
 */
interface ClaudeOptions {
  onStatus(next: PiStatus): void
  onEvent(record: Record<string, unknown>): void
  onSettled(): void
  /** Absolute path of the `claude` executable (the packaged .exe, not the .cmd shim). */
  binary: string
}

interface TurnResult {
  sessionId?: string
  cost?: number
  usage?: { input?: number; output?: number; total?: number }
}

export class ClaudeCodeEngine implements AgentEngine {
  readonly id = 'claude'

  private snapshot: PiStatus = { phase: 'stopped', cwd: process.cwd() }
  private roots: AgentWorkspace = { primary: process.cwd(), additional: [] }
  private isBusy = false
  private child: ChildProcessWithoutNullStreams | undefined
  private sessionId: string | undefined
  private model: string | undefined
  private transcript: Array<Record<string, unknown>> = []
  private last: TurnResult = {}

  constructor(private readonly options: ClaudeOptions) {}

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

  capabilities(): EngineCapabilities {
    return { compact: false, fork: false, thinking: false, models: false }
  }

  workspace(): AgentWorkspace {
    return { primary: this.roots.primary, additional: [...this.roots.additional] }
  }

  starting(): boolean {
    return false
  }

  poll(): void {
    // Each turn is its own process; there is no run state to poll.
  }

  setStatus(patch: Partial<PiStatus>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.options.onStatus(this.snapshot)
  }

  async start(workspace?: string | AgentWorkspace): Promise<PiStatus> {
    const wanted =
      typeof workspace === 'string'
        ? { primary: workspace, additional: [] }
        : workspace ?? this.roots
    this.roots = { primary: wanted.primary, additional: [...wanted.additional] }
    this.setStatus({
      phase: 'ready',
      cwd: wanted.primary,
      isStreaming: false,
      model: { provider: 'claude-code', id: this.model ?? 'default', name: 'Claude Code' }
    })
    return this.snapshot
  }

  stop(): void {
    this.child?.kill()
    this.child = undefined
    this.isBusy = false
    this.setStatus({ phase: 'stopped', isStreaming: false })
  }

  dispose(): void {
    this.stop()
  }

  async refresh(): Promise<void> {
    // The CLI reports everything through the stream.
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

  // --- what the CLI owns, and we therefore do not pretend to do ----------------------------------

  private unsupported(what: string): never {
    throw new Error(`Claude Code 引擎不支持${what}（这是 CLI 自己的功能）`)
  }

  async models(): Promise<Record<string, unknown>[]> {
    return []
  }

  async setModel(_provider: string, modelId: string): Promise<PiModel | undefined> {
    // `--model` is passed on the next turn; the CLI decides what it accepts.
    this.model = modelId
    const info: PiModel = { provider: 'claude-code', id: modelId, name: modelId }
    this.setStatus({ model: info })
    return info
  }

  thinkingLevels(): Promise<string[]> {
    return Promise.resolve([])
  }

  setThinkingLevel(): Promise<void> {
    return Promise.resolve()
  }

  async stats(): Promise<{
    tokens?: { input?: number; output?: number; total?: number }
    cost?: number
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }
  }> {
    return { tokens: this.last.usage, cost: this.last.cost }
  }

  async messages(): Promise<unknown[]> {
    return [...this.transcript]
  }

  async lastAssistantText(): Promise<string | null> {
    const last = [...this.transcript].reverse().find((entry) => entry.role === 'assistant')
    const content = Array.isArray(last?.content) ? (last?.content as Array<{ text?: string }>) : []
    return content.map((block) => block.text ?? '').join('') || null
  }

  compact(): Promise<{ summary?: string }> {
    this.unsupported('上下文压缩（用 CLI 自己的 /compact）')
  }

  setAutoCompaction(): Promise<void> {
    return Promise.resolve()
  }

  async newSession(): Promise<{ cancelled?: boolean }> {
    this.sessionId = undefined
    this.transcript = []
    this.setStatus({ sessionFile: undefined, sessionName: undefined })
    return { cancelled: false }
  }

  switchSession(): Promise<void> {
    this.unsupported('切换会话（会话 id 由 CLI 管理）')
  }

  clone(): Promise<string | undefined> {
    this.unsupported('会话分叉（/btw）')
  }

  abort(): Promise<void> {
    this.child?.kill()
    this.child = undefined
    this.isBusy = false
    this.setStatus({ isStreaming: false })
    return Promise.resolve()
  }

  async send(message: string): Promise<void> {
    await this.prompt(message)
  }

  // --- one turn = one `claude -p` process --------------------------------------------------------

  async prompt(
    message: string,
    options: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] } = {}
  ): Promise<PromptResult> {
    if (this.snapshot.phase !== 'ready') return { ok: false, error: '引擎未就绪' }
    if (this.isBusy) return { ok: false, error: '上一轮还没结束' }

    const args = ['-p', '--output-format', 'stream-json', '--verbose']
    for (const root of this.roots.additional) args.push('--add-dir', root)
    if (this.model) args.push('--model', this.model)
    if (this.sessionId) args.push('--resume', this.sessionId)


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

    const failure = await this.run(args, this.stdinText(message))
    this.isBusy = false
    this.setStatus({ isStreaming: false })
    if (failure) {
      this.options.onEvent({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: failure }], stopReason: 'error' }
      })
      this.options.onEvent({ type: 'agent_end' })
      this.options.onEvent({ type: 'agent_settled' })
      this.options.onSettled()
      return { ok: false, error: failure }
    }
    this.options.onEvent({ type: 'agent_end' })
    this.options.onEvent({ type: 'agent_settled' })
    this.options.onSettled()
    return { ok: true, disposition: 'started' }
  }

  /** Spawn one turn, translate its JSONL, and resolve with an error message when it failed. */
  private run(args: string[], input: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      // The prompt travels on stdin: a shell-free spawn cannot carry arbitrary text in argv, and
      // stdin keeps quoting out of the picture entirely.
      const child = spawn(this.options.binary, args, {
        cwd: this.roots.primary,
        env: process.env,
        windowsHide: true
      })
      child.stdin.end(input)
      this.child = child
      let buffer = ''
      let stderr = ''
      let failed: string | undefined

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line) failed = this.handle(line) ?? failed
          index = buffer.indexOf('\n')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-4000)
      })
      child.on('error', (error) => {
        failed = `无法启动 Claude Code：${error.message}`
      })
      child.on('close', (code) => {
        this.child = undefined
        if (code !== 0 && !failed) {
          failed = `Claude Code 退出码 ${code}${stderr.trim() ? `：${stderr.trim().slice(-300)}` : ''}`
        }
        resolve(failed)
      })
    })
  }

  /** One JSONL line; returns an error message when the line reports a failure. */
  private handle(line: string): string | undefined {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return undefined
    }
    const type = String(event.type ?? '')

    if (type === 'system' && event.subtype === 'init') {
      if (typeof event.session_id === 'string') {
        this.sessionId = event.session_id
        // A session id is not a file; the window uses it to label the session.
        this.setStatus({ sessionFile: `claude:${event.session_id}`, sessionName: undefined })
      }
      const model = typeof event.model === 'string' ? event.model : undefined
      if (model) {
        this.model = model.replace(/\[.*\]$/, '')
        this.setStatus({ model: { provider: 'claude-code', id: this.model, name: this.model } })
      }
      return undefined
    }

    if (type === 'assistant') {
      const message = (event.message ?? {}) as {
        content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      const blocks = Array.isArray(message.content) ? message.content : []
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
      if (text) {
        const assistant: Record<string, unknown> = {
          role: 'assistant',
          content: [{ type: 'text', text }],
          timestamp: Date.now()
        }
        this.transcript.push(assistant)
        this.options.onEvent({ type: 'message_end', message: assistant })
      }
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          this.options.onEvent({
            type: 'tool_execution_start',
            toolCallId: `claude_${block.name}_${Date.now()}`,
            toolName: block.name,
            args: block.input
          })
        }
      }
      if (message.usage) {
        this.last = {
          ...this.last,
          usage: {
            input: message.usage.input_tokens,
            output: message.usage.output_tokens,
            total: (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0)
          }
        }
      }
      return undefined
    }

    if (type === 'user') {
      // Tool results arrive as user messages with `tool_result` blocks.
      const message = (event.message ?? {}) as {
        content?: Array<{ type?: string; tool_use_id?: string; content?: unknown }>
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type !== 'tool_result') continue
        this.options.onEvent({
          type: 'tool_execution_end',
          toolCallId: block.tool_use_id,
          toolName: 'tool',
          result: { content: [{ type: 'text', text: stringify(block.content) }] }
        })
      }
      return undefined
    }

    if (type === 'result') {
      if (typeof event.total_cost_usd === 'number') this.last.cost = event.total_cost_usd
      if (typeof event.session_id === 'string') this.sessionId = event.session_id
      const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined
      if (usage) {
        this.last.usage = {
          input: usage.input_tokens,
          output: usage.output_tokens,
          total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        }
      }
      if (event.is_error || event.subtype !== 'success') {
        return typeof event.result === 'string' && event.result
          ? event.result
          : `Claude Code 结束：${String(event.subtype ?? 'unknown')}`
      }
      return undefined
    }

    return undefined
  }

  /**
   * What goes on stdin: the message, preceded by the workspace block when there is more than one
   * directory (the CLI has no `--add-dir` equivalent for *describing* the extra roots).
   */
  private stdinText(message: string): string {
    const context = this.workspaceNote()
    return context ? `${context}

${message}` : message
  }

  /** The workspace block prepended to a multi-directory turn. */
  private workspaceNote(): string {
    const lines = [`工作目录：${this.roots.primary}`]
    if (this.roots.additional.length > 0) {
      lines.push(`这个会话还覆盖：${this.roots.additional.join('、')}`)
      lines.push('跨目录用绝对路径；每条 bash 都是新 shell，cd 不保留。')
    }
    return lines.join('\n')
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text: unknown }).text)
          : JSON.stringify(block)
      )
      .join('\n')
  }
  return JSON.stringify(value ?? '')
}

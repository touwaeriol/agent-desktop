import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PiModel, PiStatus, PromptImage, PromptResult } from '@shared/types'
import type { AgentEngine, AgentWorkspace, EngineCapabilities } from './engine'

/**
 * Codex CLI as an engine.
 *
 * `codex exec --json` runs the loop itself (its own tools, its own sandbox, its own login) and
 * emits coarse events: `thread.started`, `item.completed`, `turn.completed`. There are no token
 * deltas, so a message appears when its item completes rather than growing — honest behaviour for a
 * CLI that does not stream text, instead of faking a typewriter.
 */
interface CodexOptions {
  onStatus(next: PiStatus): void
  onEvent(record: Record<string, unknown>): void
  onSettled(): void
  binary: string
  /** Node executable plus script, for the Windows shim that is a .js entry. */
  script?: string
}

export class CodexEngine implements AgentEngine {
  readonly id = 'codex'

  private snapshot: PiStatus = { phase: 'stopped', cwd: process.cwd() }
  private roots: AgentWorkspace = { primary: process.cwd(), additional: [] }
  private isBusy = false
  private child: ChildProcessWithoutNullStreams | undefined
  private threadId: string | undefined
  private model: string | undefined
  private transcript: Array<Record<string, unknown>> = []
  private usage: { input?: number; output?: number; total?: number } = {}

  constructor(private readonly options: CodexOptions) {}

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
    // One process per turn; nothing to poll.
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
      model: { provider: 'codex', id: this.model ?? 'default', name: 'Codex' }
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
    // Everything arrives in the event stream.
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

  private unsupported(what: string): never {
    throw new Error(`Codex 引擎不支持${what}（这是 CLI 自己的功能）`)
  }

  async models(): Promise<Record<string, unknown>[]> {
    return []
  }

  async setModel(_provider: string, modelId: string): Promise<PiModel | undefined> {
    this.model = modelId
    const info: PiModel = { provider: 'codex', id: modelId, name: modelId }
    this.setStatus({ model: info })
    return info
  }

  thinkingLevels(): Promise<string[]> {
    return Promise.resolve([])
  }

  setThinkingLevel(): Promise<void> {
    return Promise.resolve()
  }

  async stats(): Promise<{ tokens?: { input?: number; output?: number; total?: number } }> {
    return { tokens: this.usage }
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
    this.unsupported('上下文压缩')
  }

  setAutoCompaction(): Promise<void> {
    return Promise.resolve()
  }

  async newSession(): Promise<{ cancelled?: boolean }> {
    this.threadId = undefined
    this.transcript = []
    this.setStatus({ sessionFile: undefined, sessionName: undefined })
    return { cancelled: false }
  }

  switchSession(): Promise<void> {
    this.unsupported('切换会话')
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

  async prompt(
    message: string,
    options: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] } = {}
  ): Promise<PromptResult> {
    if (this.snapshot.phase !== 'ready') return { ok: false, error: '引擎未就绪' }
    if (this.isBusy) return { ok: false, error: '上一轮还没结束' }

    // `codex exec resume <id>` continues the thread; a fresh thread starts with `exec`.
    // The prompt travels on stdin so argv never has to carry it.
    const args = this.threadId
      ? ['exec', 'resume', this.threadId, '--json', '--skip-git-repo-check', '-']
      : ['exec', '--json', '--skip-git-repo-check', '-C', this.roots.primary, '-']
    if (this.model) args.push('-m', this.model)

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

    const failure = await this.run(args, message)
    this.isBusy = false
    this.setStatus({ isStreaming: false })
    if (failure) {
      this.options.onEvent({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: failure }], stopReason: 'error' }
      })
    }
    this.options.onEvent({ type: 'agent_end' })
    this.options.onEvent({ type: 'agent_settled' })
    this.options.onSettled()
    return failure ? { ok: false, error: failure } : { ok: true, disposition: 'started' }
  }

  private run(args: string[], input: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      // Codex's Windows entry is a .js script; run it with our node so no .cmd shim is involved.
      const command = this.options.script ? process.execPath : this.options.binary
      const commandArgs = this.options.script ? [this.options.script, ...args] : args
      const child = spawn(command, commandArgs, {
        cwd: this.roots.primary,
        env: this.options.script ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
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
        failed = `无法启动 Codex：${error.message}`
      })
      child.on('close', (code) => {
        this.child = undefined
        if (code !== 0 && !failed) {
          failed = `Codex 退出码 ${code}${stderr.trim() ? `：${stderr.trim().slice(-300)}` : ''}`
        }
        resolve(failed)
      })
    })
  }

  private handle(line: string): string | undefined {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return undefined
    }
    const type = String(event.type ?? '')

    if (type === 'thread.started' && typeof event.thread_id === 'string') {
      this.threadId = event.thread_id
      this.setStatus({ sessionFile: `codex:${event.thread_id}` })
      return undefined
    }

    if (type === 'item.completed') {
      const item = (event.item ?? {}) as { type?: string; text?: string; message?: string; name?: string }
      if (item.type === 'agent_message' && item.text) {
        const assistant: Record<string, unknown> = {
          role: 'assistant',
          content: [{ type: 'text', text: item.text }],
          timestamp: Date.now()
        }
        this.transcript.push(assistant)
        this.options.onEvent({ type: 'message_end', message: assistant })
        return undefined
      }
      // Config warnings and transport fallbacks arrive as error items; only a real failure matters.
      if (item.type === 'error' && item.message && /error|failed|denied/i.test(item.message)) {
        return item.message
      }
      return undefined
    }

    if (type === 'turn.completed') {
      const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined
      if (usage) {
        this.usage = {
          input: usage.input_tokens,
          output: usage.output_tokens,
          total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        }
      }
      return undefined
    }

    return undefined
  }
}

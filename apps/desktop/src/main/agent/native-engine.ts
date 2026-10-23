import type {
  PiStatus,
  PiModel,
  PromptImage,
  PromptResult,
  SessionStats,
  AskQuestion,
  AskResult
} from '../../shared/types'
import { engineCapabilities, type EngineId, type EngineCommand } from '../../shared/engine'
import type { AgentEngine, AgentWorkspace, EngineStartOptions } from './engine'
export interface NativeOptions {
  ask?(questions: AskQuestion[], tool: string): Promise<AskResult>
  onStatus(next: PiStatus): void
  onEvent(record: Record<string, unknown>): void
  onSettled(): void
}
/** Shared lifecycle only; each adapter owns its protocol, commands and session format. */
export abstract class NativeEngine implements AgentEngine {
  abstract readonly id: EngineId
  protected snapshot: PiStatus = { phase: 'stopped', cwd: process.cwd() }
  protected roots: AgentWorkspace = { primary: process.cwd(), additional: [] }
  protected transcript: Array<Record<string, unknown>> = []
  protected usage: SessionStats = {}
  protected active = false
  protected completion?: { resolve(): void; reject(error: Error): void }
  protected lastError?: string
  protected stderr = ''
  constructor(protected readonly callbacks: NativeOptions) {}
  protected ask(questions: AskQuestion[], tool: string): Promise<AskResult> {
    return (
      this.callbacks.ask?.(questions, tool) ??
      Promise.resolve({ cancelled: true, reason: '没有交互界面' })
    )
  }
  protected async requestApproval(question: string, tool: string): Promise<boolean> {
    const answer = await this.ask(
      [{ question, options: [{ label: '拒绝' }, { label: '允许本次' }] }],
      tool
    )
    return !answer.cancelled && !!answer.answers[0]?.selected.includes('允许本次')
  }
  state(): PiStatus {
    return this.snapshot
  }
  busy(): boolean {
    return this.active || !!this.snapshot.compacting
  }
  compacting(): boolean {
    return !!this.snapshot.compacting
  }
  running(): boolean {
    return this.snapshot.phase === 'ready'
  }
  starting(): boolean {
    return this.snapshot.phase === 'starting'
  }
  stderrTail(): string {
    return this.stderr
  }
  capabilities() {
    return engineCapabilities(this.id)
  }
  workspace(): AgentWorkspace {
    return { primary: this.roots.primary, additional: [...this.roots.additional] }
  }
  setStatus(patch: Partial<PiStatus>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.callbacks.onStatus(this.snapshot)
  }
  poll(): void {}
  async refresh(): Promise<void> {}
  async stats(): Promise<SessionStats> {
    return this.usage
  }
  async messages(): Promise<unknown[]> {
    return [...this.transcript]
  }
  async lastAssistantText(): Promise<string | null> {
    const last = [...this.transcript].reverse().find((m) => m.role === 'assistant')
    return last ? textContent(last.content) : null
  }
  async waitForSettle(timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (this.busy() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    return !this.busy()
  }
  waitForIdle(timeoutMs: number): Promise<boolean> {
    return this.waitForSettle(timeoutMs)
  }
  protected begin(compacting = false): Promise<void> {
    if (this.busy()) throw new Error('当前引擎仍在运行')
    this.lastError = undefined
    this.active = true
    this.setStatus({ isStreaming: true, compacting })
    this.callbacks.onEvent({ type: 'agent_start' })
    if (compacting) this.callbacks.onEvent({ type: 'compaction_start', reason: 'manual' })
    return new Promise<void>((resolve, reject) => {
      this.completion = { resolve, reject }
    })
  }
  protected finish(error?: string): void {
    const pending = this.completion
    const wasActive = this.active
    this.completion = undefined
    this.active = false
    this.lastError = error
    const compacting = this.compacting()
    this.setStatus({ isStreaming: false, compacting: false })
    if (compacting) this.callbacks.onEvent({ type: 'compaction_end' })
    if (wasActive) {
      this.callbacks.onEvent({ type: 'agent_end' })
      this.callbacks.onEvent({ type: 'agent_settled' })
      this.callbacks.onSettled()
    }
    if (error) pending?.reject(new Error(error))
    else pending?.resolve()
  }
  protected emitMessage(message: Record<string, unknown>): void {
    this.transcript.push(message)
    this.callbacks.onEvent({ type: 'message_end', message })
  }
  protected configureWorkspace(workspace?: string | AgentWorkspace): void {
    if (workspace)
      this.roots =
        typeof workspace === 'string'
          ? { primary: workspace, additional: [] }
          : { primary: workspace.primary, additional: [...workspace.additional] }
  }
  async send(message: string): Promise<void> {
    const result = await this.prompt(message)
    if (!result.ok) throw new Error(result.error ?? '发送失败')
    if (!(await this.waitForSettle(600_000))) throw new Error('等待引擎完成超时')
    if (this.lastError) throw new Error(this.lastError)
  }
  async setAutoCompaction(): Promise<void> {
    throw new Error('自动压缩由当前引擎原生管理，桌面不覆盖其配置')
  }
  abstract start(
    workspace?: string | AgentWorkspace,
    options?: EngineStartOptions
  ): Promise<PiStatus>
  abstract stop(): void
  dispose(): void {
    this.stop()
  }
  abstract prompt(
    message: string,
    options?: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] }
  ): Promise<PromptResult>
  abstract models(): Promise<Record<string, unknown>[]>
  abstract setModel(provider: string, model: string): Promise<PiModel | undefined>
  abstract thinkingLevels(): Promise<string[]>
  abstract setThinkingLevel(level: string): Promise<void>
  abstract compact(instructions?: string): Promise<{ summary?: string }>
  abstract newSession(): Promise<{ cancelled?: boolean }>
  abstract switchSession(path: string): Promise<void>
  abstract clone(): Promise<string | undefined>
  abstract abort(): Promise<void>
  async nativeCommands(): Promise<EngineCommand[]> {
    return []
  }
}
export function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => b?.text ?? b?.thinking ?? '').join('')
  return ''
}

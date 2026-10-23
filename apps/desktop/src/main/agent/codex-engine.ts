import type { EngineStartOptions } from './engine'
import type { PiStatus, PiModel, PromptImage, PromptResult } from '../../shared/types'
import type { EngineCommand } from '../../shared/engine'
import type { AgentWorkspace } from './engine'
import { NativeEngine, type NativeOptions } from './native-engine'
import { JsonRpcProcess } from './json-rpc-process'
interface CodexOptions extends NativeOptions {
  binary: string
  script?: string
  sandbox?: () => 'read-only' | 'workspace-write' | undefined
}
/** Codex app-server owns models, tools, history, compaction and the approval policy. */
export class CodexEngine extends NativeEngine {
  readonly id = 'codex' as const
  private rpc: JsonRpcProcess
  private connected = false
  private threadId?: string
  private turnId?: string
  private catalog: any[] = []
  private skills: any[] = []
  private launching?: Promise<PiStatus>
  constructor(private readonly options: CodexOptions) {
    super(options)
    this.rpc = new JsonRpcProcess(
      (method, p) => this.handle(method, p),
      (method, p) => this.approval(method, p),
      (error) => {
        this.connected = false
        this.finish(error)
        this.setStatus({ phase: 'error', error })
      }
    )
  }
  async start(
    workspace?: string | AgentWorkspace,
    options: EngineStartOptions = {}
  ): Promise<PiStatus> {
    if (this.launching) return this.launching
    const nextPrimary = typeof workspace === 'string' ? workspace : workspace?.primary
    if (nextPrimary && nextPrimary !== this.roots.primary && !options.session) {
      this.threadId = undefined
      this.transcript = []
      this.usage = {}
      this.setStatus({
        sessionFile: undefined,
        sessionName: undefined,
        model: undefined,
        thinkingLevel: undefined
      })
    }
    this.configureWorkspace(workspace)
    if (options.session) this.threadId = this.parseRef(options.session)
    this.launching = this.connect().finally(() => {
      this.launching = undefined
    })
    return this.launching
  }
  private parseRef(ref: string): string {
    if (!/^codex:[a-zA-Z0-9-]+$/.test(ref)) throw new Error('不是 Codex 会话')
    return ref.slice(6)
  }
  private async connect(): Promise<PiStatus> {
    this.setStatus({ phase: 'starting', cwd: this.roots.primary })
    try {
      if (!this.connected) {
        this.rpc.start(
          this.options.script ? process.execPath : this.options.binary,
          [
            ...(this.options.script ? [this.options.script] : []),
            'app-server',
            '--listen',
            'stdio://'
          ],
          this.roots.primary,
          this.options.script ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
        )
        await this.rpc.request('initialize', {
          clientInfo: { name: 'prophey', title: 'Prophey', version: '0.5.3' },
          capabilities: { experimentalApi: false }
        })
        this.rpc.notification('initialized')
        this.connected = true
        let cursor: string | undefined
        this.catalog = []
        do {
          const result = await this.rpc.request('model/list', { cursor, limit: 100 })
          this.catalog.push(...result.data)
          cursor = result.nextCursor ?? undefined
        } while (cursor)
      }
      const response = await this.rpc.request(this.threadId ? 'thread/resume' : 'thread/start', {
        ...(this.threadId ? { threadId: this.threadId } : {}),
        ...this.threadOptions()
      })
      this.applyThread(response)
      await this.readHistory(response.thread)
      this.setStatus({ phase: 'ready' })
      return this.snapshot
    } catch (error) {
      this.setStatus({ phase: 'error', error: String(error) })
      throw error
    }
  }
  private threadOptions(): Record<string, unknown> {
    const sandbox = this.options.sandbox?.()
    return {
      cwd: this.roots.primary,
      ...(sandbox ? { sandbox: sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } : {}),
      ...(this.roots.additional.length
        ? {
            config: { 'sandbox_workspace_write.writable_roots': this.roots.additional },
            developerInstructions:
              '本会话附加目录：' + this.roots.additional.join('、') + '。跨目录使用绝对路径。'
          }
        : {})
    }
  }
  private applyThread(response: any): void {
    this.threadId = response.thread.id
    this.setStatus({
      sessionFile: 'codex:' + this.threadId,
      sessionName: response.thread.name ?? undefined,
      model: {
        provider: 'codex',
        id: response.model ?? this.snapshot.model?.id ?? '',
        name: response.model ?? this.snapshot.model?.name
      },
      thinkingLevel: response.reasoningEffort ?? undefined
    })
  }
  private async readHistory(thread?: any): Promise<void> {
    this.transcript = []
    if (!this.threadId) return
    try {
      let cursor: string | undefined
      do {
        const page = await this.rpc.request('thread/items/list', {
          threadId: this.threadId,
          cursor,
          limit: 100,
          sortDirection: 'asc'
        })
        for (const entry of page.data) this.applyItem(entry.item, false)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
    } catch (error) {
      if (/not supported|method not found/i.test(String(error))) {
        if (!thread)
          thread = (
            await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true })
          ).thread
        this.transcript = []
        for (const turn of thread?.turns ?? [])
          for (const item of turn.items ?? []) this.applyItem(item, false)
      } else if (
        !String(error).match(/not found|not materialized|no rollout|empty|not yet|no persisted/i)
      )
        throw error
    }
  }
  stop(): void {
    this.connected = false
    this.rpc.stop()
    this.finish(this.busy() ? '会话已停止' : undefined)
    this.setStatus({ phase: 'stopped' })
  }
  stderrTail(): string {
    return this.rpc.stderr
  }
  async abort(): Promise<void> {
    if (!this.busy() || !this.threadId) return
    if (this.turnId)
      await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
    else {
      this.stop()
      return
    }
    if (!(await this.waitForSettle(5000))) this.stop()
  }
  async newSession(): Promise<{ cancelled?: boolean }> {
    if (this.busy()) throw new Error('请先停止当前回合')
    this.threadId = undefined
    this.turnId = undefined
    this.usage = {}
    this.transcript = []
    await this.connect()
    return { cancelled: false }
  }
  async switchSession(ref: string): Promise<void> {
    if (this.busy()) throw new Error('请先停止当前回合')
    this.threadId = this.parseRef(ref)
    this.turnId = undefined
    await this.connect()
  }
  async clone(): Promise<string> {
    if (this.busy() || !this.threadId) throw new Error('当前会话还不能分叉')
    const response = await this.rpc.request('thread/fork', {
      threadId: this.threadId,
      ...this.threadOptions()
    })
    this.applyThread(response)
    await this.readHistory(response.thread)
    return 'codex:' + this.threadId
  }
  async discardSession(ref: string): Promise<void> {
    const id = this.parseRef(ref)
    if (id === this.threadId) throw new Error('不能归档当前会话')
    // Preserve a recoverable native fork; never delete the user's Codex history files.
    await this.rpc.request('thread/archive', { threadId: id })
  }
  async models(): Promise<Record<string, unknown>[]> {
    return this.catalog.map((m) => ({ provider: 'codex', id: m.model, name: m.displayName }))
  }
  async setModel(_provider: string, model: string): Promise<PiModel> {
    const row = this.catalog.find((m) => m.model === model || m.id === model)
    if (!row) throw new Error('Codex 模型目录中没有 ' + model)
    const info = { provider: 'codex', id: row.model, name: row.displayName }
    this.setStatus({ model: info, thinkingLevel: row.defaultReasoningEffort })
    return info
  }
  async thinkingLevels(): Promise<string[]> {
    const row = this.catalog.find((m) => m.model === this.snapshot.model?.id)
    return (row?.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort)
  }
  async setThinkingLevel(level: string): Promise<void> {
    if (!(await this.thinkingLevels()).includes(level))
      throw new Error('当前模型不支持思考等级 ' + level)
    this.setStatus({ thinkingLevel: level })
  }
  async nativeCommands(): Promise<EngineCommand[]> {
    const result = await this.rpc.request('skills/list', { cwds: [this.roots.primary] })
    this.skills = result.data
      .flatMap((entry: any) => entry.skills ?? [])
      .filter((s: any) => s.enabled)
    return [
      {
        name: '/mcp',
        args: '',
        hint: '查看 Codex 原生 MCP 服务器与工具',
        action: 'native',
        source: 'engine'
      },
      { name: '/skills', args: '', hint: '查看当前可用技能', action: 'native', source: 'engine' },
      {
        name: '/review',
        args: '[审查要求]',
        hint: '使用 Codex 原生审查，默认审查未提交改动',
        action: 'native',
        source: 'engine'
      },
      ...this.skills.map((s) => ({
        name: '/' + s.name,
        args: '[参数]',
        hint: s.description,
        action: 'native' as const,
        source: 'engine' as const
      }))
    ]
  }
  async executeCommand(name: string, args: string): Promise<{ text?: string }> {
    if (name === '/mcp') {
      const lines: string[] = []
      let cursor: string | undefined
      do {
        const params = { threadId: this.threadId, cursor, limit: 100 }
        const page = await this.rpc.request('mcpServerStatus/list', params).catch((error) => {
          if (!/thread not found/i.test(String(error))) throw error
          return this.rpc.request('mcpServerStatus/list', { cursor, limit: 100 })
        })
        for (const server of page.data)
          lines.push(
            server.name +
              ' — ' +
              (server.runtimeStatus ?? server.authStatus ?? '状态未知') +
              '\n' +
              Object.keys(server.tools ?? {}).join(', ')
          )
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return { text: lines.join('\n\n') || '没有原生 MCP 服务器' }
    }
    if (name === '/skills') {
      await this.nativeCommands()
      return {
        text:
          this.skills.map((s) => '/' + s.name + ' — ' + s.description).join('\n') || '没有可用技能'
      }
    }
    if (name === '/review') {
      await this.runRequest('review/start', {
        threadId: this.threadId,
        delivery: 'inline',
        target: args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' }
      })
    } else {
      await this.nativeCommands()
      const skill = this.skills.find((s) => '/' + s.name === name)
      if (!skill) throw new Error('Codex 没有命令 ' + name)
      await this.runRequest('turn/start', {
        ...this.turnOptions(),
        input: [
          { type: 'skill', name: skill.name, path: skill.path },
          { type: 'text', text: args || '执行 ' + name, text_elements: [] }
        ]
      })
    }
    return {}
  }
  async compact(instructions?: string): Promise<{ summary?: string }> {
    if (instructions?.trim()) throw new Error('Codex 原生压缩不接受额外提示词')
    await this.runRequest('thread/compact/start', { threadId: this.threadId }, true)
    await this.readHistory()
    return { summary: 'Codex 原生压缩完成' }
  }
  private turnOptions(): Record<string, unknown> {
    return {
      threadId: this.threadId,
      model: this.snapshot.model?.id,
      effort: this.snapshot.thinkingLevel
    }
  }
  async prompt(
    message: string,
    options: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] } = {}
  ): Promise<PromptResult> {
    const input = [
      { type: 'text', text: message, text_elements: [] },
      ...(options.images ?? []).map((i) => ({
        type: 'image',
        url: 'data:' + i.mimeType + ';base64,' + i.data
      }))
    ]
    try {
      if (this.busy()) {
        if (options.behavior !== 'steer' || !this.turnId || this.compacting())
          return { ok: false, error: '当前回合未结束，请排队发送' }
        await this.rpc.request('turn/steer', {
          threadId: this.threadId,
          expectedTurnId: this.turnId,
          input
        })
        return { ok: true, disposition: 'queued', queued: true }
      }
      await this.runRequest('turn/start', { ...this.turnOptions(), input })
      return { ok: true, disposition: 'started' }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }
  private async runRequest(method: string, params: any, compact = false): Promise<void> {
    if (!this.connected || !this.threadId) throw new Error('Codex 未连接')
    const done = this.begin(compact)
    void done.catch(() => undefined)
    try {
      const result = await this.rpc.request(method, params)
      if (this.active) this.turnId = result.turn?.id ?? this.turnId
    } catch (error) {
      this.finish(String(error))
    }
    await done
  }
  private handle(method: string, p: any): void {
    if (p?.threadId && p.threadId !== this.threadId) return
    if (method === 'turn/started') this.turnId = p.turn.id
    else if (method === 'turn/completed') {
      this.turnId = undefined
      this.finish(
        p.turn.error?.message ?? (p.turn.status === 'failed' ? 'Codex 回合失败' : undefined)
      )
    } else if (method === 'error' && p.willRetry)
      this.callbacks.onEvent({
        type: 'auto_retry_start',
        error: p.error?.message ?? 'Codex 正在重试'
      })
    else if (method === 'error' && !p.willRetry) this.finish(p.error?.message ?? 'Codex 请求失败')
    else if (method === 'item/agentMessage/delta')
      this.callbacks.onEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: p.delta }
      })
    else if (method === 'item/started') {
      if (p.item.type === 'agentMessage')
        this.callbacks.onEvent({ type: 'message_start', message: { role: 'assistant' } })
      if (p.item.type === 'contextCompaction') {
        this.setStatus({ compacting: true })
        this.callbacks.onEvent({ type: 'compaction_start' })
      } else if (!['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(p.item.type)) {
        this.callbacks.onEvent({
          type: 'tool_execution_start',
          toolCallId: p.item.id,
          toolName: p.item.tool ?? p.item.type,
          args: p.item.arguments ?? { command: p.item.command, changes: p.item.changes }
        })
      }
    } else if (method === 'item/completed') this.applyItem(p.item, true)
    else if (method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage
      const total = u.total ?? {}
      const last = u.last ?? {}
      const window = u.modelContextWindow
      this.usage = {
        tokens: { input: total.inputTokens, output: total.outputTokens, total: total.totalTokens },
        contextUsage: {
          tokens: last.totalTokens ?? null,
          contextWindow: window ?? undefined,
          percent: window ? ((last.totalTokens ?? 0) / window) * 100 : null
        }
      }
      if (this.snapshot.model && window)
        this.setStatus({ model: { ...this.snapshot.model, contextWindow: window } })
    }
  }
  private applyItem(item: any, live: boolean): void {
    let message: Record<string, unknown> | undefined
    if (item.type === 'userMessage')
      message = {
        role: 'user',
        content: item.content.map((c: any) =>
          c.type === 'image' && c.url?.startsWith('data:')
            ? {
                type: 'image',
                mimeType: c.url.slice(5, c.url.indexOf(';')),
                data: c.url.split(',')[1]
              }
            : c
        ),
        id: item.id
      }
    else if (item.type === 'agentMessage')
      message = { role: 'assistant', content: [{ type: 'text', text: item.text }], id: item.id }
    else if (item.type === 'reasoning')
      message = {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: (item.summary ?? item.content ?? []).join('\n') }],
        id: item.id
      }
    else if (item.type === 'contextCompaction') {
      if (live) {
        this.setStatus({ compacting: false })
        this.callbacks.onEvent({ type: 'compaction_end' })
      }
    } else if (item.type !== 'plan') {
      const name = item.tool ?? item.type
      const args = item.arguments ?? { command: item.command, changes: item.changes }
      const content = [
        { type: 'text', text: item.aggregatedOutput ?? JSON.stringify(item.result ?? item) }
      ]
      this.transcript.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: item.id, name, arguments: args }]
      })
      message = {
        role: 'toolResult',
        toolCallId: item.id,
        toolName: name,
        content,
        isError: item.status === 'failed'
      }
      if (live)
        this.callbacks.onEvent({
          type: 'tool_execution_end',
          toolCallId: item.id,
          toolName: name,
          result: { content },
          isError: item.status === 'failed'
        })
    }
    if (message) {
      if (live) this.emitMessage(message)
      else this.transcript.push(message)
    }
  }
  private async approval(method: string, p: any): Promise<unknown> {
    if (p.threadId && p.threadId !== this.threadId) throw new Error('请求不属于当前会话')
    if (method === 'item/tool/requestUserInput') {
      const questions = p.questions ?? []
      const result = await this.ask(
        questions.map((q: any) => ({ question: q.question, header: q.header, options: q.options })),
        'Codex'
      )
      return {
        answers: Object.fromEntries(
          questions.map((q: any, i: number) => [
            q.id,
            {
              answers: result.cancelled
                ? []
                : [
                    ...(result.answers[i]?.selected ?? []),
                    ...(result.answers[i]?.other ? [result.answers[i].other] : [])
                  ]
            }
          ])
        )
      }
    }
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      const result = await this.ask(
        [
          {
            question:
              (p.reason ?? 'Codex 请求执行操作') +
              '\n' +
              (p.command ?? JSON.stringify(p.changes ?? p)),
            options: [{ label: '拒绝' }, { label: '允许本次' }]
          }
        ],
        'Codex'
      )
      return {
        decision:
          !result.cancelled && result.answers[0]?.selected.includes('允许本次')
            ? 'accept'
            : 'decline'
      }
    }
    throw new Error('尚不支持的 Codex 请求：' + method)
  }
}

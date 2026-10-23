import { useState } from 'react'
import type { SubagentView } from '@shared/types'
import type { ChatItem, ToolCallView } from '../lib/messages'
import { Markdown } from './Markdown'
import { MessageImages } from './ImageLightbox'
import { ChevronIcon, SparkIcon, ToolIcon } from './Icons'

const SUBAGENT_STATUS: Record<SubagentView['status'], string> = {
  starting: '启动中',
  streaming: '运行中',
  idle: '已完成',
  error: '出错',
  stopped: '已停止'
}

/** The desktop tool that starts a run: these get a card of their own instead of a generic row. */
function isSubagentStart(name: string): boolean {
  return name.endsWith('start_subagent')
}

function subagentIdFrom(text: string | undefined): string | undefined {
  return /sa_[0-9a-f]{6,}/.exec(text ?? '')?.[0]
}

function subagentHint(call: ToolCallView): { label?: string; agent?: string } {
  try {
    const args = JSON.parse(call.args) as { label?: string; agent?: string; task?: string }
    return { label: args.label, agent: args.agent }
  } catch {
    return {}
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

type ToolKind = 'read' | 'write' | 'bash' | 'search' | 'other'

function kindOf(name: string): ToolKind {
  const tool = name.replace(/^mcp__/, '').toLowerCase()
  if (tool === 'read' || tool === 'read_file' || tool === 'view') return 'read'
  if (
    tool === 'write' ||
    tool === 'edit' ||
    tool === 'patch' ||
    tool === 'multiedit' ||
    tool === 'filechange'
  )
    return 'write'
  if (
    tool === 'bash' ||
    tool === 'shell' ||
    tool === 'exec' ||
    tool === 'commandexecution' ||
    tool === 'powershell'
  )
    return 'bash'
  if (tool === 'grep' || tool === 'glob' || tool === 'ls' || tool === 'search') return 'search'
  return 'other'
}

const KIND_LABELS: Record<ToolKind, (count: number) => string> = {
  read: (count) => `读取 ${count} 个文件`,
  write: (count) => `编辑 ${count} 个文件`,
  bash: (count) => `运行 ${count} 条命令`,
  search: (count) => `搜索 ${count} 次`,
  other: (count) => `调用 ${count} 个工具`
}

function describeCalls(calls: ToolCallView[]): string {
  const order: ToolKind[] = []
  const counts = new Map<ToolKind, number>()
  for (const call of calls) {
    const kind = kindOf(call.name)
    if (!counts.has(kind)) order.push(kind)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return order.map((kind) => KIND_LABELS[kind](counts.get(kind)!)).join(' · ')
}

function Activity({ calls }: { calls: ToolCallView[] }) {
  const [open, setOpen] = useState(false)
  const running = calls.some((call) => call.status === 'running')
  const failed = calls.some((call) => call.status === 'error')
  return (
    <div className="activity">
      <button
        className={`activity-row ${running ? 'running' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title="展开工具调用"
      >
        {(running || failed) && (
          <span className={`activity-dot ${running ? 'running' : 'error'}`} />
        )}
        <span className="activity-text">{describeCalls(calls)}</span>
        <ChevronIcon size={11} className={`activity-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="activity-body">
          {calls.map((call) => (
            <ToolCard key={call.id} call={call} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolCard({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false)
  const expanded = open || call.status === 'running'
  return (
    <div className={`tool-card ${call.status}`}>
      <button className="tool-head" onClick={() => setOpen((value) => !value)}>
        <span className={`tool-chevron ${expanded ? 'open' : ''}`}>
          <ChevronIcon size={12} />
        </span>
        <ToolIcon size={13} />
        <span className="tool-name">{call.name}</span>
        <span className="tool-summary">{call.args.replace(/\s+/g, ' ').slice(0, 110)}</span>
        <span className="tool-status">
          {call.status === 'running' ? '运行中' : call.status === 'error' ? '失败' : '完成'}
          {call.durationMs !== undefined ? ` · ${formatDuration(call.durationMs)}` : ''}
        </span>
      </button>
      {expanded && (
        <div className="tool-body">
          {call.args && (
            <pre className="tool-args">
              <code>{call.args}</code>
            </pre>
          )}
          {call.result && <pre className="tool-result">{call.result}</pre>}
          {call.status === 'running' && !call.result && (
            <div className="tool-running">
              <span className="pulse-dot" /> 执行中…
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A subagent run as it appears in the transcript: its own icon, live status, and — when expanded —
 * the child's latest output plus a way into the full panel.
 */
function SubagentCard({
  call,
  record,
  onOpen
}: {
  call: ToolCallView
  record?: SubagentView
  onOpen: (id?: string) => void
}) {
  const hint = subagentHint(call)
  const id = record?.id ?? subagentIdFrom(call.result)
  const status = record?.status ?? (call.status === 'running' ? 'streaming' : 'idle')
  const [open, setOpen] = useState(false)
  const label = record?.label ?? hint.label ?? record?.agent ?? hint.agent ?? '子代理'
  const lastMessage = record?.messages?.[record.messages.length - 1]?.text
  const running = status === 'starting' || status === 'streaming'

  return (
    <div className={`subagent-card ${status}`}>
      <button className="subagent-card-head" onClick={() => setOpen((value) => !value)}>
        <span className={`subagent-card-icon ${status}`}>
          <SparkIcon size={12} />
        </span>
        <span className="subagent-card-title">{label}</span>
        {record?.agent && record.agent !== label && (
          <span className="subagent-card-agent">{record.agent}</span>
        )}
        <span className={`subagent-card-state ${status}`}>{SUBAGENT_STATUS[status]}</span>
        {id && <span className="subagent-card-id">{id}</span>}
        <span className="subagent-card-spacer" />
        {record?.runtimeMs !== undefined && (
          <span className="subagent-card-meta">{formatDuration(record.runtimeMs)}</span>
        )}
        <ChevronIcon size={11} className={`activity-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="subagent-card-body">
          {record?.error && <div className="message-error">{record.error}</div>}
          {running && !record?.finalText && (
            <div className="subagent-card-live">
              <span className="pulse-dot" />
              <span>
                {lastMessage ? lastMessage.replace(/\s+/g, ' ').slice(0, 240) : '正在处理…'}
              </span>
            </div>
          )}
          {record?.finalText && (
            <div className="subagent-card-final">
              <Markdown>{record.finalText}</Markdown>
            </div>
          )}
          {!record && !running && call.result && <pre className="tool-result">{call.result}</pre>}
          <div className="subagent-card-actions">
            <button className="ghost" onClick={() => onOpen(id)}>
              查看详细进程
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen((value) => !value)}>
        <SparkIcon size={13} />
        <span>思考过程</span>
        <ChevronIcon size={12} className={open ? 'rotated' : ''} />
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

function Message({
  item,
  subagents,
  onOpenSubagent
}: {
  item: ChatItem
  subagents: SubagentView[]
  onOpenSubagent: (id?: string) => void
}) {
  if (item.role === 'system') {
    return (
      <article className="message system" data-message-id={item.id}>
        <div className="system-notice">
          <span className="system-notice-tag">子代理</span>
          <span className="system-notice-text">{item.text}</span>
        </div>
      </article>
    )
  }
  if (item.role === 'user') {
    return (
      <article
        className={`message user ${item.pending ? 'pending' : ''}`}
        data-message-id={item.id}
      >
        {item.images && item.images.length > 0 && (
          <MessageImages images={item.images} align="end" />
        )}
        {item.text && <div className="user-bubble">{item.text}</div>}
      </article>
    )
  }
  const starts = item.toolCalls.filter((call) => isSubagentStart(call.name))
  const others = item.toolCalls.filter((call) => !isSubagentStart(call.name))
  return (
    <article className="message assistant" data-message-id={item.id}>
      <div className="assistant-body">
        {item.thinking && <Thinking text={item.thinking} />}
        {item.text && <Markdown>{item.text}</Markdown>}
        {starts.map((call) => {
          const id = subagentIdFrom(call.result)
          const record = id
            ? subagents.find((entry) => entry.id === id)
            : (() => {
                const hint = subagentHint(call)
                if (!hint.label) return undefined
                return subagents.find((entry) => entry.label === hint.label)
              })()
          return <SubagentCard key={call.id} call={call} record={record} onOpen={onOpenSubagent} />
        })}
        {others.length > 0 && <Activity calls={others} />}
        {item.error && <div className="message-error">{item.error}</div>}
        {item.streaming && !item.text && item.toolCalls.length === 0 && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </article>
  )
}

const SUGGESTIONS = [
  '梳理这个仓库的目录结构，并说明核心模块',
  '找出最近一次失败的测试并修复它',
  '为当前改动写一份提交信息',
  '解释 src 里最关键的一条调用链'
]

export function Conversation({
  items,
  workspace,
  connected,
  loggedIn,
  subagents,
  onOpenSubagent,
  onSuggestion
}: {
  items: ChatItem[]
  workspace: string
  connected: boolean
  loggedIn: boolean
  subagents: SubagentView[]
  onOpenSubagent: (id?: string) => void
  onSuggestion: (text: string) => void
}) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="empty-mark">π</div>
        <h1>开始一段对话</h1>
        <p className="empty-sub">
          当前工作目录 <code>{workspace}</code>
        </p>
        {!connected && <p className="empty-warn">引擎尚未就绪，请查看顶部状态提示。</p>}
        {connected && !loggedIn && (
          <p className="empty-warn">尚未配置模型服务：打开设置 → 服务商完成配置。</p>
        )}
        <div className="suggestions">
          {SUGGESTIONS.map((text) => (
            <button key={text} className="suggestion" onClick={() => onSuggestion(text)}>
              {text}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="conversation">
      {items.map((item) => (
        <Message key={item.id} item={item} subagents={subagents} onOpenSubagent={onOpenSubagent} />
      ))}
    </div>
  )
}

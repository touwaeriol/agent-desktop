import { useState } from 'react'
import type { ChatItem, ToolCallView } from '../lib/messages'
import { Markdown } from './Markdown'
import { MessageImages } from './ImageLightbox'
import { BranchIcon, ChevronIcon, SparkIcon, ToolIcon } from './Icons'

function formatDuration(ms?: number): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
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

function Message({ item }: { item: ChatItem }) {
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
  return (
    <article className="message assistant" data-message-id={item.id}>
      <div className="assistant-avatar">
        <BranchIcon size={13} />
      </div>
      <div className="assistant-body">
        {item.thinking && <Thinking text={item.thinking} />}
        {item.text && <Markdown>{item.text}</Markdown>}
        {item.toolCalls.map((call) => (
          <ToolCard key={call.id} call={call} />
        ))}
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
  onSuggestion
}: {
  items: ChatItem[]
  workspace: string
  connected: boolean
  loggedIn: boolean
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
        {!connected && <p className="empty-warn">pi 尚未就绪，请查看顶部状态提示。</p>}
        {connected && !loggedIn && (
          <p className="empty-warn">pi 已连接，但还没有登录模型服务：打开设置 → 服务商完成登录。</p>
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
        <Message key={item.id} item={item} />
      ))}
    </div>
  )
}

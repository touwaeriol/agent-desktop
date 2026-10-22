import { useEffect, useMemo, useState } from 'react'
import type { SubagentView } from '@shared/types'
import { RefreshIcon, SparkIcon, StopIcon } from './Icons'
import { Markdown } from './Markdown'

const STATUS_LABEL: Record<SubagentView['status'], string> = {
  starting: '启动中',
  idle: '已完成',
  streaming: '运行中',
  error: '出错',
  stopped: '已停止'
}

function span(ms: number | undefined): string {
  if (typeof ms !== 'number') return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function tokenLabel(count: number | undefined): string {
  if (typeof count !== 'number') return ''
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

function changedFiles(record: SubagentView): string[] {
  const seen = new Set<string>()
  for (const call of record.calls) {
    if (call.tool !== 'edit' && call.tool !== 'write' && call.tool !== 'apply_patch') continue
    if (call.summary) seen.add(call.summary)
  }
  return [...seen]
}

function isRunning(record: SubagentView): boolean {
  return record.status === 'starting' || record.status === 'streaming'
}

export function SubagentsPanel({
  records,
  initialId,
  onClose
}: {
  records: SubagentView[]
  initialId?: string
  onClose: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'steer' | 'follow-up' | 'interrupt'>('steer')
  const [busy, setBusy] = useState(false)
  const [showMessages, setShowMessages] = useState(false)
  const [query, setQuery] = useState('')

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return records
    return records.filter((record) =>
      `${record.id} ${record.label ?? ''} ${record.agent ?? ''} ${record.finalText ?? ''} ${record.cwd}`
        .toLowerCase()
        .includes(needle)
    )
  }, [records, query])

  const selected = useMemo(
    () => visible.find((record) => record.id === selectedId) ?? visible[0],
    [visible, selectedId]
  )

  // Opening the panel from a task chip or a transcript card selects that run.
  useEffect(() => {
    if (initialId) setSelectedId(initialId)
  }, [initialId])

  useEffect(() => {
    setDraft('')
    setShowMessages(false)
  }, [selected?.id])

  const stop = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    await window.pi.stopSubagent(selected.id)
    setBusy(false)
  }

  const send = async (): Promise<void> => {
    if (!selected || !draft.trim()) return
    setBusy(true)
    const ok = await window.pi.promptSubagent(selected.id, draft.trim(), mode)
    setBusy(false)
    if (ok) setDraft('')
  }

  return (
    <div
      className="mcp-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="mcp-overlay-card subagents-card">
        <div className="mcp-overlay-head">
          <span>
            子代理
            {records.length > 0 && <span className="subagents-count">{records.length}</span>}
          </span>
          <button className="icon-btn" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        {records.length === 0 ? (
          <div className="mcp-overlay-body">
            <div className="provider-empty">
              还没有子代理。模型用 <code>start_subagent</code> 启动后，会出现在这里。
            </div>
          </div>
        ) : (
          <div className="subagents-body">
            <div className="subagents-list">
              <input
                className="subagents-search"
                value={query}
                placeholder="搜索 id / 名称 / 结论"
                onChange={(event) => setQuery(event.target.value)}
              />
              {visible.map((record) => (
                <button
                  key={record.id}
                  className={`subagent-row ${record.id === selected?.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(record.id)}
                >
                  <span className={`subagent-avatar ${record.status}`}>
                    <SparkIcon size={11} />
                  </span>
                  <span className="subagent-row-main">
                    <span className="subagent-row-head">
                      {record.label ?? record.agent ?? record.id}
                      {record.label && <span className="subagent-row-id">{record.id}</span>}
                      {record.restored && <span className="subagent-tag">历史</span>}
                    </span>
                    <span className="subagent-row-sub">
                      {STATUS_LABEL[record.status]}
                      {record.mode === 'background' ? ' · 后台' : ' · 同步'}
                      {span(record.runtimeMs) ? ` · ${span(record.runtimeMs)}` : ''}
                      {tokenLabel(record.tokens) ? ` · ${tokenLabel(record.tokens)} tokens` : ''}
                    </span>
                  </span>
                </button>
              ))}
              {visible.length === 0 && <div className="subagent-empty">没有匹配的记录</div>}
            </div>

            {selected && (
              <div className="subagent-detail">
                <div className="subagent-meta">
                  <span className={`subagent-status ${selected.status}`}>
                    {STATUS_LABEL[selected.status]}
                  </span>
                  <span>{selected.id}</span>
                  {selected.agent && <span>{selected.agent}</span>}
                  {selected.model && (
                    <span>
                      {selected.model.provider}/{selected.model.id}
                    </span>
                  )}
                  {selected.notify !== 'none' && (
                    <span>{selected.notify === 'wake' ? '结束唤醒父代理' : '结束通知父代理'}</span>
                  )}
                </div>
                <div className="subagent-cwd" title={selected.cwd}>
                  {selected.cwd}
                </div>

                {selected.sessionFile && (
                  <div className="subagent-session">
                    <span className="subagent-session-label">会话</span>
                    <span className="subagent-session-path" title={selected.sessionFile}>
                      {selected.sessionFile.split(/[\\/]/).pop()}
                    </span>
                    <button
                      className="ghost"
                      onClick={() => void window.pi.revealSubagentSession(selected.sessionFile!)}
                    >
                      定位
                    </button>
                  </div>
                )}

                {selected.error && <div className="message-error">{selected.error}</div>}

                <div className="subagent-section">
                  <div className="subagent-section-head">结论</div>
                  {selected.finalText ? (
                    <div className="subagent-final">
                      <Markdown>{selected.finalText}</Markdown>
                    </div>
                  ) : (
                    <div className="subagent-empty">
                      {isRunning(selected) ? '还在运行，暂无结论。' : '（没有结论）'}
                    </div>
                  )}
                </div>

                {changedFiles(selected).length > 0 && (
                  <div className="subagent-section">
                    <div className="subagent-section-head">
                      改动 {changedFiles(selected).length} 个文件
                    </div>
                    <div className="subagent-files">
                      {changedFiles(selected).map((file) => (
                        <span key={file} className="subagent-file">
                          {file}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {selected.messages.length > 0 && (
                  <div className="subagent-section">
                    <button
                      className="subagent-toggle"
                      onClick={() => setShowMessages((value) => !value)}
                    >
                      {showMessages ? '收起过程' : `过程（${selected.messages.length} 条）`}
                    </button>
                    {showMessages && (
                      <div className="subagent-messages">
                        {selected.messages.slice(-20).map((message, index) => (
                          <div key={index} className={`subagent-message ${message.role}`}>
                            <span className="subagent-message-role">
                              {message.role === 'assistant' ? '子代理' : '提示'}
                            </span>
                            <span className="subagent-message-text">
                              {message.text || `（调用 ${message.toolCalls?.join(', ')}）`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="subagent-actions">
                  {selected.restored ? (
                    <div className="subagent-empty">
                      历史记录：进程已结束，只能查看结果。需要继续就在同一目录重新起一个子代理。
                    </div>
                  ) : (
                    <>
                      {draft.trim() && (
                        <div className="subagent-modes">
                          {(
                            [
                              ['steer', '引导（当前回合后注入）'],
                              ['follow-up', '追加（本回合结束后）'],
                              ['interrupt', '打断后重答']
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              className={`ghost ${mode === value ? 'active' : ''}`}
                              onClick={() => setMode(value)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="subagent-compose">
                        <input
                          value={draft}
                          placeholder="给它发一条消息…"
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault()
                              void send()
                            }
                          }}
                          disabled={selected.status === 'stopped' || selected.status === 'error'}
                        />
                        <button
                          className="ghost"
                          onClick={() => void send()}
                          disabled={
                            !draft.trim() ||
                            busy ||
                            selected.status === 'stopped' ||
                            selected.status === 'error'
                          }
                        >
                          <RefreshIcon size={13} /> 发送
                        </button>
                        <button
                          className="ghost danger"
                          onClick={() => void stop()}
                          disabled={busy || !isRunning(selected)}
                          title="停止子代理"
                        >
                          <StopIcon size={13} /> 停止
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mcp-overlay-foot">
          子代理是独立的 pi 进程，默认不加载桌面 MCP。预设与并发限制在 设置 → 代理。
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem } from '../lib/messages'
import type { OutlineEntry } from '../lib/outline'
import { CloseIcon, ListIcon } from './Icons'

const MAX_TICKS = 80

function formatTime(value?: number): string {
  if (!value) return '未知时间'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat
}

/**
 * Two separate rails: user-message ticks on the left edge, the heading outline on the right.
 * Keeping them apart means neither competes with the scrollbar or the message column.
 */
export function SessionNavigator({
  items,
  outline,
  activeUserIndex,
  activeOutlineId,
  onJump
}: {
  items: ChatItem[]
  outline: OutlineEntry[]
  activeUserIndex: number
  activeOutlineId?: string
  onJump: (itemId: string) => void
}) {
  const users = useMemo(() => items.filter((item) => item.role === 'user'), [items])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [hovered, setHovered] = useState<number>()
  const outlineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!outlineOpen) return
    const onMouseDown = (event: MouseEvent): void => {
      if (!outlineRef.current?.contains(event.target as Node)) setOutlineOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOutlineOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [outlineOpen])

  const step = Math.max(1, Math.ceil(users.length / MAX_TICKS))
  const ticks = users
    .map((user, index) => ({ user, index }))
    .filter(({ index }) => index % step === 0 || index === users.length - 1)
  // "会话开始" is the anchor at the top, not a section of its own.
  const sectionCount = outline.filter((entry) => entry.kind !== 'start').length

  return (
    <>
      <div className="session-nav">
        <div className="nav-timeline">
          {ticks.map(({ user, index }) => {
            const active =
              activeUserIndex >= index &&
              (activeUserIndex < index + step || index === users.length - 1)
            return (
              <button
                key={user.id}
                className={`nav-tick ${active ? 'active' : ''}`}
                title={formatTime(user.timestamp)}
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered((value) => (value === index ? undefined : value))}
                onClick={() => onJump(user.id)}
              >
                <span className="nav-tick-line" />
                {hovered === index && (
                  <span className="nav-preview">
                    <span className="nav-preview-time">{formatTime(user.timestamp)}</span>
                    <span className="nav-preview-text">{preview(user.text)}</span>
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="session-outline" ref={outlineRef}>
        <button
          className={`nav-outline-btn ${outlineOpen ? 'on' : ''}`}
          title={`标题大纲（${sectionCount}）`}
          onClick={() => setOutlineOpen((value) => !value)}
        >
          <ListIcon size={13} />
        </button>
        {outlineOpen && (
          <div className="nav-outline-panel">
            <div className="nav-outline-head">
              <span>标题大纲</span>
              <span className="nav-outline-count">{sectionCount}</span>
              <button className="icon-btn" onClick={() => setOutlineOpen(false)} title="关闭">
                <CloseIcon size={12} />
              </button>
            </div>
            <div className="nav-outline-list">
              {outline.length === 0 ? (
                <div className="nav-outline-empty">还没有可导航的标题</div>
              ) : (
                outline.map((entry) => (
                  <button
                    key={entry.id}
                    className={`nav-outline-item ${entry.kind} ${
                      entry.id === activeOutlineId ? 'active' : ''
                    }`}
                    style={{ paddingLeft: 8 + Math.min(entry.level, 4) * 9 }}
                    title={entry.title}
                    onClick={() => {
                      onJump(entry.messageId)
                      setOutlineOpen(false)
                    }}
                  >
                    <span className="nav-outline-mark" />
                    <span className="nav-outline-title">{entry.title}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

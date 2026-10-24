import { useEffect, useMemo, useRef, useState } from 'react'
import { directoryKey, recentDirectories } from '@shared/recent-directories'
import { CloseIcon, FolderIcon, SearchIcon } from './Icons'

export function WorkspacePicker({ directories, current, onChoose, onBrowse, onClose }: {
  directories: string[]
  current: string
  onChoose: (directory: string) => Promise<void>
  onBrowse: () => Promise<boolean>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const items = useMemo(() => recentDirectories([current, ...directories])
    .filter(dir => dir.toLowerCase().includes(query.trim().toLowerCase())), [directories, current, query])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => { previous?.focus() }
  }, [])

  const run = async (action: () => Promise<boolean | void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try { if (await action() !== false) onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop workspace-picker-backdrop" onClick={() => { if (!busy) onClose() }}>
    <div ref={panel} className="workspace-picker" role="dialog" aria-modal="true" aria-labelledby="workspace-picker-title"
      onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }
        if (event.key === 'Tab') {
          const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])
          const first = focusable[0], last = focusable.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
      <header className="workspace-picker-head">
        <div><h3 id="workspace-picker-title">新会话</h3><p>选择最近目录，直接开始</p></div>
        <button className="icon-btn" title="关闭" disabled={busy} onClick={onClose}><CloseIcon size={14} /></button>
      </header>
      <div className="workspace-picker-search"><SearchIcon size={14} />
        <input ref={input} aria-label="搜索最近目录" placeholder="搜索名称或路径" value={query} disabled={busy}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && items[0]) { event.preventDefault(); void run(() => onChoose(items[0])) }
            if (event.key === 'ArrowDown') { event.preventDefault(); panel.current?.querySelector<HTMLButtonElement>('.workspace-choice')?.focus() }
          }} />
      </div>
      <div className="workspace-picker-list">
        {items.map(dir => <button key={directoryKey(dir)} className="workspace-choice" title={dir} disabled={busy}
          onClick={() => void run(() => onChoose(dir))}>
          <FolderIcon size={16} /><span className="workspace-choice-text">
            <span className="workspace-choice-name">{dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}</span>
            <span className="workspace-choice-path">{dir}</span>
          </span>{directoryKey(dir) === directoryKey(current) && <span className="workspace-choice-current">当前</span>}
        </button>)}
        {items.length === 0 && <div className="workspace-picker-empty">{query ? '没有匹配的目录' : '还没有最近目录'}</div>}
      </div>
      {error && <div className="workspace-picker-error" role="alert">{error}</div>}
      <footer className="workspace-picker-foot">
        <button className="ghost" disabled={busy} onClick={() => void run(onBrowse)}><FolderIcon size={13} /> 选择其他目录…</button>
        {busy && <span>正在打开…</span>}
      </footer>
    </div>
  </div>
}

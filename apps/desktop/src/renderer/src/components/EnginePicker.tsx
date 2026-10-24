import { useState } from 'react'
import { engineLabel, type EngineId } from '@shared/engine'
import type { PiStatus } from '@shared/types'

const engines: EngineId[] = ['prophey', 'pi', 'claude', 'codex']

/** The selected engine belongs to this conversation, independently of creation defaults. */
export function EnginePicker({ status, compact = false, disabled = false, onNotice, onChanged }: {
  status: PiStatus
  compact?: boolean
  disabled?: boolean
  onNotice?: (message: string) => void
  onChanged?: () => void | Promise<void>
}) {
  const [changing, setChanging] = useState(false)
  const current = status.engine ?? 'prophey'
  const busy = Boolean(status.isStreaming || status.compacting)
  const unavailable = disabled || changing || Boolean(status.switchingEngine) || status.phase === 'starting'
  const title = busy ? '更换当前会话的引擎，先停止本轮；其他会话不变' : '当前会话的引擎；切换时保留正文和工具记录，其他会话不变'
  const change = async (next: EngineId): Promise<void> => {
    if (next === current || unavailable) return
    setChanging(true)
    try {
      const result = await window.pi.setEngine(next)
      if (result.phase !== 'ready') throw new Error(result.error ?? '切换失败')
      await onChanged?.()
      onNotice?.('当前会话已使用 ' + engineLabel(next))
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : String(error))
    } finally {
      setChanging(false)
    }
  }
  if (!compact) return (
    <div className="theme-switch storage-switch" title={title}>
      {engines.map((id) => <button key={id} disabled={unavailable}
        className={current === id ? 'active' : ''} onClick={() => void change(id)}>
        {busy && id !== current ? '停止并切换到 ' : ''}{engineLabel(id)}
      </button>)}
    </div>
  )
  return <label className="engine-picker" title={title}>
    <span className="engine-picker-label">会话引擎</span>
    <select aria-label="当前会话引擎" disabled={unavailable} value={status.switchingEngine ?? current}
      onChange={(event) => void change(event.target.value as EngineId)}>
      {engines.map((id) => <option key={id} value={id}>
        {busy && id !== current ? '停止并切换到 ' : ''}{engineLabel(id)}
      </option>)}
    </select>
  </label>
}

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
  const unavailable = disabled || busy || status.sessionLocked || changing || Boolean(status.switchingEngine) || status.phase === 'starting'
  const title = status.sessionLocked ? '会话已开始，agent 已锁定；如需更换请新建会话' : '开始会话前选择 agent'
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
        {engineLabel(id)}
      </button>)}
    </div>
  )
  return <label className="engine-picker" title={title}>
    <select aria-label="当前会话 agent" disabled={unavailable} value={status.switchingEngine ?? current}
      onChange={(event) => void change(event.target.value as EngineId)}>
      {engines.map((id) => <option key={id} value={id}>
        {engineLabel(id)}
      </option>)}
    </select>
  </label>
}

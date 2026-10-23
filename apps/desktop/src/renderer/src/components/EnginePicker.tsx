import { useState } from 'react'
import { engineLabel, type EngineId } from '@shared/engine'
import type { PiStatus } from '@shared/types'

const engines: EngineId[] = ['prophey', 'pi', 'claude', 'codex']

/** Switching copies the current conversation; it does not open another engine's old session. */
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
  const title = busy ? '停止当前回合，携带正文和工具记录切换；思考内容不迁移' : '携带当前对话切换 agent；思考内容不迁移'
  const change = async (next: EngineId): Promise<void> => {
    if (next === current || unavailable) return
    setChanging(true)
    try {
      const result = await window.pi.setEngine(next)
      if (result.phase !== 'ready') throw new Error(result.error ?? '切换失败')
      await onChanged?.()
      onNotice?.('已携带当前对话切换到 ' + engineLabel(next))
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
    <select aria-label="切换 agent" disabled={unavailable} value={status.switchingEngine ?? current}
      onChange={(event) => void change(event.target.value as EngineId)}>
      {engines.map((id) => <option key={id} value={id}>
        {busy && id !== current ? '停止并切换到 ' : ''}{engineLabel(id)}
      </option>)}
    </select>
  </label>
}

import { useEffect, useState } from 'react'
import type { SubagentView } from '@shared/types'
import { ChevronIcon, SparkIcon } from './Icons'

const STATUS_LABEL: Record<SubagentView['status'], string> = {
  starting: '启动中',
  streaming: '运行中',
  idle: '已完成',
  error: '出错',
  stopped: '已停止'
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function formatTokens(value?: number): string | undefined {
  if (!value) return undefined
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/**
 * Run summary pinned to the composer: elapsed time, tokens, and one chip per running subagent.
 * A chip opens the subagent panel on that run, so a background task is never a dead end.
 */
export function RunStatusBar({
  active,
  elapsedMs,
  tokens,
  runningTools,
  subagents,
  onOpenSubagent
}: {
  active: boolean
  elapsedMs: number
  tokens?: number
  runningTools: number
  subagents: SubagentView[]
  onOpenSubagent: (id?: string) => void
}) {
  const [, setTick] = useState(0)
  const running = subagents.filter(
    (record) => record.status === 'starting' || record.status === 'streaming'
  )

  useEffect(() => {
    if (running.length === 0) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [running.length])

  return (
    <div className="run-status">
      {active ? (
        <>
          <span className="run-dot active" />
          <span className="run-elapsed">{formatElapsed(elapsedMs)}</span>
          {formatTokens(tokens) && (
            <>
              <span className="run-sep">·</span>
              <span>{formatTokens(tokens)} tokens</span>
            </>
          )}
          {runningTools > 0 && (
            <>
              <span className="run-sep">·</span>
              <span>{runningTools} 个工具运行中</span>
            </>
          )}
          <span className="run-sep">·</span>
          <span>运行中</span>
        </>
      ) : (
        <span className="run-idle-label">
          子代理运行中{running.length > 0 ? ` ${running.length}` : ''}
        </span>
      )}

      {running.length > 0 && (
        <div className="run-tasks">
          {running.map((record) => {
            const elapsed = record.runtimeMs ?? Date.now() - record.createdAt
            return (
              <button
                key={record.id}
                className={`run-task ${record.status}`}
                title={`${record.id} · ${STATUS_LABEL[record.status]} · 点击查看详细进程`}
                onClick={() => onOpenSubagent(record.id)}
              >
                <span className="run-task-icon">
                  <SparkIcon size={11} />
                </span>
                <span className="run-task-label">
                  {record.label ?? record.agent ?? record.id}
                </span>
                <span className="run-task-meta">{formatElapsed(elapsed)}</span>
                <ChevronIcon size={10} className="run-task-chevron" />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

import type { SubagentView } from '@shared/types'

export const SUBAGENT_STATUS_LABELS: Record<SubagentView['status'], string> = {
  starting: '启动中',
  streaming: '运行中',
  idle: '已完成',
  error: '出错',
  stopped: '已停止'
}

export function isSubagentRunning(record: Pick<SubagentView, 'status'>): boolean {
  return record.status === 'starting' || record.status === 'streaming'
}

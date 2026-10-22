import type { PiStatus } from '@shared/types'
import { BranchIcon, CloseIcon, PanelIcon, PlusIcon, SparkIcon } from './Icons'

export function TabBar({
  title,
  status,
  streaming,
  sidebarOpen,
  subagentsRunning,
  subagentsFinished,
  onNew,
  onToggleSidebar,
  onOpenSubagents
}: {
  title: string
  status: PiStatus
  streaming: boolean
  sidebarOpen: boolean
  subagentsRunning: number
  subagentsFinished: number
  onNew: () => void
  onToggleSidebar: () => void
  onOpenSubagents: () => void
}) {
  return (
    <header className="tabbar">
      <div className="tabs">
        <div className="tab active">
          <BranchIcon size={13} />
          <span className="tab-title">{title}</span>
          {streaming && <span className="tab-running" />}
          <button className="tab-close" title="关闭并新建会话" onClick={onNew}>
            <CloseIcon size={12} />
          </button>
        </div>
        <button className="tab-new" title="新建会话" onClick={onNew}>
          <PlusIcon size={14} />
        </button>
      </div>
      <div className="tabbar-right">
        {status.phase !== 'ready' && (
          <span className={`connection ${status.phase}`}>
            {status.phase === 'starting' ? '连接 pi…' : status.phase === 'error' ? 'pi 未连接' : '已停止'}
          </span>
        )}
        <button
          className={`subagent-btn ${subagentsRunning > 0 ? 'running' : ''}`}
          title={
            subagentsRunning > 0
              ? `${subagentsRunning} 个子代理运行中`
              : subagentsFinished > 0
                ? `${subagentsFinished} 个子代理已完成`
                : '子代理'
          }
          onClick={onOpenSubagents}
        >
          <SparkIcon size={13} />
          <span>{subagentsRunning > 0 ? subagentsRunning : subagentsFinished || ''}</span>
        </button>
        <button
          className={`icon-btn ${sidebarOpen ? 'on' : ''}`}
          title="显示/隐藏侧栏"
          onClick={onToggleSidebar}
        >
          <PanelIcon size={15} />
        </button>
      </div>
    </header>
  )
}

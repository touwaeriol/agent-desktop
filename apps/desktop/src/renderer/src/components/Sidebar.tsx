import { useEffect, useMemo, useRef, useState } from 'react'
import type { PiStatus, SessionSummary } from '@shared/types'
import {
  ArchiveIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  FilterIcon,
  FolderIcon,
  PanelIcon,
  PlusIcon,
  SearchIcon
} from './Icons'

const PAGE_SIZE = 10
const PREFS_KEY = 'pi-sidebar-prefs'
const ARCHIVE_KEY = 'pi-archived-sessions'

type StatusFilter = 'active' | 'archived' | 'all'
type EnvironmentFilter = 'all' | 'local'
type GroupMode = 'folder' | 'date' | 'none'
type SortMode = 'activity' | 'created' | 'name'

interface Prefs {
  environment: EnvironmentFilter
  group: GroupMode
  sort: SortMode
  showEmptyGroups: boolean
}

const DEFAULT_PREFS: Prefs = {
  environment: 'all',
  group: 'folder',
  sort: 'activity',
  showEmptyGroups: false
}

const STATUS_LABELS: Record<StatusFilter, string> = {
  active: '活跃',
  archived: '已归档',
  all: '全部'
}

const ENVIRONMENT_LABELS: Record<EnvironmentFilter, string> = {
  all: '全部',
  local: '本地'
}

const GROUP_LABELS: Record<GroupMode, string> = {
  folder: '文件夹',
  date: '日期',
  none: '不分组'
}

const SORT_LABELS: Record<SortMode, string> = {
  activity: '最近活动',
  created: '创建时间',
  name: '名称'
}

const STATUS_OPTIONS: StatusFilter[] = ['active', 'archived', 'all']
const ENVIRONMENT_OPTIONS: EnvironmentFilter[] = ['all', 'local']
const GROUP_OPTIONS: GroupMode[] = ['folder', 'date', 'none']
const SORT_OPTIONS: SortMode[] = ['activity', 'created', 'name']

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    return {
      environment: ENVIRONMENT_OPTIONS.includes(raw.environment as EnvironmentFilter)
        ? (raw.environment as EnvironmentFilter)
        : DEFAULT_PREFS.environment,
      group: GROUP_OPTIONS.includes(raw.group as GroupMode)
        ? (raw.group as GroupMode)
        : DEFAULT_PREFS.group,
      sort: SORT_OPTIONS.includes(raw.sort as SortMode)
        ? (raw.sort as SortMode)
        : DEFAULT_PREFS.sort,
      showEmptyGroups: Boolean(raw.showEmptyGroups)
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function loadArchived(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? '[]') as unknown
    return new Set(
      Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : []
    )
  } catch {
    return new Set()
  }
}

function startOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function formatTime(value: number): string {
  const date = new Date(value)
  const today = startOfDay(Date.now())
  if (startOfDay(value) === today) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function dateGroup(value: number): { label: string; order: number } {
  const today = startOfDay(Date.now())
  const day = startOfDay(value)
  if (day === today) return { label: '今天', order: 0 }
  if (day === today - 86400000) return { label: '昨天', order: 1 }
  if (day > today - 86400000 * 7) return { label: '本周', order: 2 }
  return { label: '更早', order: 3 }
}

function baseName(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

const STATUS_TEXT: Record<PiStatus['phase'], string> = {
  starting: '启动中',
  ready: '已连接',
  error: '连接失败',
  stopped: '已停止'
}

interface SessionGroup {
  key: string
  label: string
  cwd?: string
  sessions: SessionSummary[]
  total: number
  searching: boolean
  latest: number
  order: number
}

export function Sidebar({
  sessions,
  activePath,
  status,
  onNew,
  onSelect,
  onNewInProject,
  onChooseWorkspace,
  onCollapse
}: {
  sessions: SessionSummary[]
  activePath?: string
  status: PiStatus
  onNew: () => void
  onSelect: (session: SessionSummary) => void
  onNewInProject: (cwd: string) => void
  onChooseWorkspace: () => void
  onCollapse: () => void
}) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [archived, setArchived] = useState<Set<string>>(loadArchived)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [section, setSection] = useState<'environment' | 'group' | 'sort' | null>(null)
  const [searchKey, setSearchKey] = useState<string>()
  const [filterKey, setFilterKey] = useState<string>()
  const [projectQueries, setProjectQueries] = useState<Record<string, string>>({})
  const [projectStatus, setProjectStatus] = useState<Record<string, StatusFilter>>({})
  const menuRef = useRef<HTMLDivElement>(null)
  const projectFilterRef = useRef<HTMLDivElement>(null)

  const updatePrefs = (patch: Partial<Prefs>): void => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      return next
    })
  }

  const toggleArchive = (path: string): void => {
    setArchived((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...next]))
      return next
    })
  }

  useEffect(() => {
    if (!menuOpen) return
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (menuRef.current?.contains(event.target as Node)) return
      if (target?.closest('.view-trigger')) return
      setMenuOpen(false)
      setSection(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setSection(null)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!filterKey) return
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (projectFilterRef.current?.contains(event.target as Node)) return
      if (target?.closest('.project-filter-trigger')) return
      setFilterKey(undefined)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFilterKey(undefined)
        setSearchKey(undefined)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [filterKey])

  const groups = useMemo<SessionGroup[]>(() => {
    const sortSessions = (list: SessionSummary[]): SessionSummary[] =>
      list.slice().sort((a, b) => {
        if (prefs.sort === 'name') return a.title.localeCompare(b.title, 'zh-CN')
        if (prefs.sort === 'created') return b.createdAt - a.createdAt
        return b.updatedAt - a.updatedAt
      })

    const applyProjectView = (key: string, list: SessionSummary[]) => {
      const status = projectStatus[key] ?? 'active'
      const needle = (projectQueries[key] ?? '').trim().toLowerCase()
      const filtered = list.filter((session) => {
        const isArchived = archived.has(session.path)
        if (status === 'active' && isArchived) return false
        if (status === 'archived' && !isArchived) return false
        if (needle && !`${session.title} ${session.cwd}`.toLowerCase().includes(needle)) {
          return false
        }
        return true
      })
      return {
        sessions: sortSessions(filtered),
        total: list.length,
        searching: Boolean(needle),
        latest: list.reduce((max, session) => Math.max(max, session.updatedAt), 0)
      }
    }

    if (prefs.group === 'none') {
      if (sessions.length === 0) return []
      const view = applyProjectView('none', sessions)
      return [
        {
          key: 'none',
          label: '',
          sessions: view.sessions,
          total: view.total,
          searching: view.searching,
          latest: view.latest,
          order: 0
        }
      ]
    }

    if (prefs.group === 'date') {
      const buckets = new Map<string, { order: number; list: SessionSummary[] }>()
      for (const session of sessions) {
        const { label, order } = dateGroup(session.updatedAt)
        const bucket = buckets.get(label) ?? { order, list: [] }
        bucket.list.push(session)
        buckets.set(label, bucket)
      }
      return [...buckets.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([label, bucket]) => {
          const key = `date:${label}`
          const view = applyProjectView(key, bucket.list)
          return {
            key,
            label,
            sessions: view.sessions,
            total: view.total,
            searching: view.searching,
            latest: view.latest,
            order: bucket.order
          }
        })
    }

    const folders = new Map<string, SessionSummary[]>()
    for (const session of sessions) {
      const key = session.cwd || ''
      const list = folders.get(key) ?? []
      list.push(session)
      folders.set(key, list)
    }
    if (prefs.showEmptyGroups) {
      const known = new Set<string>([status.cwd])
      for (const session of sessions) known.add(session.cwd || '')
      for (const key of known) {
        if (!folders.has(key)) folders.set(key, [])
      }
    }
    const result = [...folders.entries()].map(([cwd, list]) => {
      const key = `folder:${cwd}`
      const view = applyProjectView(key, list)
      return {
        key,
        label: baseName(cwd) || '未命名目录',
        cwd,
        sessions: view.sessions,
        total: view.total,
        searching: view.searching,
        latest: view.latest,
        order: 0
      }
    })
    result.sort((a, b) =>
      prefs.sort === 'name' ? a.label.localeCompare(b.label, 'zh-CN') : b.latest - a.latest
    )
    return result
  }, [sessions, prefs, archived, projectStatus, projectQueries, status.cwd])

  useEffect(() => {
    if (!activePath) return
    const group = groups.find((item) => item.sessions.some((session) => session.path === activePath))
    if (!group) return
    setCollapsed((prev) => {
      if (!prev.has(group.key)) return prev
      const next = new Set(prev)
      next.delete(group.key)
      return next
    })
    setExpanded((prev) => {
      if (prev.has(group.key)) return prev
      const index = group.sessions.findIndex((session) => session.path === activePath)
      if (index < PAGE_SIZE) return prev
      const next = new Set(prev)
      next.add(group.key)
      return next
    })
  }, [activePath, groups])

  const toggleCollapsed = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleExpanded = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const filtersActive =
    prefs.environment !== 'all' ||
    prefs.group !== 'folder' ||
    prefs.sort !== 'activity' ||
    prefs.showEmptyGroups

  const renderOptions = (): React.JSX.Element | null => {
    if (!section) return null
    const config = {
      environment: {
        values: ENVIRONMENT_OPTIONS,
        labels: ENVIRONMENT_LABELS,
        current: prefs.environment,
        apply: (value: EnvironmentFilter) => updatePrefs({ environment: value })
      },
      group: {
        values: GROUP_OPTIONS,
        labels: GROUP_LABELS,
        current: prefs.group,
        apply: (value: GroupMode) => updatePrefs({ group: value })
      },
      sort: {
        values: SORT_OPTIONS,
        labels: SORT_LABELS,
        current: prefs.sort,
        apply: (value: SortMode) => updatePrefs({ sort: value })
      }
    }[section]

    return (
      <div className="filter-submenu">
        {config.values.map((value) => {
          const active = value === config.current
          return (
            <button
              key={value}
              className={`filter-option ${active ? 'active' : ''}`}
              onClick={() => {
                config.apply(value as never)
                setSection(null)
                setMenuOpen(false)
              }}
            >
              <span>{config.labels[value as never]}</span>
              {active && <CheckIcon size={12} />}
            </button>
          )
        })}
        {section === 'environment' && (
          <button className="filter-option disabled" disabled title="暂未接入 SSH 环境">
            <span>SSH</span>
            <span className="filter-option-tag">未接入</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="wordmark">
          <span className="wordmark-mark">π</span>
          <span className="wordmark-text">pi</span>
        </div>
        <div className="sidebar-head-actions">
          <button
            className={`icon-btn view-trigger ${menuOpen ? 'on' : ''} ${
              filtersActive ? 'has-filter' : ''
            }`}
            title="视图选项（分组 / 排序 / 环境）"
            onClick={() => {
              setMenuOpen((value) => !value)
              setSection(null)
            }}
          >
            <FilterIcon size={14} />
          </button>
          <button className="icon-btn" title="收起侧栏" onClick={onCollapse}>
            <PanelIcon size={14} />
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="sidebar-filter" ref={menuRef}>
          <button
            className={`filter-row ${section === 'environment' ? 'active' : ''}`}
            onClick={() => setSection('environment')}
          >
            <span>环境</span>
            <span className="filter-value">
              {ENVIRONMENT_LABELS[prefs.environment]}
              <ChevronIcon size={11} />
            </span>
          </button>
          <div className="filter-divider" />
          <button
            className={`filter-row ${section === 'group' ? 'active' : ''}`}
            onClick={() => setSection('group')}
          >
            <span>分组</span>
            <span className="filter-value">
              {GROUP_LABELS[prefs.group]}
              <ChevronIcon size={11} />
            </span>
          </button>
          <button
            className={`filter-row ${section === 'sort' ? 'active' : ''}`}
            onClick={() => setSection('sort')}
          >
            <span>排序</span>
            <span className="filter-value">
              {SORT_LABELS[prefs.sort]}
              <ChevronIcon size={11} />
            </span>
          </button>
          <div className="filter-divider" />
          <button
            className="filter-row"
            onClick={() => updatePrefs({ showEmptyGroups: !prefs.showEmptyGroups })}
          >
            <span>显示空分组</span>
            <span className={`filter-check ${prefs.showEmptyGroups ? 'on' : ''}`}>
              {prefs.showEmptyGroups && <CheckIcon size={11} />}
            </span>
          </button>
          <button
            className="filter-row disabled"
            disabled
            title="pi 会话没有 PR 元数据"
          >
            <span>显示 PR 状态</span>
            <span className="filter-option-tag">不支持</span>
          </button>
          {renderOptions()}
        </div>
      )}

      <div className="sidebar-actions">
        <button className="new-session" onClick={onNew}>
          <PlusIcon size={14} />
          <span>新建会话</span>
          <kbd>Ctrl N</kbd>
        </button>
      </div>

      <div className="session-list">
        {groups.length === 0 && (
          <div className="session-empty">
            {sessions.length === 0
              ? '还没有会话，发送第一条消息即可创建'
              : '没有符合当前筛选的会话'}
          </div>
        )}
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.key)
          const isExpanded = expanded.has(group.key) || group.searching
          const visible = isExpanded ? group.sessions : group.sessions.slice(0, PAGE_SIZE)
          const hidden = group.sessions.length - PAGE_SIZE
          const projectStatusValue = projectStatus[group.key] ?? 'active'
          return (
            <section key={group.key} className="project-group">
              {group.label && (
                <div className="project-head">
                  <button
                    className="project-toggle"
                    onClick={() => toggleCollapsed(group.key)}
                    title={group.cwd ?? group.label}
                  >
                    <ChevronIcon size={11} className={isCollapsed ? '' : 'open'} />
                    {group.cwd && <FolderIcon size={13} />}
                    <span className="project-name">{group.label}</span>
                  </button>
                  <div className="project-actions">
                    {group.cwd && (
                      <button
                        className="project-action"
                        title={`在 ${group.label} 新建会话`}
                        onClick={() => onNewInProject(group.cwd!)}
                      >
                        <PlusIcon size={13} />
                      </button>
                    )}
                    <button
                      className={`project-action ${searchKey === group.key ? 'on' : ''}`}
                      title={`搜索 ${group.label}`}
                      onClick={() => {
                        setSearchKey((value) => (value === group.key ? undefined : group.key))
                        setFilterKey(undefined)
                      }}
                    >
                      <SearchIcon size={12} />
                    </button>
                    <button
                      className={`project-action project-filter-trigger ${
                        filterKey === group.key ? 'on' : ''
                      }`}
                      title={`筛选 ${group.label}`}
                      onClick={() => {
                        setFilterKey((value) => (value === group.key ? undefined : group.key))
                        setSearchKey(undefined)
                      }}
                    >
                      <FilterIcon size={12} />
                    </button>
                  </div>
                </div>
              )}

              {searchKey === group.key && (
                <div className="project-search">
                  <SearchIcon size={12} />
                  <input
                    autoFocus
                    value={projectQueries[group.key] ?? ''}
                    onChange={(event) =>
                      setProjectQueries((prev) => ({ ...prev, [group.key]: event.target.value }))
                    }
                    placeholder={`搜索 ${group.label}`}
                    spellCheck={false}
                  />
                  {(projectQueries[group.key] ?? '') && (
                    <button
                      className="project-search-clear"
                      title="清空"
                      onClick={() =>
                        setProjectQueries((prev) => ({ ...prev, [group.key]: '' }))
                      }
                    >
                      <CloseIcon size={11} />
                    </button>
                  )}
                </div>
              )}

              {filterKey === group.key && (
                <div className="project-filter" ref={projectFilterRef}>
                  <div className="project-filter-head">筛选 {group.label}</div>
                  {STATUS_OPTIONS.map((value) => (
                    <button
                      key={value}
                      className={`filter-option ${projectStatusValue === value ? 'active' : ''}`}
                      onClick={() => {
                        setProjectStatus((prev) => ({ ...prev, [group.key]: value }))
                        setFilterKey(undefined)
                      }}
                    >
                      <span>{STATUS_LABELS[value]}</span>
                      {projectStatusValue === value && <CheckIcon size={12} />}
                    </button>
                  ))}
                </div>
              )}

              {!isCollapsed && (
                <div className="project-sessions">
                  {group.sessions.length === 0 && (
                    <div className="session-empty-group">暂无会话</div>
                  )}
                  {visible.map((session) => {
                    const isArchived = archived.has(session.path)
                    return (
                      <div
                        key={session.path}
                        className={`session-item ${session.path === activePath ? 'active' : ''} ${
                          isArchived ? 'archived' : ''
                        }`}
                        role="button"
                        tabIndex={0}
                        title={session.path}
                        onClick={() => onSelect(session)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onSelect(session)
                          }
                        }}
                      >
                        <div className="session-main">
                          <span className="session-title">{session.title}</span>
                          <span className="session-meta">
                            <span>{formatTime(session.updatedAt)}</span>
                            {isArchived && <span className="session-archived">已归档</span>}
                            {session.path === activePath && (
                              <span className="session-current">当前</span>
                            )}
                          </span>
                        </div>
                        <button
                          className="session-archive"
                          title={isArchived ? '取消归档' : '归档'}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleArchive(session.path)
                          }}
                        >
                          <ArchiveIcon size={12} />
                        </button>
                      </div>
                    )
                  })}
                  {hidden > 0 && !group.searching && (
                    <button className="show-more" onClick={() => toggleExpanded(group.key)}>
                      {isExpanded ? '收起' : `显示其余 ${hidden} 个`}
                    </button>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <button
          className="workspace"
          onClick={onChooseWorkspace}
          title={`${status.cwd}（切换目录并新建会话）`}
        >
          <FolderIcon size={14} />
          <span className="workspace-name">{baseName(status.cwd) || status.cwd}</span>
          <span className={`status-dot ${status.phase}`} />
        </button>
        <div className="status-line">
          <span>pi {STATUS_TEXT[status.phase]}</span>
          {status.model && <span className="status-model">{status.model.id}</span>}
        </div>
      </div>
    </aside>
  )
}

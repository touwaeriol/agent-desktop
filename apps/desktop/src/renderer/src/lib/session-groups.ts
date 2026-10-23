import type { Project, SessionSummary } from '@shared/types'

export type StatusFilter = 'active' | 'archived' | 'all'
export type EnvironmentFilter = 'all' | 'local'
export type GroupMode = 'folder' | 'date' | 'none'
export type SortMode = 'activity' | 'created' | 'name'

export interface Prefs {
  environment: EnvironmentFilter
  group: GroupMode
  sort: SortMode
  showEmptyGroups: boolean
  /** Hide sessions that belong to another project (or to none) while a project is active. */
  onlyActiveProject: boolean
}

export interface SessionGroup {
  key: string
  label: string
  cwd?: string
  sessions: SessionSummary[]
  total: number
  searching: boolean
  latest: number
  order: number
}

export function startOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dateGroup(value: number): { label: string; order: number } {
  const today = startOfDay(Date.now())
  const day = startOfDay(value)
  if (day === today) return { label: '今天', order: 0 }
  if (day === today - 86400000) return { label: '昨天', order: 1 }
  if (day > today - 86400000 * 7) return { label: '本周', order: 2 }
  return { label: '更早', order: 3 }
}

export function baseName(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** Windows compares paths case-insensitively; the same repo arrives with different casing. */
export function pathKey(dir: string): string {
  return /^[A-Za-z]:/.test(dir) || dir.includes('\\') ? dir.toLowerCase() : dir
}

interface GroupOptions {
  sessions: SessionSummary[]
  pinned: string[]
  prefs: Prefs
  archived: Set<string>
  projectStatus: Record<string, StatusFilter>
  projectQueries: Record<string, string>
  cwd: string
  activeProject?: Project
}

/** View policy shared by every grouping mode, independent of DOM and persisted preferences. */
export function buildSessionGroups({
  sessions, pinned, prefs, archived, projectStatus, projectQueries, cwd, activeProject
}: GroupOptions): SessionGroup[] {
  // A pinned session lives in the 置顶 block only: showing it again under its project made the
  // same conversation appear twice.
  const pinnedPaths = new Set(pinned)
  const belongsToProject = (dir: string): boolean =>
    Boolean(activeProject?.roots.some((root) => pathKey(root.path) === pathKey(dir)))
  const includeDirectory = (dir: string): boolean =>
    !prefs.onlyActiveProject || !activeProject || belongsToProject(dir)
  const visible = sessions.filter(
    (session) => !pinnedPaths.has(session.path) && includeDirectory(session.cwd || '')
  )
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
    if (visible.length === 0) return []
    const view = applyProjectView('none', visible)
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
    for (const session of visible) {
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
  // Sessions are keyed by repository, but a project groups several of them under one head so the
  // list reads as "the thing I am working on" instead of three unrelated folders.
  const projectKey = (dir: string): string => {
    if (!activeProject) return dir
    const needle = pathKey(dir)
    const belongs = activeProject.roots.some((root) => pathKey(root.path) === needle)
    return belongs ? 'project:' + activeProject.id : dir
  }
  for (const session of visible) {
    const key = projectKey(session.cwd || '')
    const list = folders.get(key) ?? []
    list.push(session)
    folders.set(key, list)
  }
  if (prefs.showEmptyGroups) {
    const known = new Set<string>([cwd])
    for (const session of visible) known.add(session.cwd || '')
    for (const key of known) {
      if (!includeDirectory(key)) continue
      const groupKey = projectKey(key)
      if (!folders.has(groupKey)) folders.set(groupKey, [])
    }
  }
  const result = [...folders.entries()].map(([cwd, list]) => {
    const isProject = cwd.startsWith('project:')
    const key = isProject ? cwd : `folder:${cwd}`
    const view = applyProjectView(key, list)
    const primary = isProject
      ? (activeProject?.roots.find((root) => root.primary) ?? activeProject?.roots[0])
      : undefined
    return {
      key,
      label: isProject
        ? `${activeProject?.name ?? '项目'} · ${activeProject?.roots.length ?? 0} 个仓库`
        : baseName(cwd) || '未命名目录',
      // "+ new session" and the branch badge use the primary repository.
      cwd: isProject ? (primary?.path ?? cwd) : cwd,
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
}

import { SerialQueue, writeJsonAtomic } from './storage'
/**
 * Projects: several repositories behind one conversation.
 *
 * A session is scoped to one git repository (`repo.ts`), which is what the sidebar groups by. A
 * project is the layer above: a named set of repository roots where exactly one is primary and
 * becomes the agent's working directory, the others stay reachable by absolute path.
 *
 * This module is the persisted half plus the system-prompt section that tells the model how to
 * work across the roots; wiring it into sessions, IPC and the UI happens elsewhere. Nothing here
 * touches pi, so it stays dependency-free (node builtins only).
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Project, ProjectRoot } from '../shared/types'

export type { Project, ProjectRoot }

interface ProjectFile {
  projects: Project[]
}

const EMPTY_ROOTS = '项目至少要有一个仓库'

/**
 * Windows compares paths case-insensitively, and the same directory reaches us with different
 * casing (a dialog, a shell, a persisted path), so every comparison goes through this key.
 */
function compareKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath
}

/** True when `dir` is `root` itself or nested under it; both are already resolved and keyed. */
function isInside(dir: string, root: string): boolean {
  if (dir === root) return true
  return dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/**
 * Exactly one root carries `primary: true`; the rest omit the flag so the JSON stays readable and
 * a hand-edited file cannot end up with two primaries.
 */
function withPrimary(roots: ProjectRoot[], index: number): ProjectRoot[] {
  return roots.map((root, at): ProjectRoot =>
    at === index ? { path: root.path, name: root.name, primary: true } : { path: root.path, name: root.name }
  )
}

/** The root flagged primary. Every list built here has one, so the fallback is only a safety net. */
function primaryOf(roots: ProjectRoot[]): ProjectRoot | undefined {
  return roots.find((root) => root.primary) ?? roots[0]
}

/**
 * Resolve, de-duplicate and pick the primary for a list of paths coming from the UI.
 *
 * `previous` keeps the display names and the primary flag of roots that survive an update: an
 * update that adds a repository must not silently rename the others or move the working directory.
 */
function normaliseRoots(paths: string[], primary: string | undefined, previous: ProjectRoot[]): ProjectRoot[] {
  const roots: ProjectRoot[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    if (!raw || !raw.trim()) continue
    const resolved = path.resolve(raw)
    const key = compareKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    const kept = previous.find((root) => compareKey(root.path) === key)
    roots.push({ path: resolved, name: kept?.name || path.basename(resolved) || resolved })
  }
  if (roots.length === 0) return []

  const wanted = primary && primary.trim() ? compareKey(path.resolve(primary)) : undefined
  const previousPrimary = previous.find((root) => root.primary)
  let index = wanted ? roots.findIndex((root) => compareKey(root.path) === wanted) : -1
  if (index < 0 && previousPrimary) {
    const keptKey = compareKey(previousPrimary.path)
    index = roots.findIndex((root) => compareKey(root.path) === keptKey)
  }
  return withPrimary(roots, index < 0 ? 0 : index)
}

/** Move the primary flag to `primary` without touching the rest of the list; unknown paths no-op. */
function movePrimary(roots: ProjectRoot[], primary: string): ProjectRoot[] {
  const wanted = compareKey(path.resolve(primary))
  const index = roots.findIndex((root) => compareKey(root.path) === wanted)
  return index < 0 ? roots : withPrimary(roots, index)
}

/** One persisted root, dropping anything that is not a usable path instead of failing the load. */
function readRoot(value: unknown): ProjectRoot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { path?: unknown; name?: unknown; primary?: unknown }
  if (typeof raw.path !== 'string' || !raw.path.trim()) return undefined
  const resolved = path.resolve(raw.path)
  const custom = typeof raw.name === 'string' && raw.name.trim() ? raw.name : undefined
  const name = custom || path.basename(resolved) || resolved
  return raw.primary === true ? { path: resolved, name, primary: true } : { path: resolved, name }
}

function readProject(value: unknown): Project | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as {
    id?: unknown
    name?: unknown
    roots?: unknown
    createdAt?: unknown
    updatedAt?: unknown
  }
  if (typeof raw.id !== 'string' || !raw.id) return undefined
  if (!Array.isArray(raw.roots)) return undefined

  const roots: ProjectRoot[] = []
  const seen = new Set<string>()
  for (const item of raw.roots) {
    const root = readRoot(item)
    if (!root) continue
    const key = compareKey(root.path)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(root)
  }
  if (roots.length === 0) return undefined

  const primaryIndex = roots.findIndex((root) => root.primary)
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : 0
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : (primaryOf(roots)?.name ?? raw.id),
    roots: withPrimary(roots, primaryIndex < 0 ? 0 : primaryIndex),
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt
  }
}

/**
 * Projects on disk. `list` / `get` / `findByPath` are synchronous views of the cache, so call
 * `load()` once at startup and before any mutation.
 */
export class ProjectStore {
  private readonly filePath: string
  private projects: Project[] | undefined
  private loading?: Promise<Project[]>
  private readonly mutations = new SerialQueue()

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath)
  }

  /** Reads the file once and caches it; missing/corrupt file means "no projects". */
  async load(): Promise<Project[]> {
    if (this.projects) return this.projects
    return (this.loading ??= this.read().then((projects) => {
      this.projects = projects
      return projects
    }))
  }

  list(): Project[] {
    return [...(this.projects ?? [])]
  }

  get(id: string): Project | undefined {
    return (this.projects ?? []).find((project) => project.id === id)
  }

  async create(input: { name: string; roots: string[]; primary?: string }): Promise<Project> {
    return this.mutations.run(async () => {
      await this.load()
      const roots = normaliseRoots(input.roots, input.primary, [])
      if (roots.length === 0) throw new Error(EMPTY_ROOTS)

      const now = Date.now()
      const project: Project = {
        id: `p_${randomBytes(6).toString('hex')}`,
        // The primary root's entry name is its basename, which is the default project name.
        name: input.name.trim() || (primaryOf(roots)?.name ?? ''),
        roots,
        createdAt: now,
        updatedAt: now
      }
      await this.commit([...(this.projects ?? []), project])
      return project
    })
  }

  async update(
    id: string,
    patch: { name?: string; roots?: string[]; primary?: string }
  ): Promise<Project | undefined> {
    return this.mutations.run(async () => {
      await this.load()
      const all = this.projects ?? []
      const current = all.find((project) => project.id === id)
      if (!current) return undefined

      let roots = current.roots
      if (patch.roots) roots = normaliseRoots(patch.roots, patch.primary, current.roots)
      else if (patch.primary) roots = movePrimary(current.roots, patch.primary)
      if (roots.length === 0) throw new Error(EMPTY_ROOTS)

      const next: Project = {
        ...current,
        name: patch.name?.trim() || current.name,
        roots,
        updatedAt: Date.now()
      }
      await this.commit(all.map((project) => (project.id === id ? next : project)))
      return next
    })
  }

  async remove(id: string): Promise<void> {
    return this.mutations.run(async () => {
      await this.load()
      const all = this.projects ?? []
      const rest = all.filter((project) => project.id !== id)
      if (rest.length === all.length) return
      await this.commit(rest)
    })
  }

  /** The project a directory belongs to; longest matching root wins. Case-insensitive on win32. */
  findByPath(dir: string): Project | undefined {
    const target = compareKey(path.resolve(dir))
    let match: { project: Project; length: number } | undefined
    for (const project of this.projects ?? []) {
      for (const root of project.roots) {
        const key = compareKey(root.path)
        if (!isInside(target, key)) continue
        // Roots of several projects can overlap (a repo inside a repo); the specific one is the
        // one the user meant, so the longest match replaces the shorter.
        if (!match || key.length > match.length) match = { project, length: key.length }
      }
    }
    return match?.project
  }

  private async read(): Promise<Project[]> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf8')
    } catch {
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
    if (!parsed || typeof parsed !== 'object') return []
    const list = (parsed as { projects?: unknown }).projects
    if (!Array.isArray(list)) return []
    const projects: Project[] = []
    for (const item of list) {
      const project = readProject(item)
      if (project) projects.push(project)
    }
    return projects
  }

  /** Persist first, then swap the cache: a failed write must not leave memory ahead of disk. */
  private async commit(projects: Project[]): Promise<void> {
    await this.write(projects)
    this.projects = projects
  }

  /** Atomically replace the file, sharing serialization with other storage writers. */
  private async write(projects: Project[]): Promise<void> {
    const payload: ProjectFile = { projects }
    await writeJsonAtomic(this.filePath, payload)
  }
}

/**
 * The system-prompt section for a multi-root project, or undefined when it has a single root
 * (one repository needs no explanation — that is just a normal session).
 */
export function renderProjectSection(project: Project): string | undefined {
  if (project.roots.length <= 1) return undefined
  const primary = primaryOf(project.roots)
  return [
    `当前项目「${project.name}」包含 ${project.roots.length} 个仓库，你的工作目录是主仓库 ${
      primary ? `${primary.name}（${primary.path}）` : '（未标记）'
    }：`,
    ...project.roots.map((root) =>
      root.primary ? `- ${root.name}（主仓库）  ${root.path}` : `- ${root.name}  ${root.path}`
    ),
    '',
    '跨仓库引用文件一律写绝对路径，不要按工作目录去推算相对路径，也不要把别的仓库当成子目录。',
    '每条 bash 命令都是新的 shell，cd 不会保留：要进哪个仓库就先 `cd <仓库路径> && …`。',
    '跨仓库搜索用 grep 工具的 `path` 参数指向仓库目录，不要用 `bash grep -rn` 扫整个磁盘。'
  ].join('\n')
}

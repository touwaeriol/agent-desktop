import { execFile } from 'node:child_process'
import path from 'node:path'

export interface RepoInfo {
  /** Absolute git toplevel; the session's working directory when it is inside a repo. */
  root: string
  name: string
  /** Whether `root` really is a git repository (false for a plain folder). */
  isRepo: boolean
  branch?: string
  remote?: string
  /** Number of uncommitted entries, when it could be read cheaply. */
  dirty?: number
}

/** A session belongs to one repository, so the lookup runs on every list refresh. */
const CACHE_TTL_MS = 5000
const cache = new Map<string, { at: number; info: RepoInfo }>()

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout.trim())
    )
  })
}

/** The repository a directory belongs to, or undefined when it is not inside one. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  if (!dir) return undefined
  const toplevel = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!toplevel) return undefined
  // Git prints forward slashes on Windows; the rest of the app compares paths as-is.
  return path.resolve(toplevel)
}

/**
 * Repository facts for one directory: the toplevel, its branch, remote and dirty count.
 *
 * Everything is best-effort — a folder that is not a repository, a missing `git` on PATH or a
 * repo with no commits yet all end up as `isRepo: false` or a missing field rather than an error,
 * because this runs behind the sidebar and must never break the window.
 */
export async function repoInfo(dir: string): Promise<RepoInfo> {
  const key = path.resolve(dir || '.')
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.info

  const fallback: RepoInfo = { root: key, name: path.basename(key) || key, isRepo: false }
  const root = await repoRoot(key)
  if (!root) {
    cache.set(key, { at: Date.now(), info: fallback })
    return fallback
  }
  const [branch, remote, status] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['config', '--get', 'remote.origin.url']),
    git(root, ['status', '--porcelain'])
  ])
  const info: RepoInfo = {
    root,
    name: path.basename(root) || root,
    isRepo: true,
    // A detached HEAD reports `HEAD`; show the short hash instead of a useless label.
    branch: branch === 'HEAD' ? (await git(root, ['rev-parse', '--short', 'HEAD'])) : branch,
    remote: remote || undefined,
    dirty: status === undefined ? undefined : status ? status.split('\n').length : 0
  }
  cache.set(key, { at: Date.now(), info })
  return info
}

export async function repoInfos(dirs: string[]): Promise<Record<string, RepoInfo>> {
  const unique = [...new Set(dirs.filter(Boolean).map((dir) => path.resolve(dir)))]
  const entries = await Promise.all(unique.map(async (dir) => [dir, await repoInfo(dir)] as const))
  return Object.fromEntries(entries)
}

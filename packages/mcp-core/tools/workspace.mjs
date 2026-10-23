/**
 * Root-aware file tools: the workspace's directories are a first-class argument.
 *
 * A session can cover several folders (a project's repositories). pi's own tools take absolute
 * paths, which works but makes the model responsible for never mixing them up — a relative path in
 * the wrong repository silently reads the wrong file. These tools take a `root` name plus a path
 * relative to it, and refuse anything that resolves outside that root, so a session can work across
 * folders without relying on a prompt convention.
 *
 * Only listed when the session really has more than one root (see `tools/index.mjs`): with one
 * directory, pi's own `read`/`grep` are better and these would just be duplicates.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_READ_BYTES = 96 * 1024
const MAX_MATCHES = 200
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'release',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.codegraph',
  '.serena',
  'coverage',
  '.venv',
  'venv',
  '__pycache__'
])

function roots() {
  const raw = process.env.AGENT_DESKTOP_ROOTS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((root) => root && typeof root.path === 'string' && root.path)
      .map((root) => ({
        name: String(root.name ?? path.basename(root.path)),
        path: path.resolve(root.path),
        primary: Boolean(root.primary)
      }))
  } catch {
    return []
  }
}

function rootListText() {
  return roots()
    .map((root) => `- ${root.name}${root.primary ? '（主目录）' : ''}  ${root.path}`)
    .join('\n')
}

/** The root named by the caller, or the primary one. */
function pickRoot(name) {
  const all = roots()
  if (all.length === 0) throw new Error('当前会话没有配置工作目录')
  if (name === undefined || name === null || String(name).trim() === '') {
    return all.find((root) => root.primary) ?? all[0]
  }
  const wanted = String(name).trim().toLowerCase()
  const byName = all.find((root) => root.name.toLowerCase() === wanted)
  if (byName) return byName
  const byPath = all.find((root) => root.path.toLowerCase() === path.resolve(String(name)).toLowerCase())
  if (byPath) return byPath
  throw new Error(`没有名为「${name}」的目录。可用目录：\n${rootListText()}`)
}

/** Resolve inside the root; anything that escapes it is refused rather than silently followed. */
function inside(root, relative) {
  const target = path.resolve(root.path, relative ?? '')
  const base = root.path.endsWith(path.sep) ? root.path : root.path + path.sep
  if (target !== root.path && !target.startsWith(base)) {
    throw new Error(`路径超出目录「${root.name}」的范围：${relative}`)
  }
  return target
}

function text(value) {
  return { content: [{ type: 'text', text: value }] }
}

function failure(error) {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
}

export const workspaceRoots = {
  name: 'workspace_roots',
  title: 'List the workspace directories',
  description:
    'List the directories this session works on: name, absolute path, and which one is the primary ' +
    'working directory. Other tools take these names as their `root` argument.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async call() {
    try {
      const all = roots()
      if (all.length === 0) return text('当前会话只有一个工作目录，没有额外目录。')
      return text(`这个会话覆盖 ${all.length} 个目录：\n${rootListText()}`)
    } catch (error) {
      return failure(error)
    }
  }
}

export const readFile = {
  name: 'read_file',
  title: 'Read a file in a workspace directory',
  description:
    'Read a text file from one of the workspace directories. `path` is relative to `root` (the ' +
    'directory name from workspace_roots); omit `root` for the primary directory. Paths that would ' +
    'escape the directory are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory name; omit for the primary directory.' },
      path: { type: 'string', description: 'Path relative to the directory.' },
      offset: { type: 'number', description: 'First line to return (1-based).' },
      limit: { type: 'number', description: 'Maximum number of lines.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  async call(args) {
    try {
      const root = pickRoot(args?.root)
      const target = inside(root, args?.path)
      const stat = await fs.stat(target)
      if (stat.isDirectory()) throw new Error(`${args?.path} 是目录，不是文件`)
      const buffer = await fs.readFile(target)
      const truncated = buffer.length > MAX_READ_BYTES
      const body = buffer.subarray(0, MAX_READ_BYTES).toString('utf8')
      const lines = body.split('\n')
      const from = Math.max(0, (Number(args?.offset) || 1) - 1)
      const to = args?.limit ? from + Number(args.limit) : lines.length
      const slice = lines.slice(from, to)
      const header = `${root.name}/${args?.path}（第 ${from + 1}-${from + slice.length} 行${
        truncated ? '，文件较大已截断' : ''
      }）`
      return text(`${header}\n${slice.map((line, index) => `${from + index + 1}\t${line}`).join('\n')}`)
    } catch (error) {
      return failure(error)
    }
  }
}

function runRipgrep(rootPath, pattern, glob, literal, ignoreCase) {
  return new Promise((resolve) => {
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '5000']
    if (literal) args.push('--fixed-strings')
    if (ignoreCase) args.push('--ignore-case')
    if (glob) args.push('--glob', glob)
    args.push(pattern, '.')
    execFile(
      'rg',
      args,
      { cwd: rootPath, maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
      (error, stdout) => {
        // Exit code 1 means "no matches", which is a normal answer rather than a failure.
        if (error && error.code !== 1) {
          resolve(undefined)
          return
        }
        resolve(stdout)
      }
    )
  })
}

async function walkMatches(rootPath, pattern, glob, literal, ignoreCase) {
  const matches = literal
    ? (line) => (ignoreCase ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern))
    : (() => {
        const expression = new RegExp(pattern, ignoreCase ? 'i' : '')
        return (line) => expression.test(line)
      })()
  const suffix = glob && !glob.includes('*') ? glob : glob?.replace(/^\*\*?\/?/, '')
  const hits = []
  const queue = [rootPath]
  while (queue.length > 0 && hits.length < MAX_MATCHES) {
    const dir = queue.pop()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (hits.length >= MAX_MATCHES) break
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full)
        continue
      }
      if (suffix && !entry.name.endsWith(suffix)) continue
      let body
      try {
        const stat = await fs.stat(full)
        if (stat.size > 2 * 1024 * 1024) continue
        body = await fs.readFile(full, 'utf8')
      } catch {
        continue
      }
      body.split('\n').forEach((line, index) => {
        if (hits.length >= MAX_MATCHES) return
        if (!matches(line)) return
        hits.push(`${path.relative(rootPath, full).split(path.sep).join('/')}:${index + 1}:${line.slice(0, 240)}`)
      })
    }
  }
  return hits.join('\n')
}

export const grepFiles = {
  name: 'grep_files',
  title: 'Search text inside a workspace directory',
  description:
    'Search file contents inside one workspace directory. `path`/`glob` narrow the search; results ' +
    'are paths relative to `root`. Uses ripgrep when it is available, so .gitignore is respected.',
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory name; omit for the primary directory.' },
      pattern: { type: 'string', description: 'Text or regular expression to find.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. *.ts.' },
      literal: { type: 'boolean', description: 'Treat the pattern as literal text.' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search.' },
      limit: { type: 'number', description: 'Maximum number of matches (default 200).' }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  async call(args) {
    try {
      const root = pickRoot(args?.root)
      const pattern = String(args?.pattern ?? '')
      if (!pattern) throw new Error('pattern 不能为空')
      const limit = Math.min(Number(args?.limit) || MAX_MATCHES, MAX_MATCHES)
      const fromRg = await runRipgrep(root.path, pattern, args?.glob, args?.literal, args?.ignoreCase)
      const raw =
        fromRg === undefined
          ? await walkMatches(root.path, pattern, args?.glob, args?.literal, args?.ignoreCase)
          : fromRg
      const lines = raw.split('\n').filter(Boolean)
      if (lines.length === 0) return text(`在「${root.name}」里没有匹配 ${pattern} 的内容`)
      const shown = lines
        .slice(0, limit)
        .map((line) => line.replace(/^\.\//, '').slice(0, 320))
        .join('\n')
      const more = lines.length > limit ? `\n…共 ${lines.length} 条，只显示前 ${limit} 条` : ''
      return text(`「${root.name}」的匹配（${Math.min(lines.length, limit)} 条）：\n${shown}${more}`)
    } catch (error) {
      return failure(error)
    }
  }
}

export const workspaceTools = [workspaceRoots, readFile, grepFiles]

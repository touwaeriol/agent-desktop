import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SessionSummary } from '../shared/types'

import { profileSessionDir } from './profile'

const MAX_FILES = 80
const HEAD_BYTES = 96 * 1024
async function collectFiles(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 3 || out.length > MAX_FILES * 4) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(full, depth + 1, out)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full)
    }
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text?: unknown }).text ?? '')
        }
        return ''
      })
      .join(' ')
  }
  return ''
}

/** Read the head of one session file: cwd, title (or first user message) and timestamps. */
export async function readSummary(file: string): Promise<SessionSummary | null> {
  let handle
  try {
    const stat = await fs.stat(file)
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const lines = text.split('\n')
    let cwd = ''
    let title = ''
    let fallback = ''
    let createdAt = 0
    for (const line of lines) {
      if (!line.trim()) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type === 'session') {
        if (typeof entry.cwd === 'string') cwd = entry.cwd
        if (typeof entry.timestamp === 'string') {
          const parsed = Date.parse(entry.timestamp)
          if (!Number.isNaN(parsed)) createdAt = parsed
        }
      }
      if (entry.type === 'header') {
        const workspace = entry.workspace as { primary?: string } | undefined
        if (typeof workspace?.primary === 'string') cwd = workspace.primary
      }
      if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
        title = entry.name.trim()
      }
      if (!fallback && entry.message) {
        const message = entry.message as Record<string, unknown>
        if (message.role === 'user' && !message.customType) {
          const textContent = textOfContent(message.content).replace(/\s+/g, ' ').trim()
          if (textContent) fallback = textContent
        }
      }
    }
    return {
      path: file,
      title: title || fallback || path.basename(file, '.jsonl'),
      cwd,
      createdAt: createdAt || stat.birthtimeMs || stat.mtimeMs,
      updatedAt: stat.mtimeMs
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function listSessions(rootDir: string = profileSessionDir()): Promise<SessionSummary[]> {
  const files: string[] = []
  await collectFiles(rootDir, 0, files)
  const stats = await Promise.all(
    files.map(async (file) => {
      try {
        const stat = await fs.stat(file)
        return { file, mtime: stat.mtimeMs }
      } catch {
        return null
      }
    })
  )
  const newest = stats
    .filter((item): item is { file: string; mtime: number } => item !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES)

  const summaries = await Promise.all(newest.map((item) => readSummary(item.file)))
  return summaries
    .filter((item): item is SessionSummary => item !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

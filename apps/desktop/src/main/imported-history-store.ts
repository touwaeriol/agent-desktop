import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { readTextFile, removeStoredFile, updateJsonFile, writeJsonAtomic } from './storage'
import type { HistoryMessage } from './agent/history'

/** App-owned imported history; native engines remain responsible for their normal sessions. */
export class ImportedHistoryStore implements SessionStore {
  constructor(private readonly dir: string) {}
  private folder(sessionId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('无效的原生会话 ID')
    return path.join(this.dir, sessionId)
  }
  private file(key: SessionKey): string {
    const name = key.subpath ? 'sub-' + createHash('sha256').update(key.subpath).digest('hex') : 'main'
    return path.join(this.folder(key.sessionId), name + '.json')
  }
  async owns(sessionId: string): Promise<boolean> {
    try { await fs.access(path.join(this.folder(sessionId), 'main.json')); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const incoming = structuredClone(entries)
    await updateJsonFile<{ entries: SessionStoreEntry[]; subpath?: string }>(this.file(key), { entries: [] }, (current) => {
      const byId = new Map(current.entries.flatMap((entry, index) => entry.uuid ? [[entry.uuid, index] as const] : []))
      const next = [...current.entries]
      for (const entry of incoming) {
        const index = entry.uuid ? byId.get(entry.uuid) : undefined
        if (index !== undefined) next[index] = entry
        else { if (entry.uuid) byId.set(entry.uuid, next.length); next.push(entry) }
      }
      return { entries: next, ...(key.subpath ? { subpath: key.subpath } : {}) }
    })
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    try { return JSON.parse(await readTextFile(this.file(key))).entries }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async listSubkeys(key: { sessionId: string; projectKey: string }): Promise<string[]> {
    const dir = this.folder(key.sessionId)
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const subkeys: string[] = []
    for (const name of names.filter((name) => /^sub-[a-f0-9]+\.json$/.test(name))) {
      const record = JSON.parse(await readTextFile(path.join(dir, name)))
      if (typeof record.subpath === 'string') subkeys.push(record.subpath)
    }
    return subkeys
  }
  async delete(key: SessionKey): Promise<void> {
    if (key.subpath) { await removeStoredFile(this.file(key)); return }
    const dir = this.folder(key.sessionId)
    const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[]
      throw error
    })
    for (const name of names) {
      if (name === 'main.json' || name === 'prefix.json' || /^sub-[a-f0-9]+\.json$/.test(name))
        await removeStoredFile(path.join(dir, name))
    }
  }
  async savePrefix(sessionId: string, messages: HistoryMessage[]): Promise<void> {
    await writeJsonAtomic(path.join(this.folder(sessionId), 'prefix.json'), messages)
  }
  async loadPrefix(sessionId: string): Promise<HistoryMessage[]> {
    try { return JSON.parse(await readTextFile(path.join(this.folder(sessionId), 'prefix.json'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
}

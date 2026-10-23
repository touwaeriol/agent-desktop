import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Serializes mutations without poisoning the queue when an operation fails. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }
}

const files = new Map<string, Promise<unknown>>()
function serialize<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(file)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const result = (files.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
  files.set(key, result)
  const cleanup = (): void => { if (files.get(key) === result) files.delete(key) }
  void result.then(cleanup, cleanup)
  return result
}

async function replaceFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await fs.writeFile(temporary, content, 'utf8')
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Snapshot at call time; later writes to the same path always finish last. */
export function writeTextAtomic(file: string, content: string): Promise<void> {
  const target = path.resolve(file)
  return serialize(target, () => replaceFile(target, content))
}
export function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  return writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

/** Reading and merging belong to the same transaction, not just the final write. */
export function updateJsonFile<T extends object>(
  file: string, fallback: T, update: (current: T) => T
): Promise<void> {
  const target = path.resolve(file)
  return serialize(target, async () => {
    let current = fallback
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(target, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as T
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await replaceFile(target, JSON.stringify(update(current), null, 2) + '\n')
  })
}

/** Reads and removals share write ordering so saved sessions cannot reappear after deletion. */
export function readTextFile(file: string): Promise<string> {
  const target = path.resolve(file)
  return serialize(target, () => fs.readFile(target, 'utf8'))
}
export function removeStoredFile(file: string): Promise<void> {
  const target = path.resolve(file)
  return serialize(target, () => fs.rm(target, { force: true }))
}

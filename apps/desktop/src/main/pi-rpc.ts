import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'

const PI_RELATIVE = path.join(
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'bundle',
  'cli.js'
)

export function findBundledCli(): string | undefined {
  if (process.env.PI_CLI_PATH) return process.env.PI_CLI_PATH
  const starts = [
    path.join(process.resourcesPath, 'app.asar.unpacked'),
    path.join(process.resourcesPath, 'app.asar'),
    path.dirname(process.execPath),
    process.cwd(),
    __dirname
  ]
  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 7; depth += 1) {
      const candidate = path.join(dir, PI_RELATIVE)
      if (existsSync(candidate)) return candidate
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

function resolvePi(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const cli = findBundledCli()
  if (cli) {
    return {
      command: process.execPath,
      args: [cli],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
  }
  console.warn('[pi-rpc] bundled pi not found, falling back to pi on PATH')
  return {
    command: process.platform === 'win32' ? 'pi.cmd' : 'pi',
    args: [],
    env: {}
  }
}

interface Pending {
  resolve: (record: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class PiRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private pending = new Map<string, Pending>()
  private seq = 0
  private stderr = ''

  get running(): boolean {
    return this.child !== null
  }

  get stderrTail(): string {
    return this.stderr.slice(-4000)
  }

  start(cwd: string, extraArgs: string[] = []): void {
    this.stop()
    const pi = resolvePi()
    console.log('[pi-rpc] spawning', pi.command, [...pi.args, '--mode', 'rpc', ...extraArgs], 'cwd=', cwd)
    this.stderr = ''
    this.buffer = ''
    const child = spawn(pi.command, [...pi.args, '--mode', 'rpc', ...extraArgs], {
      cwd,
      env: { ...process.env, ...pi.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-10000)
      process.stderr.write(`[pi] ${chunk}`)
      this.emit('stderr', chunk)
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      console.error('[pi-rpc] spawn failed:', error.message)
      this.child = null
      this.failAll(error)
      this.emit('exit', { error: error.message })
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      console.warn(`[pi-rpc] exited code=${code} signal=${signal}`)
      this.child = null
      this.failAll(new Error(`pi exited (${code ?? signal})`))
      this.emit('exit', { code, signal })
    })
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (!child) return
    console.log('[pi-rpc] stop requested, pid=', child.pid)
    this.failAll(new Error('pi stopped'))
    try {
      child.stdin.end()
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!child.killed) child.kill()
    }, 1500)
  }

  request<T = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 60000
  ): Promise<T> {
    const child = this.child
    if (!child) return Promise.reject(new Error('pi is not running'))
    const id = `req-${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`pi request timed out: ${type}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (record) => resolve(record as T),
        reject,
        timer
      })
      child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`)
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim()) this.onRecord(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private onRecord(line: string): void {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    const id = typeof record.id === 'string' ? record.id : undefined
    if (record.type === 'response' && id && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (record.success === false) {
        pending.reject(new Error(String(record.error ?? 'pi command failed')))
      } else {
        pending.resolve(record)
      }
      return
    }
    this.emit('event', record)
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

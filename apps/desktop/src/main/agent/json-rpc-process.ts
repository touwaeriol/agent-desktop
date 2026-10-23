import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { killTree } from '../proc'
export class JsonRpcProcess {
  private child?: ChildProcessWithoutNullStreams
  private nextId = 0
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  stderr = ''
  constructor(
    private readonly notify: (method: string, params: any) => void,
    private readonly requested: (method: string, params: any) => Promise<unknown>,
    private readonly exited: (error: string) => void
  ) {}
  start(command: string, args: string[], cwd: string, env = process.env): void {
    this.stop()
    this.stderr = ''
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: 'pipe' })
    this.child = child
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      buffer += chunk
      let i: number
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        let m: any
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (!m || typeof m !== 'object') continue
        if (m.method && m.id !== undefined) {
          void this.requested(m.method, m.params).then(
            (result) => this.write({ id: m.id, result }, child),
            (error) =>
              this.write({ id: m.id, error: { code: -32603, message: String(error) } }, child)
          )
        } else if (m.method) this.notify(m.method, m.params)
        else {
          const p = this.pending.get(m.id)
          if (!p) continue
          clearTimeout(p.timer)
          this.pending.delete(m.id)
          if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)))
          else p.resolve(m.result)
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4000)
    })
    child.stdin.on('error', () => undefined)
    const fail = (message: string): void => {
      if (this.child !== child) return
      this.child = undefined
      this.rejectAll(message)
      this.exited(message)
    }
    child.on('error', (error) => fail(error.message))
    child.on('close', (code) => fail('引擎连接关闭 (' + code + ') ' + this.stderr.slice(-300)))
  }
  private write(value: unknown, child = this.child): void {
    if (!child || child !== this.child || child.stdin.destroyed) return
    child.stdin.write(JSON.stringify(value) + '\n')
  }
  request<T = any>(method: string, params: unknown = {}, timeout = 30_000): Promise<T> {
    if (!this.child) return Promise.reject(new Error('引擎未连接'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(method + ' 超时'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  notification(method: string, params?: unknown): void {
    this.write({ method, params })
  }
  private rejectAll(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    this.pending.clear()
  }
  stop(): void {
    const child = this.child
    this.child = undefined
    if (child) killTree(child, true)
    this.rejectAll('引擎连接已停止')
  }
}

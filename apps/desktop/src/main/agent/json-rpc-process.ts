import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { killTree } from '../proc'
import { createJsonLineDecoder } from '../json-lines'
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
    const decode = createJsonLineDecoder((record) => {
      if (this.child === child) this.onRecord(record, child)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child === child) decode(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (this.child !== child) return
      this.stderr = (this.stderr + String(chunk)).slice(-4000)
    })
    const fail = (message: string): void => {
      if (this.child !== child) return
      this.child = undefined
      if (child.exitCode === null && child.signalCode === null) killTree(child)
      this.rejectAll(message)
      this.exited(message)
    }
    child.stdin.on('error', (error) => fail(error.message))
    child.on('error', (error) => fail(error.message))
    child.on('close', (code) => fail('引擎连接关闭 (' + code + ') ' + this.stderr.slice(-300)))
  }
  private onRecord(message: Record<string, any>, child: ChildProcessWithoutNullStreams): void {
    if (message.method) {
      if (message.id === undefined) {
        this.notify(message.method, message.params)
        return
      }
      void Promise.resolve()
        .then(() => child === this.child ? this.requested(message.method, message.params) : undefined)
        .then(
          (result) => this.write({ id: message.id, result }, child),
          (error) =>
            this.write({ id: message.id, error: { code: -32603, message: String(error) } }, child)
        )
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error)
      pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
    else pending.resolve(message.result)
  }
  private write(value: unknown, child = this.child): void {
    if (!child || child !== this.child || child.stdin.destroyed) return
    child.stdin.write(JSON.stringify(value) + '\n')
  }
  request<T = any>(method: string, params: unknown = {}, timeout = 30_000): Promise<T> {
    if (!this.child || this.child.stdin.destroyed) return Promise.reject(new Error('引擎未连接'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(method + ' 超时'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
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

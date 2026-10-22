import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

/**
 * Kill a child process and everything it spawned.
 *
 * `child.kill()` only signals the direct child. On Windows that leaves the grandchildren alive —
 * pi starts its MCP servers as stdio children, and the CodeGraph CLI spawns its own worker — so a
 * normal quit would strand them. `taskkill /T` walks the tree.
 */
export function killTree(child: ChildProcess, sync = false): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/T', '/F']
    if (sync) {
      try {
        execFileSync('taskkill', args, { stdio: 'ignore', windowsHide: true })
      } catch {
        // already gone
      }
      return
    }
    try {
      spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).on('error', () => undefined)
    } catch {
      // taskkill missing: fall back to the direct signal
      try {
        child.kill()
      } catch {
        // ignore
      }
    }
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // ignore
  }
}

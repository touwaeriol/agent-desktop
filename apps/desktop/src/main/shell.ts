import { existsSync } from 'node:fs'
import path from 'node:path'

/** The WSL App Execution Alias never returns when no distribution is installed. */
function isWslStub(candidate: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(candidate)
}

function isRealBash(candidate: string): boolean {
  if (isWslStub(candidate)) return false
  try {
    return existsSync(candidate)
  } catch {
    return false
  }
}

/**
 * A Git for Windows `bash.exe`, or undefined when this is not Windows or Git is not installed.
 *
 * `bin\bash.exe` comes first: it is the launcher that sets up the MSYS environment, while
 * `usr\bin\bash.exe` is the raw one. `git.exe` on PATH (`…\Git\cmd`) points at the same install.
 */
function findGitBash(): string | undefined {
  const candidates: string[] = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    candidates.push(
      path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
      path.join(local, 'Programs', 'Git', 'usr', 'bin', 'bash.exe')
    )
  }
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const root = process.env[key]
    if (!root) continue
    candidates.push(
      path.join(root, 'Git', 'bin', 'bash.exe'),
      path.join(root, 'Git', 'usr', 'bin', 'bash.exe')
    )
  }
  for (const entry of (process.env.PATH ?? '').split(';')) {
    const dir = entry.trim()
    if (!dir) continue
    candidates.push(
      path.join(dir, 'bash.exe'),
      path.join(dir, '..', 'bin', 'bash.exe'),
      path.join(dir, '..', 'usr', 'bin', 'bash.exe')
    )
  }
  return candidates.find(isRealBash)
}

/**
 * Put a real bash in front of the pi child's PATH.
 *
 * pi resolves `bash.exe` with `where`: Git under `%ProgramFiles%` first, then whatever PATH offers.
 * Git installed anywhere else (per-user, another drive) leaves the `WindowsApps` alias as the first
 * hit — the WSL launcher, which hangs forever when no distribution is installed. Every bash call
 * then dies with "Command timed out after N seconds", `echo hi` included, and the transcript gives
 * no hint that the shell itself never started.
 *
 * An explicit `shellPath` in settings.json still wins: pi checks it before touching PATH.
 */
/** Absolute path of the Git Bash that {@link withRealBash} puts on PATH, when one exists. */
export function realBashPath(): string | undefined {
  return process.platform === 'win32' ? findGitBash() : undefined
}

export function withRealBash(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return env
  const bash = findGitBash()
  if (!bash) return env
  const dir = path.dirname(bash)
  // The child inherits `process.env`, so the PATH to extend is that one — `env` only carries the
  // extra variables the caller wants to add.
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'Path'
  const entries = (process.env[key] ?? '').split(';').filter(Boolean)
  if (entries[0]?.toLowerCase() === dir.toLowerCase()) return env
  const rest = entries.filter((entry) => entry.toLowerCase() !== dir.toLowerCase())
  const overrides: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    // One casing only: `PATH` and `Path` in the same block is a coin toss on Windows.
    if (name.toLowerCase() !== 'path') overrides[name] = value
  }
  overrides[key] = [dir, ...rest].join(';')
  return overrides
}

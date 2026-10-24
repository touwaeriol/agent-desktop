import type { AgentEngine } from './engine'

/**
 * A session switch replaces the engine — a new session is a new process/transcript, and opening
 * another conversation disposes the current one — so a running turn would be killed with it.
 *
 * The window asks the user before passing `stop`; this only decides what to do once it has. Without
 * consent the switch is refused instead of silently dropping work mid-turn, and an engine that will
 * not settle after `abort` is stopped so the switch cannot hang on it.
 */
export async function idleBeforeSwitch(
  engine: Pick<AgentEngine, 'busy' | 'abort' | 'stop' | 'waitForSettle'>,
  stop: boolean,
  settleMs = 3000
): Promise<void> {
  if (!engine.busy()) return
  if (!stop) throw new Error('当前回合仍在运行：停止它才能切换会话')
  try {
    await engine.abort()
  } catch {
    engine.stop()
    return
  }
  await engine.waitForSettle(settleMs)
}

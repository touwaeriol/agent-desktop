import type { AgentEngine } from './engine'

/**
 * A running engine is normally parked when the window switches sessions (see `parkEngine`), so this
 * is only the fallback for a run that has no session file yet and therefore cannot be reopened.
 *
 * With `stop` it aborts the turn and waits for it to settle; an engine that refuses to abort is
 * stopped so the switch cannot hang on it. Without `stop` the switch is refused rather than
 * silently dropping work mid-turn.
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

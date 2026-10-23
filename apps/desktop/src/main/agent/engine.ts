import type { PiStatus, PromptImage, PromptResult } from '@shared/types'

/**
 * What the window needs from an agent engine.
 *
 * The desktop app is moving to "our own agent, with a swappable engine underneath". pi is engine #1
 * and the only implementation so far; this file is the contract it has to satisfy, so a second
 * engine can be added without touching the window or the IPC layer.
 *
 * Deliberately narrow: an engine runs turns against a session, owns the run state (`busy` /
 * `compacting`, which is what unblocks the message queue), and exposes the raw request channel.
 * Everything that is app policy — MCP servers, `/btw` forks, compaction thresholds, speed tiers,
 * config, profiles — stays in the app, not in the engine.
 */
export interface AgentEngine {
  /** Stable id, shown in diagnostics; `pi` for the current implementation. */
  readonly id: string

  /** Run state as the window sees it. The app decorates this before broadcasting. */
  state(): PiStatus
  /** True from `agent_start` until `agent_settled`; compaction counts as busy. */
  busy(): boolean
  /** True while the context is being rewritten; prompts are refused meanwhile. */
  compacting(): boolean
  /** True while the child process is alive. */
  running(): boolean
  /** Last few KB of the child's stderr, for error reporting. */
  stderrTail(): string

  /** Start (or restart) the session; resolves once the engine answers `get_state`. */
  start(cwd?: string, extraArgs?: string[]): Promise<PiStatus>
  /** True while a start is in flight, so a restart never runs over it. */
  starting(): boolean
  stop(): void
  /** Kill without the grace period, for app shutdown. */
  dispose(): void

  /**
   * Run one turn, absorbing the moments where the window and the engine disagree about "busy":
   * waiting out a compaction, retrying, and turning a refusal into a queued follow-up.
   *
   * This is the only send path; callers must not wrap it in a second retry loop.
   */
  prompt(
    message: string,
    options?: { behavior?: 'steer' | 'followUp'; images?: PromptImage[] }
  ): Promise<PromptResult>

  /** Raw command channel; `type` is the engine's own command name. */
  request<T = Record<string, unknown>>(
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T>

  /** Re-read the run state from the engine (authoritative `busy`). */
  refresh(): Promise<void>
  /** Merge a patch into the state the window sees. */
  setStatus(patch: Partial<PiStatus>): void
  /** Resolves true when the current run settles, false on timeout. */
  waitForSettle(timeoutMs: number): Promise<boolean>
  /** Resolves true once the engine reports no run and no compaction. */
  waitForIdle(timeoutMs: number): Promise<boolean>
}

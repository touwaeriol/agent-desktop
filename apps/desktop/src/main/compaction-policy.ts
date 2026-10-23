/** One policy for the engine callback, settings UI and persisted token thresholds. */
export const DEFAULT_COMPACTION_RATIO = 0.9

export function compactionRatio(ratio?: number): number {
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 && ratio < 1
    ? ratio
    : DEFAULT_COMPACTION_RATIO
}

export function reserveFor(contextWindow: number, ratio: number): number {
  return Math.max(1000, Math.round(contextWindow * (1 - ratio)))
}

export function ratioFromPercent(percent: number): number {
  const value = Math.round(Number(percent))
  if (!Number.isFinite(value) || value < 10 || value > 99)
    throw new Error('自动压缩阈值要在 10% 和 99% 之间')
  return value / 100
}

export function ratioFromTokens(tokens: number, contextWindow?: number): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0)
    throw new Error('当前模型没有上下文窗口信息，无法换算阈值')
  if (!Number.isFinite(tokens) || tokens <= 0)
    throw new Error('自动压缩 token 阈值必须是正数')
  return Math.min(0.99, Math.max(1000, Math.round(tokens)) / contextWindow)
}

/** Retain sub-percent thresholds without exposing floating-point display noise. */
export function compactionPercent(ratio: number): number {
  return Number((ratio * 100).toPrecision(12))
}

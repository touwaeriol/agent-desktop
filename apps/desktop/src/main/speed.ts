import type { PiModel, PiSpeedState, SpeedMode } from '@shared/types'

/**
 * Which processing tiers a model actually accepts.
 *
 * Both vendors expose this as a request-level knob, and both refuse the request when the tier is
 * not available for that model, so the window has to know before it offers the switch:
 *
 * - OpenAI: `service_tier` — `fast` (formerly `priority`, same behaviour, up to ~2.5× faster) works
 *   broadly; `ultrafast` only exists for GPT-6 Astra / GPT-6.1 Sol.
 * - Anthropic: `speed: "fast"` plus the `fast-mode-2026-02-01` beta header, and only on Claude
 *   Opus 5.5 / Opus 5 / Opus 4.8 — on Opus 4.7 it is an error, on Opus 4.6 it silently runs at
 *   standard speed.
 */
const ULTRAFAST_MODELS = /^(gpt-6-astra|gpt-6\.1-sol)$/i
const FAST_OPUS = /^claude-opus-(5-5|5|4-8)(-|$)/i

export function speedSupport(model?: PiModel): { available: SpeedMode[]; note?: string } {
  if (!model) return { available: ['standard'], note: '先选择一个模型' }
  const api = model.api ?? ''

  // Keyed on the provider, not on the wire API: DeepSeek, Moonshot, Z.AI and friends all speak
  // `openai-completions`, but `service_tier` is an OpenAI-platform concept they do not implement.
  if (model.provider === 'openai' && api.startsWith('openai')) {
    return ULTRAFAST_MODELS.test(model.id)
      ? { available: ['standard', 'fast', 'ultrafast'] }
      : {
          available: ['standard', 'fast'],
          note: '极速（ultrafast）只支持 gpt-6-astra 和 gpt-6.1-sol'
        }
  }

  if (model.provider === 'anthropic' && api === 'anthropic-messages') {
    return FAST_OPUS.test(model.id)
      ? { available: ['standard', 'fast'] }
      : {
          available: ['standard'],
          note: 'Claude 快速模式只支持 Opus 5.5 / Opus 5 / Opus 4.8'
        }
  }

  return { available: ['standard'], note: '该服务商没有速度档位' }
}

/** Falls back to `standard` whenever the saved mode is not offered by the active model. */
export function resolveSpeedMode(model: PiModel | undefined, mode: SpeedMode): SpeedMode {
  const { available } = speedSupport(model)
  return available.includes(mode) ? mode : 'standard'
}

export function speedState(model: PiModel | undefined, mode: SpeedMode): PiSpeedState {
  const support = speedSupport(model)
  return { mode: resolveSpeedMode(model, mode), ...support }
}

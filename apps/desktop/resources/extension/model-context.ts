import type { AnyModel, Provider } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// pi-ai 1.4.0 advertises 272K for these OpenAI chat models. Their published
// context window is 1,050,000; 272K is the long-context *pricing* threshold.
// Sources: https://developers.openai.com/api/docs/models/gpt-6-astra
//          https://developers.openai.com/api/docs/models/gpt-6-luna
//          https://developers.openai.com/api/docs/models/gpt-6-sol
//          https://developers.openai.com/api/docs/models/gpt-6.1-sol
// Do not infer limits for other providers (especially openai-codex), classifiers,
// future models, or account-specific subscription endpoints from these API specs.
const OPENAI_LONG_CONTEXT_MODELS = new Set([
  'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'
])

/** Correct the builtin layer only; models.json remains the topmost user policy. */
export function withModelContextCorrections(provider: Provider): Provider {
  if (provider.id !== 'openai') return provider
  const correct = <T extends AnyModel>(model: T): T => {
    if ((model.type ?? 'chat') !== 'chat' || model.provider !== 'openai' ||
        !OPENAI_LONG_CONTEXT_MODELS.has(model.id) ||
        !('contextWindow' in model) || model.contextWindow !== 272_000) return model
    // Copy, never mutate the SDK catalog. Preserve output limits, tiered costs,
    // thinking maps, protocol capabilities and any future SDK fields.
    return { ...model, contextWindow: 1_050_000 }
  }
  return {
    ...provider,
    getModels: () => provider.getModels().map(correct),
    getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).map(correct)
  }
}

/**
 * Start below user overlays, not from the already-composed application's provider.
 * A bare runtime retains the SDK's remote-catalog refresh/auth/transport behavior;
 * wrapping its accessors also corrects old catalogs restored from cache later.
 * No credential or models files are written and no network refresh is requested.
 */
export async function createContextProvider(authPath?: string): Promise<Provider> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const baseline = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false })
  const provider = baseline.getProvider('openai')
  if (!provider) throw new Error('SDK 缺少 OpenAI 模型目录')
  return withModelContextCorrections(provider)
}

/** Also loaded by desktop-owned pi processes, even with MCP disabled. */
export default function modelContext(pi: ExtensionAPI): void {
  // Wait until queued user extension registrations have been applied. A native
  // registration clears a legacy registerProvider(name, config) layer in pi;
  // never replace a provider owned by another extension, regardless of load order.
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.modelRegistry.getRegisteredProviderConfig('openai') ||
        ctx.modelRegistry.getRegisteredNativeProvider('openai')) return
    pi.registerProvider(await createContextProvider())
  })
}

import { useMemo, useState } from 'react'
import {
  CheckIcon,
  CloseIcon,
  ExternalIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon
} from './Icons'

const API_TYPES = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations',
  'azure-openai-responses',
  'openai-codex-responses',
  'bedrock-converse-stream',
  'google-vertex',
  'pi-messages'
]

interface RawProvider {
  [key: string]: unknown
}

interface ProviderRow {
  id: string
  name: string
  baseUrl: string
  api: string
  apiKey: string
  models: Record<string, unknown>[]
  raw: RawProvider
}

interface ModelDraft {
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  reasoning: boolean
  raw?: Record<string, unknown>
}

interface ProviderDraft {
  originalId?: string
  id: string
  name: string
  baseUrl: string
  api: string
  apiKey: string
  models: ModelDraft[]
}

function emptyModel(): ModelDraft {
  return { id: '', name: '', contextWindow: '', maxTokens: '', reasoning: false }
}

function toDraft(provider: ProviderRow): ProviderDraft {
  return {
    originalId: provider.id,
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey,
    models:
      provider.models.length > 0
        ? provider.models.map((model) => ({
            id: typeof model.id === 'string' ? model.id : '',
            name: typeof model.name === 'string' ? model.name : '',
            contextWindow:
              typeof model.contextWindow === 'number' ? String(model.contextWindow) : '',
            maxTokens: typeof model.maxTokens === 'number' ? String(model.maxTokens) : '',
            reasoning: Boolean(model.reasoning),
            raw: model
          }))
        : [emptyModel()]
  }
}

export function CustomProvidersPanel({
  filePath,
  content,
  dirty,
  builtinIds,
  onChange,
  onSave,
  onReload,
  onOpenFile
}: {
  filePath: string
  content: string
  dirty: boolean
  builtinIds: Set<string>
  onChange: (content: string) => void
  onSave: (content: string) => Promise<void>
  onReload: () => void
  onOpenFile: () => void
}) {
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [draft, setDraft] = useState<ProviderDraft>()
  const [editorError, setEditorError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [saving, setSaving] = useState(false)

  const parsed = useMemo(() => {
    try {
      const data = JSON.parse(content) as Record<string, unknown>
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('顶层必须是 JSON 对象')
      }
      const providersRaw =
        data.providers && typeof data.providers === 'object'
          ? (data.providers as Record<string, unknown>)
          : {}
      const list: ProviderRow[] = Object.entries(providersRaw).map(([id, value]) => {
        const raw = (value && typeof value === 'object' ? value : {}) as RawProvider
        return {
          id,
          name: typeof raw.name === 'string' ? raw.name : '',
          baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
          api: typeof raw.api === 'string' ? raw.api : '',
          apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
          models: Array.isArray(raw.models) ? (raw.models as Record<string, unknown>[]) : [],
          raw
        }
      })
      return { data, list, error: undefined }
    } catch (cause) {
      return {
        data: null,
        list: [] as ProviderRow[],
        error: cause instanceof Error ? cause.message : String(cause)
      }
    }
  }, [content])

  const applyContent = async (nextContent: string): Promise<void> => {
    onChange(nextContent)
    setSaving(true)
    await onSave(nextContent)
    setSaving(false)
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    const id = draft.id.trim()
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      setEditorError('服务商 ID 只能包含字母、数字、下划线和短横线')
      return
    }
    const isBuiltin = builtinIds.has(id)
    if (!isBuiltin && !draft.baseUrl.trim()) {
      setEditorError('自定义服务商需要填写 Base URL')
      return
    }
    if (!isBuiltin && !draft.api.trim()) {
      setEditorError('自定义服务商需要选择 API 类型')
      return
    }
    // pi needs the window to decide when to compact and how much it can send; a model without one
    // silently loses auto-compaction (the reserve falls back to a flat 16K tokens).
    const missingWindow = draft.models.find(
      (model) => model.id.trim() && !(Number(model.contextWindow) > 0)
    )
    if (missingWindow) {
      setEditorError(
        `模型 ${missingWindow.id.trim()} 必须填写上下文窗口大小（contextWindow），否则自动压缩与用量显示都会失准`
      )
      return
    }
    const models = draft.models
      .filter((model) => model.id.trim())
      .map((model) => {
        const existing = (model.raw ?? {}) as Record<string, unknown>
        return {
          ...existing,
          id: model.id.trim(),
          name: model.name.trim() || undefined,
          contextWindow: model.contextWindow ? Number(model.contextWindow) : undefined,
          maxTokens: model.maxTokens ? Number(model.maxTokens) : undefined,
          reasoning: model.reasoning || undefined,
          cost: existing.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
      })
    const existingProvider = draft.originalId
      ? parsed.list.find((provider) => provider.id === draft.originalId)?.raw ?? {}
      : {}
    const provider: Record<string, unknown> = {
      ...existingProvider,
      name: draft.name.trim() || undefined,
      baseUrl: draft.baseUrl.trim() || undefined,
      api: draft.api.trim() || undefined,
      apiKey: draft.apiKey.trim() || undefined,
      models
    }
    const nextData = {
      ...(parsed.data ?? {}),
      providers: {
        ...((parsed.data?.providers as Record<string, unknown> | undefined) ?? {})
      }
    }
    if (draft.originalId) delete nextData.providers[draft.originalId]
    nextData.providers[id] = provider
    const nextContent = JSON.stringify(nextData, null, 2)
    setDraft(undefined)
    setEditorError(undefined)
    await applyContent(nextContent)
  }

  const deleteProvider = async (provider: ProviderRow): Promise<void> => {
    if (confirmDelete !== provider.id) {
      setConfirmDelete(provider.id)
      setTimeout(
        () => setConfirmDelete((value) => (value === provider.id ? undefined : value)),
        4000
      )
      return
    }
    setConfirmDelete(undefined)
    const nextData = {
      ...(parsed.data ?? {}),
      providers: {
        ...((parsed.data?.providers as Record<string, unknown> | undefined) ?? {})
      }
    }
    delete nextData.providers[provider.id]
    await applyContent(JSON.stringify(nextData, null, 2))
  }

  const updateDraft = (patch: Partial<ProviderDraft>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const updateModel = (index: number, patch: Partial<ModelDraft>): void => {
    setDraft((current) => {
      if (!current) return current
      const models = current.models.slice()
      models[index] = { ...models[index], ...patch }
      return { ...current, models }
    })
  }

  return (
    <div className="settings-content custom">
      <div className="custom-bar">
        <code className="path">{filePath}</code>
        <div className="mode-switch">
          <button className={mode === 'form' ? 'active' : ''} onClick={() => setMode('form')}>
            表单
          </button>
          <button className={mode === 'json' ? 'active' : ''} onClick={() => setMode('json')}>
            JSON
          </button>
        </div>
        <button className="ghost" onClick={onOpenFile}>
          <ExternalIcon size={12} /> 打开文件
        </button>
        <button className="ghost" onClick={onReload}>
          <RefreshIcon size={12} /> 重新加载
        </button>
        <button
          className="primary"
          disabled={!dirty || saving}
          onClick={() => void onSave(content)}
        >
          保存并重启
        </button>
      </div>

      {mode === 'json' ? (
        <div className="custom-json">
          <textarea
            className="models-editor"
            value={content}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
          {parsed.error && <div className="settings-message error">JSON 解析失败：{parsed.error}</div>}
          <p className="custom-hint">
            适合配置 headers、compat、modelOverrides 等高级字段。保存前会校验 JSON。
          </p>
        </div>
      ) : parsed.error ? (
        <div className="custom-parse-error">
          <p>models.json 当前不是合法 JSON：{parsed.error}</p>
          <button className="ghost" onClick={() => setMode('json')}>
            切到 JSON 修复
          </button>
        </div>
      ) : (
        <div className="custom-form">
          <div className="custom-list-head">
            <div>
              <strong>服务商</strong>
              <span>{parsed.list.length} 个自定义 / 覆盖配置</span>
            </div>
            <button
              className="primary"
              onClick={() =>
                setDraft({
                  id: '',
                  name: '',
                  baseUrl: '',
                  api: 'openai-completions',
                  apiKey: '',
                  models: [emptyModel()]
                })
              }
            >
              <PlusIcon size={12} /> 添加服务商
            </button>
          </div>

          {parsed.list.length === 0 ? (
            <div className="custom-empty">
              <p>还没有自定义服务商</p>
              <span>添加一个 OpenAI 兼容端点，或切换到 JSON 模式粘贴完整配置。</span>
            </div>
          ) : (
            <div className="custom-provider-list">
              {parsed.list.map((provider) => (
                <div className="custom-provider-card" key={provider.id}>
                  <div className="custom-provider-mark">
                    {(provider.name || provider.id).slice(0, 1).toUpperCase()}
                  </div>
                  <div className="custom-provider-main">
                    <div className="custom-provider-name">
                      {provider.name || provider.id}
                      {builtinIds.has(provider.id) && <span className="badge ok">覆盖内置</span>}
                    </div>
                    <div className="custom-provider-sub">
                      <code>{provider.id}</code>
                      <span>{provider.models.length} 个模型</span>
                      {provider.api && <span>{provider.api}</span>}
                    </div>
                    <div className="custom-provider-url">
                      {provider.baseUrl || '未设置 Base URL'}
                    </div>
                  </div>
                  <div className="custom-provider-actions">
                    <button className="ghost" onClick={() => setDraft(toDraft(provider))}>
                      <PencilIcon size={12} /> 编辑
                    </button>
                    <button
                      className={`ghost ${confirmDelete === provider.id ? 'danger' : ''}`}
                      onClick={() => void deleteProvider(provider)}
                    >
                      <TrashIcon size={12} />
                      {confirmDelete === provider.id ? '确认删除' : '删除'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {draft && (
        <div className="login-backdrop">
          <div className="provider-editor">
            <header>
              <div>
                <h3>{draft.originalId ? '编辑服务商' : '添加服务商'}</h3>
                <p>配置 OpenAI 兼容端点或覆盖内置服务商</p>
              </div>
              <button
                className="icon-btn"
                onClick={() => {
                  setDraft(undefined)
                  setEditorError(undefined)
                }}
                title="关闭"
              >
                <CloseIcon size={14} />
              </button>
            </header>

            <div className="provider-editor-body">
              <div className="field-grid two">
                <div className="field">
                  <label>服务商 ID</label>
                  <input
                    value={draft.id}
                    disabled={Boolean(draft.originalId)}
                    placeholder="my-gateway"
                    spellCheck={false}
                    onChange={(event) => updateDraft({ id: event.target.value })}
                  />
                  <p className="field-hint">字母、数字、下划线或短横线；内置 ID 表示覆盖。</p>
                </div>
                <div className="field">
                  <label>显示名称</label>
                  <input
                    value={draft.name}
                    placeholder="My Gateway"
                    onChange={(event) => updateDraft({ name: event.target.value })}
                  />
                </div>
              </div>

              <div className="field">
                <label>Base URL</label>
                <input
                  value={draft.baseUrl}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                />
              </div>

              <div className="field-grid two">
                <div className="field">
                  <label>API 类型</label>
                  <input
                    list="pi-api-types"
                    value={draft.api}
                    placeholder="openai-completions"
                    spellCheck={false}
                    onChange={(event) => updateDraft({ api: event.target.value })}
                  />
                  <datalist id="pi-api-types">
                    {API_TYPES.map((type) => (
                      <option key={type} value={type} />
                    ))}
                  </datalist>
                </div>
                <div className="field">
                  <label>API Key</label>
                  <input
                    value={draft.apiKey}
                    placeholder="$MY_API_KEY 或 sk-..."
                    spellCheck={false}
                    onChange={(event) => updateDraft({ apiKey: event.target.value })}
                  />
                  <p className="field-hint">支持 $ENV 变量、字面量或 !命令。</p>
                </div>
              </div>

              <div className="provider-models">
                <div className="provider-models-head">
                  <div>
                    <strong>模型</strong>
                    <span>{draft.models.filter((model) => model.id.trim()).length} 个</span>
                  </div>
                  <button
                    className="ghost"
                    onClick={() =>
                      setDraft((current) =>
                        current ? { ...current, models: [...current.models, emptyModel()] } : current
                      )
                    }
                  >
                    <PlusIcon size={12} /> 添加模型
                  </button>
                </div>

                <div className="provider-model-rows">
                  {draft.models.map((model, index) => (
                    <div className="provider-model-row" key={index}>
                      <input
                        value={model.id}
                        placeholder="模型 ID"
                        spellCheck={false}
                        onChange={(event) => updateModel(index, { id: event.target.value })}
                      />
                      <input
                        value={model.name}
                        placeholder="显示名称"
                        onChange={(event) => updateModel(index, { name: event.target.value })}
                      />
                      <input
                        type="number"
                        value={model.contextWindow}
                        placeholder="上下文（必填）"
                        title="上下文窗口大小，例如 200000；自动压缩按它的 90% 触发"
                        onChange={(event) =>
                          updateModel(index, { contextWindow: event.target.value })
                        }
                      />
                      <input
                        type="number"
                        value={model.maxTokens}
                        placeholder="最大输出"
                        onChange={(event) => updateModel(index, { maxTokens: event.target.value })}
                      />
                      <label className="model-reasoning">
                        <input
                          type="checkbox"
                          checked={model.reasoning}
                          onChange={(event) =>
                            updateModel(index, { reasoning: event.target.checked })
                          }
                        />
                        推理
                      </label>
                      <button
                        className="icon-btn"
                        title="删除模型"
                        onClick={() =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  models: current.models.filter((_, item) => item !== index)
                                }
                              : current
                          )
                        }
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  ))}
                  {draft.models.length === 0 && (
                    <div className="provider-model-empty">还没有模型，点右上角添加</div>
                  )}
                </div>
              </div>

              {editorError && <div className="settings-message error">{editorError}</div>}
            </div>

            <footer>
              <span className="provider-editor-hint">
                更多字段（headers、compat、cost 等）可切到 JSON 模式编辑
              </span>
              <div className="provider-editor-actions">
                <button className="ghost" onClick={() => setDraft(undefined)}>
                  取消
                </button>
                <button className="primary" onClick={() => void saveDraft()} disabled={saving}>
                  <CheckIcon size={12} /> 保存并应用
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
